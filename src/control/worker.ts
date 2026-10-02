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
    claim.goal.config.timeoutMs,
  );
  const heartbeat = setInterval(() => {
    client.heartbeat(claim).catch((e) => abort.abort(e));
  }, 30000);
  heartbeat.unref();
  let costUsd: number | undefined;
  let admittedUsage: Usage | undefined;
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
      `Operator context for this goal: ${JSON.stringify(taskContext.operatorContext ?? [])}`,
    ].join("\n");
    const result = await backend.run({
      claim,
      workspace,
      mode: "implement",
      prompt,
      signal: abort.signal,
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
    costUsd = result.costUsd;
    admittedUsage = executionUsage(result, claim.goal.config);
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
    try {
      admittedUsage = executionUsage(failure, claim.goal.config);
    } catch {
      admittedUsage = executionUsage({}, claim.goal.config);
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
      const reason = (e as Error).message;
      const waiting =
        e instanceof ProviderUnavailable ||
        /usage.limit|insufficient.quota|rate.limit/i.test(reason);
      await client
        .release(
          claim,
          waiting ? "waiting_provider" : "retry_wait",
          reason,
          costUsd,
          admittedUsage,
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
