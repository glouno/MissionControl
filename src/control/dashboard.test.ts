import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { dashboardSnapshot } from "./dashboard.js";
test("dashboard reports blocked readiness and reserved budgets separately without exposing runtime secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-dashboard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new SqliteStore(join(root, "db"));
  t.after(() => db.close());
  const store = new ControlStore(db);
  const config = {
    title: "Synthetic",
    description: "Synthetic",
    repoPath: root,
    backend: { kind: "fake" as const },
    maxCostUsd: 5,
    estimatePerRunUsd: 1,
    repository: { mode: "local" as const, branch: "main" },
    verificationCommands: ["true"],
  };
  const goal = store.createGoal(config);
  store.setProject(
    {
      id: "synthetic",
      name: "Synthetic",
      family: "Synthetic",
      enabled: true,
      config,
    },
    "operator",
  );
  store.reserveOperation(goal.id, "synthetic attempt");
  db.exec(
    `INSERT INTO execution_invocations VALUES('synthetic','task',1,'{"id":"synthetic","taskId":"task","generation":1,"status":"stopped","image":"synthetic","spec":{"goalId":"${goal.id}","cpu":1,"memoryMiB":256,"timeoutMs":1000,"secret":"synthetic-sensitive"},"completion":{"outcome":"verified","commit":"synthetic-commit","secret":"synthetic-sensitive"}}')`,
  );
  const snapshot = dashboardSnapshot(store, () => {
    throw Error("synthetic-sensitive");
  });
  assert.equal(snapshot.projects[0].readiness.admissible, false);
  assert.equal(snapshot.projects[0].readiness.liveQualified, false);
  const budget = snapshot.budgets[goal.id];
  assert.ok("reservedUsd" in budget);
  assert.equal(budget.reservedUsd, 1);
  assert.equal(budget.settledUsd, 0);
  assert.equal(JSON.stringify(snapshot).includes("synthetic-sensitive"), false);
  assert.equal(snapshot.executions[0].cpu, 1);
  assert.equal(dashboardSnapshot(store).projects[0].readiness.admissible, true);
});
test("dashboard history cursor reaches older goals without duplicates or mismatched task budgets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-dashboard-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new SqliteStore(join(root, "db")),
    store = new ControlStore(db);
  t.after(() => db.close());
  db.transaction(() => {
    for (let n = 0; n < 501; n++)
      store.createGoal({
        title: `Synthetic ${n}`,
        description: "Synthetic",
        repoPath: root,
        backend: { kind: "fake" },
      });
  });
  // Terminal history must not hide an old unfinished goal from Today/Work.
  const oldest = store.getGoal(
    db.one<{ id: string }>(
      "SELECT id FROM control_goals ORDER BY created_at,id LIMIT 1",
    )!.id,
  );
  db.exec(
    "UPDATE control_goals SET status='completed' WHERE id!='" + oldest.id + "'",
  );
  const first = dashboardSnapshot(store);
  assert.equal(first.goals.length, 501);
  assert.equal(
    first.goals.some((goal) => goal.id === oldest.id),
    true,
  );
  assert.equal(first.activeTruncated, false);
  assert.ok(first.goalCursor);
  const second = dashboardSnapshot(store, undefined, first.goalCursor!);
  assert.equal(second.goals.length, 1);
  assert.equal(second.goalCursor, null);
  assert.equal(
    first.goals
      .filter((g) => g.status === "completed")
      .some((g) => g.id === second.goals[0].id),
    false,
  );
  assert.ok(second.budgets[second.goals[0].id]);
  assert.throws(
    () => dashboardSnapshot(store, undefined, "wrong-instance-cursor"),
    /cursor/,
  );
});

test("dashboard binds worker leases to their owner and limits persisted execution history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-dashboard-workers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new SqliteStore(join(root, "db")),
    store = new ControlStore(db);
  t.after(() => db.close());
  const goal = store.createGoal({
    title: "Synthetic lease",
    description: "Synthetic",
    repoPath: root,
    backend: { kind: "fake" },
  });
  store.installPlan(
    goal.id,
    {
      tasks: [
        {
          key: "synthetic",
          title: "Synthetic task",
          description: "Synthetic task",
          dependencies: [],
          acceptanceCriteria: ["Recorded synthetic evidence"],
          allowedPaths: ["**"],
          verificationCommands: ["true"],
        },
      ],
    },
    goal.revision,
  );
  const claim = store.claimNextTask("synthetic-worker");
  assert.ok(claim);
  store.registerWorker("idle-worker", ["reviewer"]);
  db.transaction(() => {
    for (let n = 0; n < 251; n++) {
      const record = JSON.stringify({
        id: `session-${n}`,
        taskId: claim.task.id,
        generation: 1,
        status: "stopped",
        image: "synthetic",
        spec: {
          goalId: goal.id,
          cpu: 1,
          memoryMiB: 256,
          timeoutMs: 1000,
          privateCredential: "never expose",
        },
      }).replaceAll("'", "''");
      db.exec(
        `INSERT INTO execution_invocations VALUES('session-${n}','${claim.task.id}',1,'${record}')`,
      );
    }
  });
  const snapshot = dashboardSnapshot(store);
  assert.equal(snapshot.executions.length, 250);
  assert.equal(snapshot.executions[0].id, "session-250");
  assert.equal(
    snapshot.executions.some((session) => session.id === "session-0"),
    false,
  );
  assert.equal(JSON.stringify(snapshot).includes("never expose"), false);
  const owner = snapshot.workers.find(
    (worker) => worker.id === "synthetic-worker",
  )!;
  assert.deepEqual(owner.capabilities, ["developer"]);
  assert.equal(owner.leases.length, 1);
  assert.equal(owner.leases[0].taskId, claim.task.id);
  assert.equal(owner.leases[0].goalId, goal.id);
  assert.equal(owner.leases[0].generation, claim.generation);
  assert.equal(
    snapshot.workers.find((worker) => worker.id === "idle-worker")!.leases
      .length,
    0,
  );
});

test("dashboard reports active truncation and allows bounded active continuation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-dashboard-active-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new SqliteStore(join(root, "db")),
    store = new ControlStore(db);
  t.after(() => db.close());
  db.transaction(() => {
    for (let n = 0; n < 502; n++)
      store.createGoal({
        title: `Synthetic active ${n}`,
        description: "Synthetic",
        repoPath: root,
        backend: { kind: "fake" },
      });
  });
  const first = dashboardSnapshot(store);
  assert.equal(first.activeTruncated, true);
  assert.ok(first.activeCursor);
  const later = dashboardSnapshot(
    store,
    undefined,
    "",
    [],
    first.activeCursor!,
  );
  assert.equal(later.activeCursor, null);
  assert.equal(later.activeTruncated, false);
  assert.equal(later.goals.length, 502);
  assert.throws(
    () => dashboardSnapshot(store, undefined, "", [], "unknown-cursor"),
    /cursor/,
  );
});

test("backlog projection is independent of goals and reports same-project dependency blockers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-backlog-dashboard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new SqliteStore(join(root, "db")),
    store = new ControlStore(db);
  t.after(() => db.close());
  for (const id of ["a", "b"])
    store.setProject(
      {
        id,
        name: id,
        family: "synthetic",
        enabled: true,
        config: {
          title: "Fixture",
          description: "Fixture",
          repoPath: root,
          repository: { mode: "local", branch: "main" },
          verificationCommands: ["true"],
          backend: { kind: "fake" },
        },
      },
      "operator",
    );
  const first = store.addBacklog({
    projectId: "a",
    title: "<img src=x>",
    description: "Synthetic",
    priority: 10,
  });
  const dependent = store.addBacklog({
    projectId: "a",
    title: "Dependent",
    description: "Synthetic",
    dependencies: [first.id],
  });
  store.addBacklog({
    projectId: "b",
    title: "Foreign",
    description: "Synthetic",
  });
  const snapshot = dashboardSnapshot(store);
  assert.equal(snapshot.goals.length, 0);
  assert.equal(snapshot.tasks.length, 0);
  assert.equal(snapshot.backlog.length, 3);
  const projected = snapshot.backlog.find((e) => e.id === dependent.id)!;
  assert.equal(projected.blockedReasons.length, 1);
  assert.equal(projected.dependencyStatus[0].completed, false);
  assert.equal(snapshot.backlog.filter((e) => e.projectId === "a").length, 2);
  assert.equal(store.goals().length, 0);
  assert.equal(store.attempts().length, 0);
});
