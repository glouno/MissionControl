import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { Scheduler } from "./scheduler.js";
import {
  git,
  PublicationConflict,
  TaskIntegrationConflict,
} from "./workspaces.js";
import { repairPublication } from "./publicationRepair.js";
import { StorageManager } from "./storage.js";
test.mock.method(StorageManager.prototype, "pressure", async () => ({
  freeBytes: 100 * 1024 ** 3,
  reserveBytes: 50 * 1024 ** 3,
  admissionAllowed: true,
}));
async function fixture(t: any, maxAttempts = 2) {
  const root = await mkdtemp(join(tmpdir(), "mc-publication-repair-"));
  const repo = join(root, "repo"),
    remote = join(root, "remote.git");
  await mkdir(repo);
  await mkdir(remote);
  await git(repo, ["init", "-b", "development"]);
  await git(remote, ["init", "--bare"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@localhost"]);
  await writeFile(join(repo, "shared.txt"), "baseline\n");
  await writeFile(join(repo, "untouched.txt"), "untouched\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "baseline"]);
  const initial = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "origin", "development"]);
  const db = new SqliteStore(join(root, "db")),
    store = new ControlStore(db);
  const created = store.createGoal({
    title: "Conflict",
    description: "Retain goal and external lines",
    repoPath: repo,
    repository: {
      mode: "remote",
      remoteUrl: remote,
      primaryBranch: "development",
      auditedPrimarySha: initial,
      verificationEnvironment: "fixture",
    },
    backend: { kind: "fake" },
    maxAttempts,
    verificationCommands: ["test -f shared.txt"],
    policy: {
      publish: true,
      autoMerge: true,
      productionDeploymentExcluded: true,
    },
  });
  store.installPlan(
    created.id,
    {
      tasks: [
        {
          key: "accepted",
          title: "accepted",
          description: "accepted",
          allowedPaths: ["shared.txt"],
          acceptanceCriteria: ["retained"],
        },
      ],
    },
    created.revision,
  );
  // Fixture accepted evidence predates publication and must never be rewritten.
  db.exec(
    `UPDATE control_tasks SET status='accepted',result='{"commit":"immutable-task-evidence"}'`,
  );
  const goal = store.getGoal(created.id);
  const scheduler = new Scheduler(store, join(root, "state"), "unused", {
    spawnWorkers: false,
  });
  const goalPath = await scheduler.workspaces.prepareGoal(goal);
  await writeFile(join(goalPath, "shared.txt"), "goal\n");
  await git(goalPath, ["add", "."]);
  await git(goalPath, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "goal",
  ]);
  await writeFile(join(repo, "shared.txt"), "external\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "external"]);
  await git(repo, ["push", "origin", "development"]);
  let conflict!: PublicationConflict;
  try {
    await scheduler.workspaces.refreshCandidate(goal);
  } catch (e) {
    assert.ok(e instanceof PublicationConflict);
    conflict = e;
  }
  t.after(async () => {
    scheduler.workspaces.repositories.db.close();
    scheduler.workspaces.storage.db.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, repo, remote, store, goal, scheduler, conflict };
}
const output = {
  text: "resolved",
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
};
test("task integration conflict retains unresolved source and independently bounds repair from publication", async (t) => {
  const f = await fixture(t);
  const task = f.store.tasks(f.goal.id)[0];
  const { path: taskPath } = await f.scheduler.workspaces.prepareTask(
    f.goal,
    task,
  );
  await writeFile(join(taskPath, "shared.txt"), "task variant\n");
  await git(taskPath, ["add", "."]);
  await git(taskPath, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "task",
  ]);
  await writeFile(
    join(f.scheduler.workspaces.goalPath(f.goal), "shared.txt"),
    "prerequisite variant\n",
  );
  await git(f.scheduler.workspaces.goalPath(f.goal), ["add", "."]);
  await git(f.scheduler.workspaces.goalPath(f.goal), [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "prerequisite",
  ]);
  let conflict: TaskIntegrationConflict | undefined;
  try {
    await f.scheduler.workspaces.candidate(f.goal, task);
  } catch (error) {
    assert.ok(error instanceof TaskIntegrationConflict);
    conflict = error;
  }
  assert.ok(conflict);
  await assert.rejects(
    f.scheduler.workspaces.candidate(f.goal, task),
    TaskIntegrationConflict,
  );
  const before = await readFile(
    join(conflict.candidate.path, "shared.txt"),
    "utf8",
  );
  assert.match(before, /<<<<<<< /);
  const repaired = await repairPublication(
    f.store,
    f.scheduler.workspaces,
    f.goal,
    conflict,
    {
      claim: f.scheduler.plannerClaim(f.goal),
      workspace: conflict.candidate.path,
      mode: "implement",
      prompt: "",
      signal: new AbortController().signal,
      onCheckpoint: async () => {},
    },
    async (context) => {
      await writeFile(
        join(context.workspace, "shared.txt"),
        "task variant\nprerequisite variant\n",
      );
      return output;
    },
    `task-${task.id}`,
  );
  assert.equal(
    await readFile(join(conflict.candidate.path, "shared.txt"), "utf8"),
    before,
  );
  assert.equal(
    f.store.setting(`task-${task.id}-repair-attempts:${f.goal.id}`),
    1,
  );
  assert.equal(
    f.store.setting(`publication-repair-attempts:${f.goal.id}`),
    undefined,
  );
  await f.scheduler.workspaces.advance(f.goal, repaired);
  assert.equal(
    await readFile(
      join(f.scheduler.workspaces.goalPath(f.goal), "shared.txt"),
      "utf8",
    ),
    "task variant\nprerequisite variant\n",
  );
});
test("publication repair preserves both parents, accepted evidence and immutable conflict source; completion resumes without rerunning", async (t) => {
  const f = await fixture(t);
  let runs = 0;
  const context: any = {
    claim: f.scheduler.plannerClaim(f.goal),
    mode: "implement",
    signal: AbortSignal.timeout(10000),
    onCheckpoint: async () => {},
  };
  const run = async (c: any) => {
    runs++;
    assert.equal(c.disableTaskHandoffs, true);
    assert.deepEqual(c.claim.task.spec.allowedPaths, ["shared.txt"]);
    assert.equal(await git(c.workspace, ["status", "--porcelain"]), "");
    await writeFile(join(c.workspace, "shared.txt"), "goal\nexternal\n");
    return output;
  };
  const result = await repairPublication(
    f.store,
    f.scheduler.workspaces,
    f.goal,
    f.conflict,
    context,
    run,
  );
  await git(result.path, [
    "merge-base",
    "--is-ancestor",
    result.goalSha,
    result.commit,
  ]);
  await git(result.path, [
    "merge-base",
    "--is-ancestor",
    result.targetSha,
    result.commit,
  ]);
  assert.match(
    await readFile(join(f.conflict.candidate.path, "shared.txt"), "utf8"),
    /<<<<<<< /,
  );
  assert.deepEqual(f.store.tasks(f.goal.id)[0].result, {
    commit: "immutable-task-evidence",
  });
  const replay = await repairPublication(
    f.store,
    f.scheduler.workspaces,
    f.goal,
    f.conflict,
    context,
    run,
  );
  assert.equal(replay.commit, result.commit);
  assert.equal(runs, 1);
});
test("repair scope rejects unrelated writes and bounded retries retain unresolved source", async (t) => {
  const f = await fixture(t, 1);
  const context: any = {
    claim: f.scheduler.plannerClaim(f.goal),
    signal: AbortSignal.timeout(10000),
    onCheckpoint: async () => {},
  };
  await assert.rejects(
    repairPublication(
      f.store,
      f.scheduler.workspaces,
      f.goal,
      f.conflict,
      context,
      async () => output,
    ),
    /markers remain/,
  );
  await assert.rejects(
    repairPublication(
      f.store,
      f.scheduler.workspaces,
      f.goal,
      f.conflict,
      context,
      async () => output,
    ),
    /attempts exhausted/,
  );
  const other = await fixture(t);
  await assert.rejects(
    repairPublication(
      other.store,
      other.scheduler.workspaces,
      other.goal,
      other.conflict,
      { ...context, claim: other.scheduler.plannerClaim(other.goal) },
      async (c) => {
        await writeFile(join(c.workspace, "shared.txt"), "goal\nexternal\n");
        await writeFile(join(c.workspace, "untouched.txt"), "outside scope");
        return output;
      },
    ),
    /outside conflicts/,
  );
});
test("scheduler verifies and independently reviews a repaired candidate before publication; rejected checks feed bounded repair", async (t) => {
  const f = await fixture(t);
  let runs = 0,
    reviews = 0,
    published = false,
    failCheck = true;
  f.scheduler.options.backend = () => ({
    run: async (c) => {
      if (c.mode === "implement") {
        runs++;
        assert.equal(c.disableTaskHandoffs, true);
        await writeFile(join(c.workspace, "shared.txt"), "goal\nexternal\n");
        return output;
      }
      reviews++;
      const head = await git(c.workspace, ["rev-parse", "HEAD"]);
      return {
        ...output,
        text: JSON.stringify({ commit: head, verdict: "pass", findings: [] }),
      };
    },
  });
  f.scheduler.options.isolatedVerifier = async () => ({
    passed: !failCheck,
    results: [],
    unchanged: true,
  });
  f.scheduler.options.gitHost = {
    publish: async (_g, path, _branch, expected) => {
      assert.ok(reviews);
      assert.equal(
        await git(path, ["rev-parse", "HEAD"]),
        expected!.candidateSha,
      );
      assert.equal(
        await readFile(join(path, "shared.txt"), "utf8"),
        "goal\nexternal\n",
      );
      published = true;
      return { url: "local://repaired", merged: true };
    },
  };
  await assert.rejects(f.scheduler.publish(f.goal.id), /verification failed/);
  assert.equal(published, false);
  assert.equal(reviews, 0);
  failCheck = false;
  await f.scheduler.publish(f.goal.id);
  assert.equal(published, true);
  assert.equal(runs, 2);
  assert.equal(reviews, 1);
  assert.equal(f.store.getGoal(f.goal.id).status, "completed");
});

test("interrupted staged repair checkpoints before retry and global limit escalates instead of failing the goal", async (t) => {
  const f = await fixture(t, 2);
  const context: any = {
    claim: f.scheduler.plannerClaim(f.goal),
    signal: AbortSignal.timeout(10000),
    onCheckpoint: async () => {},
  };
  await assert.rejects(
    repairPublication(
      f.store,
      f.scheduler.workspaces,
      f.goal,
      f.conflict,
      context,
      async (c) => {
        await writeFile(join(c.workspace, "shared.txt"), "goal\nexternal\n");
        await git(c.workspace, ["add", "shared.txt"]);
        throw new Error("simulated interrupted import");
      },
    ),
    /interrupted import/,
  );
  const repaired = await repairPublication(
    f.store,
    f.scheduler.workspaces,
    f.goal,
    f.conflict,
    context,
    async (c) => {
      assert.equal(await git(c.workspace, ["status", "--porcelain"]), "");
      assert.equal(
        await readFile(join(c.workspace, "shared.txt"), "utf8"),
        "goal\nexternal\n",
      );
      return output;
    },
  );
  assert.ok(repaired.commit);
  const exhausted = await fixture(t, 1);
  exhausted.scheduler.options.backend = () => ({ run: async () => output });
  await assert.rejects(
    exhausted.scheduler.publish(exhausted.goal.id),
    /markers remain/,
  );
  await assert.rejects(
    exhausted.scheduler.publish(exhausted.goal.id),
    /awaits owner inspection/,
  );
  assert.equal(
    exhausted.store.questions().filter((q) => q.goalId === exhausted.goal.id)
      .length,
    1,
  );
  assert.notEqual(exhausted.store.getGoal(exhausted.goal.id).status, "failed");
  assert.equal(exhausted.store.tasks(exhausted.goal.id)[0].status, "accepted");
});

test("blocking integration review retains repair and feeds a fresh bounded invocation", async (t) => {
  const f = await fixture(t);
  let runs = 0,
    reviews = 0,
    publications = 0;
  f.scheduler.options.backend = () => ({
    run: async (c) => {
      if (c.mode === "implement") {
        runs++;
        if (runs > 1) assert.match(c.prompt, /blocking issue/);
        await writeFile(join(c.workspace, "shared.txt"), "goal\nexternal\n");
        return output;
      }
      reviews++;
      return {
        ...output,
        text: JSON.stringify({
          commit: await git(c.workspace, ["rev-parse", "HEAD"]),
          verdict: reviews === 1 ? "fail" : "pass",
          findings:
            reviews === 1
              ? [
                  {
                    summary: "blocking issue",
                    blocking: true,
                    evidence: "fixture review",
                  },
                ]
              : [],
        }),
      };
    },
  });
  f.scheduler.options.isolatedVerifier = async () => ({
    passed: true,
    results: [],
    unchanged: true,
  });
  f.scheduler.options.gitHost = {
    publish: async () => {
      publications++;
      return { url: "local://review-repair", merged: true };
    },
  };
  await assert.rejects(f.scheduler.publish(f.goal.id), /review failed/);
  assert.equal(publications, 0);
  await f.scheduler.publish(f.goal.id);
  assert.equal(runs, 2);
  assert.equal(reviews, 2);
  assert.equal(publications, 1);
});
