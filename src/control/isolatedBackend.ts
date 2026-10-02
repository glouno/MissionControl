import { randomUUID } from "node:crypto";
import type { AgentBackend, RunContext, BackendResult } from "./backend.js";
import { HumanWait, OwnerWait } from "./backend.js";
import { createBackend } from "./backends.js";
import { IsolatedPortableTools } from "./isolatedTools.js";
import type { ModelProvider, ModelMessage, ToolCall } from "./providers.js";
import {
  EnvironmentRegistry,
  importWorkerChanges,
  sanitizeGit,
  type ExecutionEnvironment,
} from "./environments.js";
import { GatewayNetworkManager } from "./gatewayNetwork.js";
import { InferenceGateway } from "./inferenceGateway.js";
import { dockerNativeExecution } from "./nativeExecution.js";
import { git } from "./git.js";
import { ControlError } from "./schema.js";
import { prepareContractSnapshot } from "./contractSnapshots.js";
import { join } from "node:path";
export interface IsolatedBackendOptions {
  imageDigest: string;
  provider: string;
  socketDirectory: string;
  relayScript: string;
  assertLease: (taskId: string, generation: number) => void;
  backend?: AgentBackend;
  portableProvider?: ModelProvider;
  transport?: typeof dockerNativeExecution;
  assertContext?: (context: RunContext) => void;
}
// The orchestrator constructs this adapter. Goal payloads cannot configure gateway
// upstreams, mount paths or host executables. All host actions remain controller-side.
export class IsolatedBackend implements AgentBackend {
  constructor(
    readonly environment: ExecutionEnvironment,
    readonly registry: EnvironmentRegistry,
    readonly networks: GatewayNetworkManager,
    readonly gateway: InferenceGateway,
    readonly options: IsolatedBackendOptions,
  ) {}
  async run(context: RunContext): Promise<BackendResult> {
    const config = context.claim.goal.config.backend;
    const portable = config.kind === "azure" || config.kind === "bedrock";
    if (config.kind !== "codex" && config.kind !== "claude-code" && !portable)
      throw new ControlError(
        "harness_policy",
        "An approved isolated harness is required",
        409,
      );
    if (
      !config.model ||
      context.claim.goal.config.estimatePerRunUsd <= 0 ||
      !/^sha256:[a-f0-9]{64}$/.test(this.options.imageDigest)
    )
      throw new ControlError(
        "environment_policy",
        "Explicit model, positive cost reservation and pinned environment image required",
        409,
      );
    this.options.assertLease(context.claim.task.id, context.claim.generation);
    this.options.assertContext?.(context);
    const generation = Math.max(1, context.claim.generation);
    const assertExecutionLease = (
      taskId: string,
      observedGeneration: number,
    ) => {
      if (taskId !== context.claim.task.id || observedGeneration !== generation)
        throw new ControlError(
          "stale_lease",
          "Execution ownership changed",
          409,
        );
      // Generation zero denotes a controller-reserved goal review, not a task
      // claim. Its injected authority must validate that operation reservation.
      this.options.assertLease(context.claim.task.id, context.claim.generation);
      this.options.assertContext?.(context);
    };
    const startedAt = Date.now();
    const baseSha = await git(context.workspace, ["rev-parse", "HEAD"]);
    if (await git(context.workspace, ["status", "--porcelain"]))
      throw new ControlError(
        "worker_base",
        "Checkpoint trusted source before isolated execution",
        409,
      );
    // Each invocation (including independent review) has private source/home/network.
    // Interrupted source stays recorded for recovery instead of being reused blindly.
    const session = await this.environment.prepare({
      taskId: context.claim.task.id,
      generation,
      invocationId: `${context.mode}_${randomUUID().replaceAll("-", "")}`,
      goalId: context.claim.goal.id,
      workerId: context.claim.workerId,
      authorityGeneration: context.claim.generation,
      operationReservationId: context.operationReservationId,
      source: context.workspace,
      baseSha,
      image: this.options.imageDigest,
      cpu: context.claim.task.spec.cpuUnits,
      memoryMiB: context.claim.task.spec.memoryMiB,
      timeoutMs: context.claim.goal.config.timeoutMs,
    });
    if (session.status !== "prepared")
      throw new ControlError(
        "environment_recovery",
        "Reconcile previous execution source before another invocation",
        409,
      );
    let network:
      Awaited<ReturnType<GatewayNetworkManager["acquire"]>> | undefined;
    let latestSummary: string | undefined;
    let latestMessages: ModelMessage[] | undefined,
      latestPending: ToolCall | undefined;
    let checkpointCost: number | undefined;
    let result: BackendResult | undefined;
    let failure: unknown;
    try {
      const contracts = context.claim.goal.config.siblingContracts.length
        ? await prepareContractSnapshot(
            join(this.registry.root, "contract-snapshots"),
            context.claim.goal.config.siblingContracts,
          )
        : undefined;
      let gatewayEnv: Record<string, string> = {};
      if (!portable) {
        network = await this.networks.acquire({
          sessionId: session.id,
          generation: session.generation,
          imageDigest: this.options.imageDigest,
          socketDirectory: this.options.socketDirectory,
          relayScript: this.options.relayScript,
        });
        const token = this.gateway.issue({
          sessionId: session.id,
          goalId: context.claim.goal.id,
          taskId: session.taskId,
          generation: session.generation,
          provider: this.options.provider,
          protocol: config.kind === "codex" ? "responses" : "messages",
          model: config.model,
          expiresAt: Date.now() + context.claim.goal.config.timeoutMs,
        });
        gatewayEnv =
          config.kind === "codex"
            ? { MISSIONCONTROL_INFERENCE_TOKEN: token }
            : {
                CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
                CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32768",
                CLAUDE_CODE_USE_FOUNDRY: "1",
                ANTHROPIC_FOUNDRY_AUTH_TOKEN: token,
                ANTHROPIC_FOUNDRY_BASE_URL: "http://inference-gateway:8080",
                ANTHROPIC_DEFAULT_OPUS_MODEL: config.model,
                ANTHROPIC_DEFAULT_SONNET_MODEL: config.model,
                ANTHROPIC_DEFAULT_HAIKU_MODEL: config.model,
                CLAUDE_CODE_SUBAGENT_MODEL: config.model,
              };
      }
      this.registry.save({
        ...session,
        spec: {
          ...session.spec,
          gatewayNetwork: network?.network,
          contractSnapshot: contracts
            ? { path: contracts.path, digest: contracts.digest }
            : undefined,
        },
      });
      const active = await this.environment.acquire(session.id, gatewayEnv);
      if (config.kind === "codex") {
        const toml = `model = ${JSON.stringify(config.model)}\nmodel_reasoning_effort = "medium"\nmodel_provider = "missioncontrol"\n[model_providers.missioncontrol]\nname = "MissionControl"\nbase_url = "http://inference-gateway:8080/v1"\nwire_api = "responses"\nenv_key = "MISSIONCONTROL_INFERENCE_TOKEN"\nrequires_openai_auth = false\nsupports_websockets = false\n`;
        // HOME is disposable tmpfs, separate from the source checkout.
        await this.environment.execute(
          session.id,
          [
            "python3",
            "-c",
            `from pathlib import Path\np=Path('/home/worker/.codex');p.mkdir(exist_ok=True);(p/'config.toml').write_text(${JSON.stringify(toml)})`,
          ],
          context.signal,
        );
      }
      const backend =
        this.options.backend ??
        (portable
          ? (() => {
              if (!this.options.portableProvider)
                throw new Error(
                  "Portable execution requires explicit controller-owned provider authentication",
                );
              return new IsolatedPortableTools(
                this.options.portableProvider,
                this.environment,
                session.id,
                () => assertExecutionLease(session.taskId, session.generation),
              );
            })()
          : createBackend(config));
      try {
        result = await backend.run({
          ...context,
          prompt:
            context.prompt +
            (contracts
              ? `\nPinned read-only sibling contracts at /contracts. Snapshot ${contracts.digest}; manifest.json maps numbered siblings to exact revisions. Do not modify these files; request owner coordination for contract changes.`
              : ""),
          ...(portable
            ? {}
            : {
                execution: (this.options.transport ?? dockerNativeExecution)(
                  active,
                  assertExecutionLease,
                ),
              }),
          onCheckpoint: async (summary, messages, pendingTool, cost) => {
            latestSummary = summary;
            checkpointCost = cost;
            if (portable) {
              latestMessages = messages;
              latestPending = pendingTool;
              await context.onContinuation?.(
                summary,
                messages,
                pendingTool,
                cost,
              );
            }
          },
        });
      } catch (error) {
        failure = error;
      }
      // The container is stopped before any trusted Git inspection or source import.
      await this.environment.checkpoint(session.id);
      this.gateway.revoke(session.id);
      assertExecutionLease(session.taskId, session.generation);
      await sanitizeGit(session.path);
      if (context.mode !== "implement") {
        if (
          (await git(session.path, ["status", "--porcelain"])) ||
          (await git(session.path, ["rev-parse", "HEAD"])) !== baseSha
        )
          throw new ControlError(
            "review_mutation",
            "Independent review changed its private source",
            409,
          );
        if (!failure)
          this.registry.save({
            ...this.registry.get(session.id),
            completion: {
              outcome: "verified",
              commit: baseSha,
              recordedAt: Date.now(),
              evidence: { mode: context.mode, result },
            },
          });
      } else if (
        !failure ||
        failure instanceof HumanWait ||
        failure instanceof OwnerWait
      ) {
        await git(session.path, ["add", "--all"]);
        if (await git(session.path, ["diff", "--cached", "--name-only"]))
          await git(session.path, [
            "-c",
            "user.name=MissionControl worker",
            "-c",
            "user.email=worker@localhost",
            "commit",
            "-m",
            "Checkpoint isolated coding task",
          ]);
        await importWorkerChanges(
          this.registry.get(session.id),
          context.workspace,
          context.claim.task.spec.allowedPaths,
          assertExecutionLease,
        );
        this.registry.save({
          ...this.registry.get(session.id),
          completion: {
            outcome: "imported",
            commit: await git(session.path, ["rev-parse", "HEAD"]),
            recordedAt: Date.now(),
            evidence: {
              baseSha,
              trustedPath: context.workspace,
              allowedPaths: context.claim.task.spec.allowedPaths,
            },
          },
        });
      }
      if (latestSummary)
        await context.onCheckpoint(
          latestSummary,
          latestMessages,
          latestPending,
          checkpointCost,
        );
      if (failure) throw failure;
      if (!result) throw new Error("Native harness ended without result");
      return {
        ...result,
        // Responses usage has no dollar price. Reserve the configured estimate
        // rather than treating unavailable provider billing as free inference.
        ...(config.kind === "codex"
          ? {
              costUsd: undefined,
              usage: {
                kind: "metered" as const,
                status: "unknown" as const,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
              },
              costStatus: "estimated_unknown" as const,
            }
          : {
              costStatus: portable
                ? ("estimated_unknown" as const)
                : ("reported" as const),
            }),
        usage:
          config.kind === "codex"
            ? {
                kind: "metered",
                status: "unknown",
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                elapsedMs: Date.now() - startedAt,
              }
            : result.usage
              ? { ...result.usage, elapsedMs: Date.now() - startedAt }
              : {
                  kind: "metered",
                  status:
                    result.costUsd === undefined ? "unknown" : "estimated",
                  costUsd: result.costUsd,
                  elapsedMs: Date.now() - startedAt,
                },
        executionSessionId: session.id,
        environmentDigest: this.options.imageDigest,
      };
    } catch (error) {
      if (config.kind === "codex" && error instanceof Error)
        Object.assign(error, {
          costUsd: undefined,
          usage: { kind: "metered", status: "unknown" },
          costStatus: "estimated_unknown",
        });
      throw error;
    } finally {
      this.gateway.revoke(session.id);
      // No destructive source cleanup: recovery/retention owns these records.
      await this.environment.reset(session.id);
      if (network) await this.networks.stop(session.id);
      const saved = this.registry.get(session.id);
      this.registry.save({
        ...saved,
        status: "checkpointed",
        spec: {
          ...saved.spec,
          gatewayEnv: undefined,
          gatewayNetwork: undefined,
        },
      });
    }
  }
}
