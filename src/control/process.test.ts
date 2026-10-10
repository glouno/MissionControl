import { StorageManager } from "./storage.js";
import test from "node:test";
// CI runner disk capacity is unrelated to fixture lifecycle behavior.
test.mock.method(StorageManager.prototype, "pressure", async () => ({
  freeBytes: 100 * 1024 ** 3,
  reserveBytes: 50 * 1024 ** 3,
  admissionAllowed: true,
}));

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { ControlStore } from "./store.js";
import { SqliteStore } from "../sqlite.js";
import { createControlServer } from "./api.js";
import { Scheduler } from "./scheduler.js";
import { ControlClient } from "./client.js";
import { git } from "./workspaces.js";
import { FakeBackend, HumanWait } from "./backends.js";
import { executeClaim } from "./worker.js";
import { OwnerWait } from "./backend.js";
const task = (key: string) => ({
  key,
  title: key,
  description: key,
  acceptanceCriteria: ["File verified"],
  allowedPaths: ["**"],
  verificationCommands: [`test -f ${key}.txt`],
});
test("worker failure with unknown billing never settles an earlier partial checkpoint estimate", async (t) => {
  const f = await fixture({
    maxCostUsd: 10,
    estimatePerRunUsd: 1,
    executionContract: {
      harness: "tool-loop",
      provider: "azure",
      authentication: { kind: "controller", reference: "synthetic" },
      execution: "isolated",
      usagePolicy: { kind: "metered", maxCostUsd: 10, estimatePerRunUsd: 1 },
    },
    backend: {
      kind: "azure",
      model: "synthetic",
      endpoint: "https://example.invalid",
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    },
  });
  const live = await server(f);
  t.after(() => {
    live.s.close();
    f.store.db.close();
  });
  const scheduler = new Scheduler(f.store, f.root, live.url);
  const claim = f.store.claimNextTask("synthetic")!;
  await scheduler.workspaces.prepareGoal(claim.goal);
  await scheduler.workspaces.prepareTask(claim.goal, claim.task);
  await executeClaim(live.client, claim, f.root, {
    run: async (context) => {
      await context.onCheckpoint(
        "Partial inference completed",
        undefined,
        undefined,
        0.05,
      );
      throw Object.assign(Error("Ambiguous provider response"), {
        usage: { kind: "metered", status: "unknown" },
        costUsd: undefined,
      });
    },
  });
  const attempt = f.store.attempts(f.g.id)[0];
  assert.equal(attempt.usage.status, "unknown");
  assert.equal(f.store.canSpend(f.g.id).settledUsd, 0);
  assert.equal(
    f.store.canSpend(f.g.id).unresolvedUsd,
    claim.goal.config.estimatePerRunUsd,
  );
});
async function fixture(budget = {}) {
  const root = await mkdtemp(join(tmpdir(), "mc-process-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-b", "development"]);
  await writeFile(join(repo, "README.md"), "fixture");
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "fixture",
  ]);
  const store = new ControlStore(new SqliteStore(join(root, "db")));
  store.setting("scheduler-limits", {
    workers: 4,
    cpu: 16,
    memoryMiB: 16384,
    providerWorkers: 4,
    repositoryWorkers: 4,
  });
  const g = store.createGoal({
    title: "Processes",
    description: "Parallel tasks",
    repoPath: repo,
    repository: { mode: "local", branch: "development" },
    backend: { kind: "fake" },
    ...budget,
  });
  store.installPlan(g.id, { tasks: [task("a"), task("b")] }, g.revision);
  return { root, repo, store, g: store.getGoal(g.id) };
}
async function server(
  f: Awaited<ReturnType<typeof fixture>>,
  scheduler?: Scheduler,
) {
  const token = "test-process-operator-token-012345";
  const s = createControlServer(f.store, {
    token,
    onResult: scheduler ? (...a) => scheduler.result(...a) : undefined,
  });
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const url = `http://127.0.0.1:${(s.address() as any).port}`;
  return { s, url, client: new ControlClient(url, token) };
}
test("native owner wait checkpoints current source, releases claim, and resumes with owner result", async (t) => {
  const f = await fixture({ maxCostUsd: 10, estimatePerRunUsd: 0.1 });
  const live = await server(f);
  t.after(() => {
    live.s.close();
    f.store.db.close();
  });
  const scheduler = new Scheduler(f.store, f.root, live.url);
  const claim = f.store.claimNextTask("requester")!;
  await scheduler.workspaces.prepareGoal(claim.goal);
  await scheduler.workspaces.prepareTask(claim.goal, claim.task);
  const workspace = scheduler.workspaces.taskPath(claim.task);
  await executeClaim(live.client, claim, f.root, {
    run: async () => {
      await writeFile(join(workspace, "a.txt"), "saved progress");
      throw Object.assign(
        new OwnerWait({
          action: "Test endpoint",
          scope: "development",
          reason: "Integration test",
          idempotencyKey: "endpoint-1",
        }),
        { costUsd: 0.05 },
      );
    },
  });
  const waiting = f.store.getTask(claim.task.id);
  assert.equal(waiting.status, "waiting_human");
  assert.equal(waiting.workerId, null);
  assert.ok(waiting.checkpoint?.commit);
  assert.equal(await git(workspace, ["status", "--porcelain"]), "");
  assert.equal(waiting.checkpoint?.costUsd, 0.05);
  const operation = f.store.operations()[0];
  assert.ok(operation);
  const independent = f.store.claimNextTask("other")!;
  assert.notEqual(independent.task.id, claim.task.id);
  f.store.respondOperation(
    String(operation.id),
    {
      status: "completed",
      explanation: "Provisioned",
      resultArtifact: "artifact://test-endpoint",
    },
    "owner",
  );
  const resumed = f.store.claimNextTask("resumed")!;
  assert.equal(resumed.task.id, claim.task.id);
  assert.match(resumed.task.checkpoint!.summary, /test-endpoint/);
  assert.equal(resumed.task.checkpoint!.commit, waiting.checkpoint!.commit);
  await executeClaim(live.client, resumed, f.root, {
    run: async () => {
      throw Object.assign(new OwnerWait(operation.request), { costUsd: 0.02 });
    },
  });
  const replayed = f.store.getTask(claim.task.id);
  assert.equal(replayed.status, "retry_wait");
  assert.equal(replayed.workerId, null);
  assert.match(replayed.checkpoint!.summary, /test-endpoint/);
  assert.equal(f.store.operations().length, 0);
  assert.equal(
    f.store.db.one<{ n: number }>("SELECT count(*) n FROM control_operations")!
      .n,
    1,
  );
  assert.equal(replayed.attempts, resumed.task.attempts);
});
test("scheduler uses API task lifecycle and completes a goal through durable publication job", async (t) => {
  const f = await fixture();
  const http = await server(f);
  const scheduler = new Scheduler(f.store, f.root, http.url);
  http.s.close();
  await once(http.s, "close");
  const live = await server(f, scheduler);
  (scheduler as any).url = live.url;
  t.after(async () => {
    await scheduler.close();
    live.s.close();
  });
  await scheduler.tick();
  assert.equal(f.store.tasks(f.g.id).filter((t) => t.workerId).length, 2);
  const deadline = Date.now() + 10000;
  while (
    Date.now() < deadline &&
    f.store.getGoal(f.g.id).status !== "completed"
  ) {
    await new Promise((r) => setTimeout(r, 50));
    await scheduler.tick();
  }
  assert.equal(f.store.getGoal(f.g.id).status, "completed");
  assert.ok(f.store.tasks(f.g.id).every((t) => t.status === "accepted"));
  assert.equal(await git(f.repo, ["status", "--porcelain"]), "");
});
test("protected changes request exact-commit approval and resume without asking again", async (t) => {
  const f = await fixture();
  const g = f.store.getGoal(f.g.id);
  g.config.policy.protectedPaths = ["*.txt"];
  f.store.db.exec(
    `UPDATE control_goals SET config='${JSON.stringify(g.config).replaceAll("'", "''")}' WHERE id='${g.id}'`,
  );
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
  });
  const live = await server(f, scheduler);
  t.after(() => live.s.close());
  let c = f.store.claimNextTask("first")!;
  await scheduler.workspaces.prepareTask(c.goal, c.task);
  await executeClaim(live.client, c, f.root);
  assert.equal(f.store.getTask(c.task.id).status, "waiting_human");
  const q = f.store.questions()[0];
  assert.ok(q.request.commit);
  f.store.answer(q.id, "approve", q.revision, "operator");
  c = f.store.claimNextTask("resumed")!;
  await executeClaim(live.client, c, f.root);
  assert.equal(f.store.getTask(c.task.id).status, "accepted");
  assert.equal(f.store.questions().length, 0);
});
test("human blocker, independent work, repair and automatic development merge complete in one goal", async (t) => {
  const f = await fixture();
  const g = f.store.getGoal(f.g.id);
  g.config.policy = {
    ...g.config.policy,
    publish: true,
    autoMerge: true,
    productionDeploymentExcluded: true,
  };
  f.store.db.exec(
    `UPDATE control_goals SET config='${JSON.stringify(g.config).replaceAll("'", "''")}' WHERE id='${g.id}'`,
  );
  const remote = join(f.root, "remote.git");
  await mkdir(remote);
  await git(remote, ["init", "--bare"]);
  await git(f.repo, ["remote", "add", "origin", remote]);
  await git(f.repo, ["push", "origin", "development"]);
  let reviewFailures = 0;
  const fake = new FakeBackend();
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
    backend: () => ({
      run: async (c) => {
        if (
          c.mode === "review" &&
          c.claim.task.key === "a" &&
          reviewFailures++ === 0
        )
          return {
            text: JSON.stringify({
              commit: await git(c.workspace, ["rev-parse", "HEAD"]),
              verdict: "fail",
              findings: [
                {
                  summary: "Fix test coverage",
                  blocking: true,
                  evidence: "a.txt",
                },
              ],
            }),
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
          };
        return fake.run(c);
      },
    }),
    gitHost: {
      publish: async (goal, path, branch) => {
        assert.equal(goal.config.policy.productionDeploymentExcluded, true);
        await git(path, ["push", remote, `${branch}:development`]);
        return { url: "https://example.test/pr/1", merged: true };
      },
    },
  });
  const live = await server(f, scheduler);
  t.after(() => live.s.close());
  let a = f.store.claimNextTask("a")!,
    b = f.store.claimNextTask("b")!;
  await scheduler.workspaces.prepareTask(a.goal, a.task);
  await scheduler.workspaces.prepareTask(b.goal, b.task);
  const ask = {
    run: async () => {
      throw new HumanWait({
        question: "Choose semantics",
        reason: "Product decision",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      });
    },
  };
  await executeClaim(live.client, a, f.root, ask);
  assert.equal(f.store.getTask(a.task.id).status, "waiting_human");
  await executeClaim(live.client, b, f.root);
  assert.equal(f.store.getTask(b.task.id).status, "accepted");
  const q = f.store.questions()[0];
  f.store.answer(q.id, "yes", q.revision, "operator");
  a = f.store.claimNextTask("a-resumed")!;
  await executeClaim(live.client, a, f.root);
  assert.equal(f.store.getTask(a.task.id).status, "retry_wait");
  await new Promise((r) => setTimeout(r, 5));
  f.store.db.exec(
    `UPDATE control_tasks SET retry_at=0 WHERE id='${a.task.id}'`,
  );
  a = f.store.claimNextTask("a-repair")!;
  await executeClaim(live.client, a, f.root);
  assert.equal(f.store.getTask(a.task.id).status, "accepted");
  await scheduler.publish(g.id);
  assert.equal(f.store.getGoal(g.id).status, "completed");
  assert.ok(f.store.getGoal(g.id).result);
  assert.equal(
    await git(remote, ["rev-parse", "development"]),
    await git(scheduler.workspaces.goalPath(g), ["rev-parse", "HEAD"]),
  );
});
test("one-time schedule uses UTC and recurring schedules never overlap", async () => {
  const f = await fixture();
  const future = new Date(Date.now() + 600000).toISOString();
  const g = f.store.createGoal({
    title: "Scheduled",
    description: "Wait",
    repoPath: f.repo,
    repository: { mode: "local", branch: "development" },
    backend: { kind: "fake" },
    scheduledAt: future,
  });
  f.store.installPlan(g.id, { tasks: [task("later")] }, g.revision);
  assert.equal(f.store.claimNextTask("early", { goalId: g.id }), null);
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
  });
  const config = {
    title: "Recurring",
    description: "Recurring goal",
    repoPath: f.repo,
    repository: { mode: "local", branch: "development" },
    backend: { kind: "fake" },
  };
  f.store.db.exec(
    `INSERT INTO control_schedules VALUES('daily','${JSON.stringify(config)}',60000,'UTC',0,NULL)`,
  );
  scheduler.runSchedules();
  const first = f.store.db.one<any>(
    "SELECT last_goal_id FROM control_schedules WHERE id='daily'",
  ).last_goal_id;
  f.store.db.exec("UPDATE control_schedules SET next_at=0 WHERE id='daily'");
  scheduler.runSchedules();
  assert.equal(
    f.store.db.one<any>(
      "SELECT last_goal_id FROM control_schedules WHERE id='daily'",
    ).last_goal_id,
    first,
  );
});
test("cancellation invalidates claims and prevents later integration", async () => {
  const f = await fixture();
  const c = f.store.claimNextTask("worker")!;
  const g = f.store.getGoal(f.g.id);
  f.store.setGoalState(g.id, "cancelled", g.revision, "operator");
  assert.equal(f.store.getTask(c.task.id).status, "cancelled");
  assert.throws(
    () => f.store.heartbeat(c.task.id, c.workerId, c.generation),
    /lease/,
  );
});
test("trusted isolated dispatch uses API lifecycle and independent review without host worker forks", async (t) => {
  const f = await fixture();
  const modes: string[] = [];
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    isolatedBackend: () => ({
      run: async (c) => {
        modes.push(c.mode);
        return new FakeBackend().run(c);
      },
    }),
    isolatedVerifier: async (_claim, source) => ({
      passed: true,
      results: [],
      unchanged: (await git(source, ["status", "--porcelain"])) === "",
    }),
  });
  const live = await server(f, scheduler);
  (scheduler as any).url = live.url;
  t.after(async () => {
    await scheduler.close();
    live.s.close();
  });
  await scheduler.tick();
  assert.equal("active" in scheduler, false);
  const deadline = Date.now() + 10000;
  while (
    Date.now() < deadline &&
    f.store.getGoal(f.g.id).status !== "completed"
  ) {
    await new Promise((r) => setTimeout(r, 25));
    await scheduler.tick();
  }
  assert.equal(f.store.getGoal(f.g.id).status, "completed");
  assert.equal(modes.filter((m) => m === "implement").length, 2);
  assert.equal(modes.filter((m) => m === "review").length, 2);
  assert.equal((scheduler as any).isolated.size, 0);
});

test("controller dispatch cannot claim a task while complete backup drains", async (t) => {
  const f = await fixture();
  t.after(() => f.store.db.close());
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
  });
  scheduler.authorizeControllerWorker("backup-race");
  const before = f.store.tasks(f.g.id).map((task) => ({
    id: task.id,
    status: task.status,
    generation: task.generation,
  }));
  f.store.setting("instance-maintenance", { kind: "backup" });
  assert.equal(await scheduler.claimControllerWorker("backup-race"), null);
  assert.deepEqual(
    f.store.tasks(f.g.id).map((task) => ({
      id: task.id,
      status: task.status,
      generation: task.generation,
    })),
    before,
  );
  f.store.setting("instance-maintenance", false);
  await scheduler.maintenance(async () => {
    assert.equal(await scheduler.claimControllerWorker("backup-race"), null);
    assert.deepEqual(
      f.store.tasks(f.g.id).map((task) => ({
        id: task.id,
        status: task.status,
        generation: task.generation,
      })),
      before,
    );
  });
  assert.ok(await scheduler.claimControllerWorker("backup-race"));
});

test("backup drain lets leased workers finish but snapshot blocks mutations", async (t) => {
  const f = await fixture();
  const live = await server(f);
  t.after(() => {
    live.s.close();
    f.store.db.close();
  });
  const claim = f.store.claimNextTask("draining-worker")!;
  const token = f.store.createToken(
    "draining-worker",
    "worker",
    "draining-worker",
  );
  const worker = new ControlClient(live.url, token);
  f.store.setting("instance-maintenance", {
    kind: "backup",
    phase: "draining",
  });
  await worker.transition(claim, "running");
  assert.equal(f.store.getTask(claim.task.id).status, "running");
  f.store.setting("instance-maintenance", {
    kind: "backup",
    phase: "snapshot",
  });
  await assert.rejects(worker.heartbeat(claim), /Mutations paused/);
  assert.equal(f.store.getTask(claim.task.id).status, "running");
  f.store.setting("instance-maintenance", false);
  await worker.heartbeat(claim);
});

test("maintenance refuses running filesystem work, blocks ticks and recovers after failure", async (t) => {
  const f = await fixture();
  t.after(() => f.store.db.close());
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
  });
  (scheduler as any).ticking = true;
  await assert.rejects(
    scheduler.maintenance(async () => true, 1),
    /still changing/,
  );
  assert.equal((scheduler as any).maintenanceRequested, false);
  (scheduler as any).ticking = false;
  let entered = false;
  await scheduler.maintenance(async () => {
    entered = true;
    await scheduler.tick();
    assert.equal((scheduler as any).ticking, false);
  });
  assert.equal(entered, true);
  await assert.rejects(
    scheduler.maintenance(async () => {
      throw new Error("backup failed");
    }),
    /backup failed/,
  );
  assert.equal((scheduler as any).maintenanceRequested, false);
});

test("real goal dispatch and verification refuse missing isolated execution before native work", async (t) => {
  const f = await fixture();
  t.after(() => f.store.db.close());
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
  });
  const g = f.store.getGoal(f.g.id);
  g.config.backend = { kind: "codex", command: "codex" };
  assert.throws(() => scheduler.backend(g), /isolated runtime/);
  const claim = { goal: g, task: f.store.tasks(g.id)[0] } as any;
  await assert.rejects(scheduler.verify(claim, f.repo), /isolated verifier/);
});
