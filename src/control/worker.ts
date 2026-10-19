import { withExecutionDeadline } from "./executionDeadline.js";
import { classifyFailure, abortable, boundedCleanup } from "./reliability.js";
import { executionUsage, knownCost, type Usage } from "./usage.js";
import { ControlClient } from "./client.js";
import { OwnerWait } from "./backend.js";
import { createBackend, HumanWait, type AgentBackend } from "./backends.js";
import { ProviderUnavailable } from "./providers.js";
import { instructionManifest } from "./projectContext.js";
import { WorkspaceManager } from "./workspaces.js";
import type { Claim, Task } from "./schema.js";
export async function executeClaim(
  client: ControlClient,
  claim: Claim,
  stateRoot: string,
  backend: AgentBackend = createBackend(claim.goal.config.backend),
  externalSignal?: AbortSignal,
  ownedWorkspaces?: WorkspaceManager,
) {
  const workspaces = ownedWorkspaces ?? new WorkspaceManager(stateRoot);
  const workspace = workspaces.taskPath(claim.task);
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("Worker shutdown requested"));
  const externalAbort = () => abort.abort(externalSignal?.reason);
  if (externalSignal) {
    externalSignal.addEventListener("abort", externalAbort, { once: true });
    if (externalSignal.aborted) externalAbort();
  } else {
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  const timeout = setTimeout(
    () => abort.abort(new Error("Task timeout")),
    Math.max(
      1,
      (claim.runtime?.deadlineAt ?? Date.now() + claim.goal.config.timeoutMs) -
        Date.now(),
    ),
  );
  const heartbeat = setInterval(() => {
    client.heartbeat(claim).catch((e) => abort.abort(e));
  }, 30000);
  heartbeat.unref();
  let costUsd: number | undefined;
  let admittedUsage: Usage | undefined;
  let resultSubmitted = false;
  const checkpoint = async (
    summary: string,
    messages?: any[],
    pendingTool?: any,
    usage?: number,
  ) => {
    const c = await workspaces.checkpoint(claim.task, summary);
    if (usage !== undefined) costUsd = usage;
    await client.checkpoint(claim, {
      ...c,
      messages,
      pendingTool,
      costUsd,
      usage: admittedUsage,
    });
  };
  try {
    await client.transition(claim, "running");
    const taskContext = await client.request<{
      operatorContext?: unknown;
      observations?: unknown;
      projectContext?: unknown;
      dependencyArtifacts?: unknown;
    }>(`/tasks/${claim.task.id}`);
    const instructions = await instructionManifest(claim.goal, workspace);
    const prompt = [
      `Implement the bounded task: ${claim.task.spec.title}`,
      claim.task.spec.description,
      `Acceptance criteria: ${JSON.stringify(claim.task.spec.acceptanceCriteria)}`,
      `Exact task base: ${claim.workspace?.baseCommit ?? workspaces.taskBase(claim.task)}`,
      `Allowed paths: ${JSON.stringify(claim.task.spec.allowedPaths)}`,
      "Do not push, merge target branches, deploy, or invoke paid external services. Request human input for auth, billing, destructive migrations or policy exceptions.",
      claim.task.checkpoint
        ? `Continuation: ${JSON.stringify(claim.task.checkpoint)}`
        : "",
      `Repository instructions and pinned contracts: ${JSON.stringify(instructions)}`,
      `Related work: ${JSON.stringify(taskContext.projectContext ?? {})}`,
      `Dependency artifacts: ${JSON.stringify(taskContext.dependencyArtifacts ?? [])}`,
      ...(claim.goal.config.admission?.prompts ?? []).map(
        (p) =>
          `Configured instruction ${p.id} (sha256 ${p.hash}):\n${p.content}`,
      ),
      ...(claim.goal.config.admission?.contexts ?? []).map(
        (c) =>
          `Selected private context ${c.path} (sha256 ${c.hash}):\n${c.content}`,
      ),
      `Candidate-bound operator observations (preserve unresolved failures and address them within scope): ${JSON.stringify(taskContext.observations ?? [])}`,
      "Establish the baseline and environment prerequisites before coding. Preserve required checks. Stop unchanged deterministic setup failures; report the first failure and request a bounded environment repair rather than spending more coding retries. Review invariants across related operations and hostile inputs.",
      `Operator context for this goal: ${JSON.stringify(taskContext.operatorContext ?? [])}`,
      "Execution protocol: your responsibility is implementation and required checks. When the candidate is ready, return the implementation summary through the normal result protocol. MissionControl then runs a separate independent reviewer against the exact candidate commit and controls integration. Any task criteria requiring independent review or integration are fulfilled by those controller phases. Do not start subagents or request reviewer infrastructure; do not claim that independent review or integration has occurred. Preserve repository-required checks and report any remaining findings.",
    ].join("\n");
    const result = await withExecutionDeadline(
      claim.runtime?.deadlineAt ?? Date.now() + claim.goal.config.timeoutMs,
      abort.signal,
      async () => {
        let cleanupSignal: AbortSignal | undefined;
        const cleanup = () => (cleanupSignal ??= AbortSignal.timeout(60000));
        const running = backend.run({
          claim,
          workspace,
          mode: "implement",
          prompt,
          signal: abort.signal,
          cleanupSignal: cleanup,
          deadlineAt: claim.runtime?.deadlineAt,
          onProgress: (kind) => {
            void client
              .request(`/tasks/${claim.task.id}/progress`, "POST", {
                workerId: claim.workerId,
                generation: claim.generation,
                kind,
              })
              .catch(() => {});
          },
          onCheckpoint: checkpoint,
          onContinuation: async (summary, messages, pendingTool, usage) => {
            const prior = await client.request<Task>(`/tasks/${claim.task.id}`);
            if (usage !== undefined) costUsd = usage;
            await client.checkpoint(claim, {
              ...prior.checkpoint,
              summary,
              messages,
              pendingTool,
              costUsd,
            });
          },
        });
        try {
          return await abortable(running, abort.signal);
        } catch (error) {
          let terminalError: unknown;
          if (abort.signal.aborted)
            await boundedCleanup(
              async (signal) => {
                const completion = await abortable(
                  running.then(
                    (value) => ({ value }),
                    (failure) => ({ failure }),
                  ),
                  signal,
                );
                if ("failure" in completion) {
                  terminalError = completion.failure;
                  return;
                }
                costUsd = completion.value.costUsd;
                admittedUsage = executionUsage(
                  completion.value,
                  claim.goal.config,
                );
              },
              60000,
              cleanup(),
            );
          if (terminalError) throw terminalError;
          throw error;
        }
      },
    );
    costUsd = result.costUsd;
    admittedUsage = executionUsage(result, claim.goal.config);
    abort.signal.throwIfAborted();
    await checkpoint(result.text);
    const commit = await workspaces.commit(claim.task);
    await client.transition(claim, "verifying", {
      commit,
      usage: admittedUsage,
      costUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      sessionId: result.sessionId,
      executionSessionId: result.executionSessionId,
      environmentDigest: result.environmentDigest,
      costStatus: result.costStatus,
    });
    clearTimeout(timeout);
    resultSubmitted = true;
    await client.result(claim, {
      commit,
      usage: admittedUsage,
      costUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      executionSessionId: result.executionSessionId,
      environmentDigest: result.environmentDigest,
      costStatus: result.costStatus,
    });
  } catch (e) {
    // A partial checkpoint estimate cannot settle a later ambiguous inference.
    // Explicit unknown usage overrides any earlier numeric estimate.
    const failure = e as { usage?: Usage; costUsd?: number };
    if (
      !admittedUsage ||
      failure.usage !== undefined ||
      failure.costUsd !== undefined
    ) {
      try {
        admittedUsage = executionUsage(failure, claim.goal.config);
      } catch {
        admittedUsage = executionUsage({}, claim.goal.config);
      }
    }
    costUsd = knownCost(admittedUsage);
    if (e instanceof HumanWait || e instanceof OwnerWait) {
      const prior = await client.request<Task>(`/tasks/${claim.task.id}`);
      // Isolated adapters have stopped and imported validated progress before
      // throwing. Persist a current source checkpoint even without commentary.
      await checkpoint(
        `${prior.checkpoint?.summary ?? ""}\n${
          e instanceof OwnerWait
            ? `Worker paused for owner operation: ${e.request.action}`
            : "Worker paused for human decision"
        }`,
        prior.checkpoint?.messages,
        prior.checkpoint?.pendingTool,
        costUsd,
      );
      if (e instanceof OwnerWait) await client.operation(claim, e.request);
      else await client.question(claim, e.request);
    } else {
      // Once result processing starts, the controller owns verification/integration.
      // A lost HTTP response is inspected; it never releases or replays uncertain effects.
      if (resultSubmitted) return;
      const failure = classifyFailure(e);
      await client
        .release(
          claim,
          failure.retryable ? "retry_wait" : "blocked",
          failure.message,
          costUsd,
          admittedUsage,
          failure,
        )
        .catch(() => {});
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    clearTimeout(timeout);
    clearInterval(heartbeat);
    externalSignal?.removeEventListener("abort", externalAbort);
  }
}
