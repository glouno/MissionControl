import { join } from "node:path";
import { createHash } from "node:crypto";
import { realpath, lstat } from "node:fs/promises";
import { ControlStore } from "./store.js";
import { git, WorkspaceManager, PublicationConflict } from "./workspaces.js";
import { ControlError, type Goal } from "./schema.js";
import type { AgentBackend, RunContext } from "./backend.js";
import { HumanWait, OwnerWait } from "./backend.js";
import { parseWorktrees } from "./repositories.js";

// The conflicted source and accepted task commits stay intact. Repair operates on
// a separate controller-owned merge checkpoint containing both exact parents.
export async function repairPublication(
  store: ControlStore,
  workspaces: WorkspaceManager,
  goal: Goal,
  conflict: PublicationConflict,
  context: RunContext,
  run: (context: RunContext) => ReturnType<AgentBackend["run"]>,
  namespace = "publication",
) {
  const { goalSha, targetSha } = conflict.candidate;
  const key = `${namespace}-repair:${goal.id}:${goalSha}:${targetSha}`;
  let record = store.setting(key);
  const repository = workspaces.repositories.record(goal.id)!.repositoryPath;
  const digest = createHash("sha256")
    .update(`${goalSha}:${targetSha}`)
    .digest("hex")
    .slice(0, 24);
  const path = join(workspaces.root, "goals", goal.id, `repair-${digest}`);
  const id = `${goal.id}_repair_${digest}`;
  const attemptsKey = `${namespace}-repair-attempts:${goal.id}`;
  const register = async () =>
    workspaces.storage.register({
      id,
      goalId: goal.id,
      kind: "repair-candidate",
      path,
      baseSha: goalSha,
      headSha: await git(path, ["rev-parse", "HEAD"]),
      generation: 0,
      status: "checkpointed",
      unfinished: true,
      lastActivityAt: store.clock(),
    });
  if (!record) {
    const conflicts = (
      await git(conflict.candidate.path, [
        "diff",
        "--name-only",
        "--diff-filter=U",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean);
    if (
      !conflicts.length ||
      conflicts.length > 40 ||
      conflicts.some((p) => /[\n\r*?\[\]{}]/.test(p))
    )
      throw new ControlError(
        "repair_scope",
        "Conflict requires owner inspection of unsupported paths",
        409,
      );
    record = { path, goalSha, targetSha, conflicts, status: "preparing" };
    store.setting(key, record); // Intent precedes external Git worktree actions.
  }
  if (record.status === "preparing") {
    const exists = parseWorktrees(
      await git(repository, ["worktree", "list", "--porcelain", "-z"]),
    ).some((w) => w.path === path);
    if (!exists)
      await git(repository, ["worktree", "add", "--detach", path, goalSha]);
    await register();
    if ((await realpath(path)) !== path || (await lstat(path)).isSymbolicLink())
      throw new ControlError(
        "repair_lineage",
        "Repair source path was redirected",
        409,
      );
    const head = await git(path, ["rev-parse", "HEAD"]);
    if (head === goalSha) {
      if (
        !(await git(path, ["rev-parse", "--verify", "MERGE_HEAD"]).catch(
          () => "",
        ))
      )
        await git(path, [
          "-c",
          "user.name=MissionControl",
          "-c",
          "user.email=missioncontrol@localhost",
          "merge",
          "--no-commit",
          "--no-ff",
          targetSha,
        ]).catch(() => {});
      if ((await git(path, ["rev-parse", "MERGE_HEAD"])) !== targetSha)
        throw new ControlError(
          "repair_lineage",
          "Repair merge parent differs from recorded target",
          409,
        );
      await git(path, ["add", "--all"]);
      await git(path, [
        "-c",
        "user.name=MissionControl",
        "-c",
        "user.email=missioncontrol@localhost",
        "commit",
        "-m",
        "Checkpoint unresolved development merge for scoped repair",
      ]);
    }
    const baseSha = await git(path, ["rev-parse", "HEAD"]);
    const parents = (
      await git(path, ["show", "-s", "--format=%P", baseSha])
    ).split(" ");
    if (
      parents.length !== 2 ||
      !parents.includes(goalSha) ||
      !parents.includes(targetSha)
    )
      throw new ControlError(
        "repair_lineage",
        "Repair checkpoint does not retain both exact parents",
        409,
      );
    record = { ...record, baseSha, status: "ready" };
    store.setting(key, record);
    await register();
  }
  if (
    record.path !== path ||
    record.goalSha !== goalSha ||
    record.targetSha !== targetSha ||
    (await realpath(path)) !== path
  )
    throw new ControlError(
      "repair_lineage",
      "Recorded repair source lineage changed",
      409,
    );
  if (record.status === "completed") {
    if (
      (await git(path, ["rev-parse", "HEAD"])) !== record.commit ||
      (await git(path, ["status", "--porcelain"]))
    )
      throw new ControlError(
        "repair_lineage",
        "Completed repair source changed",
        409,
      );
    return { path, commit: record.commit as string, goalSha, targetSha };
  }
  const attempts = Number(store.setting(attemptsKey) ?? 0);
  if (attempts >= goal.config.maxAttempts)
    throw new ControlError(
      "repair_limit",
      "Publication repair attempts exhausted; source retained for owner",
      409,
    );
  store.setting(attemptsKey, attempts + 1); // Crashes consume a bounded attempt too.
  // A stopped invocation may have imported staged progress before failing. Keep
  // it as a clean checkpoint for the next private sandbox, with the same scope.
  await git(path, ["add", "--all"]);
  const pending = (
    await git(path, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      record.baseSha,
    ])
  )
    .split("\0")
    .filter(Boolean);
  if (pending.some((p) => !record.conflicts.includes(p)))
    throw new ControlError(
      "repair_scope",
      "Interrupted repair exceeded conflict paths",
      409,
    );
  await git(path, ["merge-base", "--is-ancestor", record.baseSha, "HEAD"]);
  if (await git(path, ["diff", "--cached", "--name-only"]))
    await git(path, [
      "-c",
      "user.name=MissionControl",
      "-c",
      "user.email=missioncontrol@localhost",
      "commit",
      "-m",
      "Checkpoint interrupted scoped repair",
    ]);
  store.artifact(
    goal.id,
    undefined,
    `${namespace}-conflict`,
    conflict.candidate.path,
    { ...conflict.candidate, repair: record, attempt: attempts + 1 },
  );
  const claim = structuredClone(context.claim);
  claim.task.spec.allowedPaths = record.conflicts;
  claim.task.spec.title = "Repair development integration conflicts";
  let result;
  try {
    result = await run({
      ...context,
      claim,
      workspace: path,
      mode: "implement",
      disableTaskHandoffs: true,
      prompt: `Resolve ONLY these conflicting paths: ${JSON.stringify(record.conflicts)}. Preserve the goal behavior and current development changes. This is a checkpoint of an unresolved merge of goal ${goalSha} and development ${targetSha}. Do not alter Git ancestry or other files. Remove conflict markers, run relevant local checks, and explain the resolution. Accepted task evidence remains immutable. Goal: ${goal.config.description}\nPrevious verification feedback: ${JSON.stringify(record.feedback ?? null)}`,
    });
  } catch (error) {
    if (error instanceof HumanWait || error instanceof OwnerWait)
      throw new ControlError(
        "repair_handoff",
        "Repair stopped for owner inspection; source retained",
        409,
      );
    throw error;
  }
  await git(path, ["add", "--all"]);
  const changed = (
    await git(path, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      record.baseSha,
    ])
  )
    .split("\0")
    .filter(Boolean);
  if (changed.some((p) => !record.conflicts.includes(p)))
    throw new ControlError(
      "repair_scope",
      "Repair changed paths outside conflicts",
      409,
    );
  await git(path, ["merge-base", "--is-ancestor", record.baseSha, "HEAD"]);
  for (const file of record.conflicts) {
    const content = await git(path, ["show", `:${file}`]).catch(() => "");
    if (/^(<{7}|={7}|>{7}|\|{7})( |$)/m.test(content))
      throw new ControlError(
        "repair_unresolved",
        "Conflict markers remain in repair",
        409,
      );
  }
  if (await git(path, ["diff", "--cached", "--name-only"]))
    await git(path, [
      "-c",
      "user.name=MissionControl",
      "-c",
      "user.email=missioncontrol@localhost",
      "commit",
      "-m",
      "Resolve scoped development integration conflicts",
    ]);
  const commit = await git(path, ["rev-parse", "HEAD"]);
  store.setting(key, { ...record, status: "completed", commit });
  await register();
  store.artifact(goal.id, undefined, `${namespace}-repair`, path, {
    commit,
    goalSha,
    targetSha,
    conflicts: record.conflicts,
    result,
  });
  return { path, commit, goalSha, targetSha };
}

export function retryPublicationRepair(
  store: ControlStore,
  goalId: string,
  candidate: { path: string; goalSha: string; targetSha: string },
  feedback: unknown,
) {
  const key = `publication-repair:${goalId}:${candidate.goalSha}:${candidate.targetSha}`;
  const record = store.setting(key);
  if (record?.path === candidate.path)
    store.setting(key, { ...record, status: "ready", feedback });
}
