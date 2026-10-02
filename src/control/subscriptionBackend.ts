import { randomUUID } from "node:crypto";
import type { AgentBackend, BackendResult, RunContext } from "./backend.js";
import { HumanWait, OwnerWait } from "./backend.js";
import { AuthRuntime } from "./authRuntime.js";
import {
  EnvironmentRegistry,
  type ExecutionEnvironment,
  importWorkerChanges,
  sanitizeGit,
} from "./environments.js";
import { git } from "./git.js";
import { SubscriptionNativeBackend } from "./subscriptionNative.js";
import {
  executionContractSchema,
  validateBackendContract,
  validateExecutionLimits,
} from "./executionContract.js";
import { executionUsage } from "./usage.js";

/** Dedicated-session feasibility integration; production subscription admission stays disabled. */
export class SubscriptionBackend implements AgentBackend {
  constructor(
    readonly runtime: AuthRuntime,
    readonly environment: ExecutionEnvironment,
    readonly registry: EnvironmentRegistry,
    readonly assertAuthority: (context: RunContext) => void,
    readonly native: AgentBackend = new SubscriptionNativeBackend(),
  ) {}
  async run(context: RunContext): Promise<BackendResult> {
    const config = context.claim.goal.config;
    const contract = executionContractSchema.parse(config.executionContract);
    validateBackendContract(config.backend, contract);
    validateExecutionLimits(config);
    if (
      contract.usagePolicy.kind !== "subscription" ||
      contract.authentication.kind !== "session" ||
      contract.authentication.reference !== this.runtime.config.id ||
      contract.harness !== this.runtime.config.harness
    )
      throw Error(
        "Subscription runtime differs from admitted authentication contract",
      );
    if (config.siblingContracts.length)
      throw Error("Subscription sibling contract snapshots remain unqualified");
    this.assertAuthority(context);
    const baseSha = await git(context.workspace, ["rev-parse", "HEAD"]);
    if (await git(context.workspace, ["status", "--porcelain"]))
      throw Error("Checkpoint trusted source before subscription execution");
    const session = await this.environment.prepare({
      taskId: context.claim.task.id,
      generation: Math.max(1, context.claim.generation),
      invocationId: `${context.mode}_${randomUUID().replaceAll("-", "")}`,
      goalId: context.claim.goal.id,
      workerId: context.claim.workerId,
      authorityGeneration: context.claim.generation,
      operationReservationId: context.operationReservationId,
      source: context.workspace,
      baseSha,
      image: this.runtime.config.imageDigest,
      cpu: context.claim.task.spec.cpuUnits,
      memoryMiB: context.claim.task.spec.memoryMiB,
      timeoutMs: Math.min(config.timeoutMs, contract.usagePolicy.timeoutMs),
    });
    let result: BackendResult | undefined,
      failure: unknown,
      summary: string | undefined;
    try {
      result = await this.runtime.withCoding(
        session,
        () => this.assertAuthority(context),
        context.signal,
        (execution) =>
          this.native.run({
            ...context,
            execution,
            onCheckpoint: async (text) => {
              summary = text;
            },
          }),
      );
      executionUsage(result, config);
    } catch (error) {
      failure = error;
    }
    // withCoding cannot return or propagate a handoff until its owned writer stops.
    const saved = this.registry.get(session.id);
    if (
      saved.container ||
      !["prepared", "checkpointed"].includes(saved.status)
    ) {
      throw Object.assign(
        Error(
          "Subscription teardown unresolved; preserve source and inspect owned resources",
        ),
        { usage: { kind: "subscription", status: "unknown" } },
      );
    }
    this.assertAuthority(context);
    await sanitizeGit(saved.path);
    if (context.mode !== "implement") {
      if (
        (await git(saved.path, ["status", "--porcelain"])) ||
        (await git(saved.path, ["rev-parse", "HEAD"])) !== baseSha
      )
        throw Object.assign(
          Error("Independent subscription review changed its private source"),
          {
            usage: result?.usage ?? { kind: "subscription", status: "unknown" },
          },
        );
      if (!failure)
        this.registry.save({
          ...saved,
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
      await git(saved.path, ["add", "--all"]);
      if (await git(saved.path, ["diff", "--cached", "--name-only"]))
        await git(saved.path, [
          "-c",
          "user.name=MissionControl worker",
          "-c",
          "user.email=worker@localhost",
          "commit",
          "-m",
          "Checkpoint isolated coding task",
        ]);
      await importWorkerChanges(
        saved,
        context.workspace,
        context.claim.task.spec.allowedPaths,
        () => this.assertAuthority(context),
      );
      this.registry.save({
        ...saved,
        completion: {
          outcome: "imported",
          commit: await git(saved.path, ["rev-parse", "HEAD"]),
          recordedAt: Date.now(),
          evidence: {
            baseSha,
            trustedPath: context.workspace,
            allowedPaths: context.claim.task.spec.allowedPaths,
          },
        },
      });
    }
    if (
      summary &&
      (!failure || failure instanceof HumanWait || failure instanceof OwnerWait)
    )
      await context.onCheckpoint(summary);
    if (failure) throw failure;
    if (!result) throw Error("Subscription execution ended without a result");
    return {
      ...result,
      executionSessionId: session.id,
      environmentDigest: session.image,
    };
  }
}
