import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, sql } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { dashboardSnapshot } from "./dashboard.js";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-interrupted-ownership-"));
  const db = new SqliteStore(join(root, "db"));
  let now = Date.now();
  const store = new ControlStore(db, () => now);
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const goal = store.createGoal({
    title: "Synthetic interruption",
    description: "Synthetic",
    repoPath: root,
    backend: {
      kind: "azure",
      endpoint: "https://synthetic.invalid",
      model: "synthetic",
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    },
    maxCostUsd: 10,
    estimatePerRunUsd: 1,
    executionContract: {
      harness: "tool-loop",
      provider: "azure",
      authentication: { kind: "controller", reference: "synthetic" },
      execution: "isolated",
      usagePolicy: { kind: "metered", maxCostUsd: 10, estimatePerRunUsd: 1 },
    },
  });
  store.installPlan(
    goal.id,
    {
      tasks: [
        {
          key: "one",
          title: "One",
          description: "Synthetic",
          allowedPaths: ["**"],
          acceptanceCriteria: ["Synthetic"],
          resources: ["synthetic-resource"],
        },
      ],
    },
    goal.revision,
  );
  const claim = store.claimNextTask("synthetic-worker")!;
  store.transition(claim.task.id, claim.workerId, claim.generation, "running");
  const checkpoint = {
    summary: "Partial progress",
    commit: "synthetic-commit",
    usage: {
      kind: "metered" as const,
      status: "estimated" as const,
      costUsd: 0.05,
    },
    pendingTool: {
      id: "synthetic-tool",
      name: "shell",
      arguments: { command: "synthetic" },
    },
  };
  store.checkpoint(claim.task.id, claim.workerId, claim.generation, checkpoint);
  store.setGoalState(
    goal.id,
    "paused",
    store.getGoal(goal.id).revision,
    "synthetic-operator",
  );
  return {
    root,
    db,
    store,
    goal: store.getGoal(goal.id),
    claim,
    checkpoint,
    advance: () => {
      now += 121000;
    },
  };
}

test("read-only status distinguishes live and expired ownership without recovering a paused goal", async (t) => {
  const f = await fixture(t);
  assert.equal(dashboardSnapshot(f.store).ownership.tasks[0].authority, "live");
  assert.throws(
    () => f.store.reconcileExpired(f.claim.task.id, f.claim.generation),
    /not expired/,
  );
  f.advance();
  const db = new SqliteStore(f.db.path, { readOnly: true, mustExist: true });
  t.after(() => db.close());
  const readOnly = new ControlStore(db, f.store.clock);
  const snapshot = dashboardSnapshot(readOnly);
  assert.equal(snapshot.ownership.tasks[0].authority, "expired");
  assert.equal(snapshot.ownership.tasks[0].requiresOperator, true);
  assert.equal(snapshot.ownership.tasks[0].resources.length, 1);
  assert.equal(snapshot.workers[0].leases[0].authority, "expired");
  assert.equal(f.store.getGoal(f.goal.id).status, "paused");
  assert.equal(f.store.getTask(f.claim.task.id).status, "running");
  assert.equal(f.store.attempts(f.goal.id)[0].outcome, "active");
  assert.equal(f.store.questions().length, 0);
  assert.equal(f.store.claimNextTask("duplicate"), null);
  assert.throws(() => readOnly.ownership(501), /Limit/);
  assert.throws(() => readOnly.ownership(1, "foreign"), /cursor/);
});

test("expired ownership requires explicit resolution, survives restart and never resumes a paused goal", async (t) => {
  const f = await fixture(t),
    { store, claim, goal, db } = f;
  f.advance();
  assert.throws(
    () => store.reconcileExpired(claim.task.id, claim.generation + 1),
    /not expired/,
  );
  store.reconcileExpired(claim.task.id, claim.generation);
  store.reconcileExpired(claim.task.id, claim.generation);
  assert.equal(store.questions().length, 1);
  assert.equal(store.expired().length, 0);
  assert.equal(store.ownership().tasks[0].authority, "fenced");
  assert.deepEqual(store.getTask(claim.task.id).checkpoint, f.checkpoint);
  assert.equal(store.getTask(claim.task.id).workerId, claim.workerId);
  assert.equal(db.query("SELECT * FROM control_resources").length, 1);
  assert.equal(
    db.one<{ status: string }>("SELECT status FROM control_budgets")!.status,
    "reserved",
  );
  assert.equal(store.attempts(goal.id)[0].usage.status, "unknown");
  assert.throws(
    () => store.heartbeat(claim.task.id, claim.workerId, claim.generation),
    /lease/,
  );
  const restartedDb = new SqliteStore(db.path),
    restarted = new ControlStore(restartedDb, store.clock);
  t.after(() => restartedDb.close());
  const q = restarted.questions()[0];
  restarted.answer(q.id, "defer", q.revision, "operator");
  assert.equal(restarted.question(q.id).status, "pending");
  assert.throws(
    () => restarted.answer(q.id, "inspect", q.revision, "operator"),
    /Explain/,
  );
  assert.equal(restarted.question(q.id).revision, q.revision);
  restarted.answer(
    q.id,
    "inspect",
    q.revision,
    "operator",
    "Confirmed synthetic process and resource stopped; inspected pending tool effects",
  );
  assert.equal(restarted.getGoal(goal.id).status, "paused");
  assert.equal(restarted.getGoal(goal.id).revision, goal.revision);
  assert.equal(restarted.getTask(claim.task.id).status, "pending");
  assert.equal(
    restarted.getTask(claim.task.id).checkpoint?.commit,
    "synthetic-commit",
  );
  assert.equal(
    restarted.getTask(claim.task.id).checkpoint?.pendingTool,
    undefined,
  );
  assert.equal(
    restarted.attempts(goal.id)[0].checkpoint.pendingTool.id,
    "synthetic-tool",
  );
  assert.equal(restarted.attempts(goal.id)[0].outcome, "interrupted");
  assert.equal(restarted.canSpend(goal.id).unresolvedUsd, 1);
  assert.equal(db.query("SELECT * FROM control_resources").length, 0);
  assert.equal(restarted.claimNextTask("duplicate"), null);
  assert.throws(
    () => restarted.answer(q.id, "inspect", q.revision, "operator", "repeat"),
    /changed/,
  );
  restarted.setGoalState(
    goal.id,
    "running",
    restarted.getGoal(goal.id).revision,
    "operator",
  );
  const next = restarted.claimNextTask("new-worker")!;
  assert.equal(next.generation, claim.generation + 1);
  assert.throws(
    () =>
      store.checkpoint(claim.task.id, claim.workerId, claim.generation, {
        summary: "late",
      }),
    /lease/,
  );
  assert.equal(restarted.attempts(goal.id).length, 2);
});

test("recorded execution and gateway resources block operator and startup release", async (t) => {
  const f = await fixture(t),
    { store, db, claim } = f;
  f.advance();
  store.reconcileExpired(claim.task.id, claim.generation);
  const q = store.questions()[0];
  const record = {
    id: "synthetic-session",
    taskId: claim.task.id,
    generation: claim.generation,
    status: "active",
    container: "synthetic-container",
    spec: {},
  };
  db.exec(
    `INSERT INTO sessions VALUES('synthetic-session',${sql(claim.task.id)},${claim.generation},${sql(JSON.stringify(record))}); INSERT INTO gateway_networks VALUES('synthetic-session','{"status":"active"}')`,
  );
  const answer = () =>
    store.answer(
      q.id,
      "inspect",
      q.revision,
      "operator",
      "Inspected synthetic resources",
    );
  assert.throws(answer, /resources/);
  store.fenceStartup();
  assert.throws(() => store.finishStartupRecovery(), /resources/);
  assert.equal(db.query("SELECT * FROM control_resources").length, 1);
  db.exec(
    `UPDATE sessions SET record=${sql(JSON.stringify({ ...record, status: "prepared", container: undefined }))}`,
  );
  assert.throws(answer, /resources/);
  db.exec('UPDATE gateway_networks SET record=\'{"status":"stopped"}\'');
  store.finishStartupRecovery();
  store.fenceStartup();
  store.finishStartupRecovery();
  assert.equal(store.questions().length, 1);
  assert.equal(store.getGoal(f.goal.id).status, "paused");
  assert.equal(store.attempts(f.goal.id)[0].outcome, "interrupted");
  assert.equal(store.canSpend(f.goal.id).unresolvedUsd, 1);
  store.answer(q.id, "inspect", q.revision, "operator");
  assert.equal(store.getTask(claim.task.id).status, "pending");
});

test("startup intent is generation fenced and legacy intent cannot release a newer owner", async (t) => {
  const f = await fixture(t),
    { store, db, claim } = f;
  store.fenceStartup();
  const intent = store.setting("startup-recovery");
  assert.deepEqual(intent.tasks, [
    { taskId: claim.task.id, generation: claim.generation },
  ]);
  db.exec(
    `UPDATE control_tasks SET generation=generation+1 WHERE id=${sql(claim.task.id)}`,
  );
  assert.throws(() => store.finishStartupRecovery(), /generation/);
  assert.throws(() => store.fenceStartup(), /generation/);
  assert.equal(db.query("SELECT * FROM control_resources").length, 1);
  assert.equal(store.attempts(f.goal.id)[0].outcome, "recovering");
  db.exec(
    `UPDATE control_tasks SET generation=${claim.generation} WHERE id=${sql(claim.task.id)}`,
  );
  store.setting("startup-recovery", { tasks: [claim.task.id], operations: [] });
  store.fenceStartup();
  store.finishStartupRecovery();
  assert.equal(store.getGoal(f.goal.id).revision, f.goal.revision);
  assert.equal(store.questions().length, 1);
  assert.equal(db.integrityCheck()[0], "ok");
});

test("operator resolution retires only its startup intent before cleanup finishes and restart stays repeatable", async (t) => {
  const f = await fixture(t),
    { store, claim, goal, db } = f;
  const operation = store.reserveOperation(goal.id, "synthetic-review");
  store.fenceStartup();
  store.fenceStartup();
  assert.equal(store.questions().length, 1);
  assert.equal(store.getGoal(goal.id).revision, goal.revision);
  const q = store.questions()[0];
  store.answer(
    q.id,
    "inspect",
    q.revision,
    "operator",
    "Confirmed synthetic execution and resource stopped",
  );
  assert.deepEqual(store.setting("startup-recovery"), {
    tasks: [],
    operations: [operation],
  });
  const restartedDb = new SqliteStore(db.path),
    restarted = new ControlStore(restartedDb, store.clock);
  t.after(() => restartedDb.close());
  restarted.fenceStartup();
  restarted.finishStartupRecovery();
  restarted.fenceStartup();
  restarted.finishStartupRecovery();
  assert.equal(restarted.getGoal(goal.id).status, "paused");
  assert.equal(restarted.getGoal(goal.id).revision, goal.revision);
  assert.equal(restarted.getTask(claim.task.id).status, "pending");
  assert.equal(restarted.claimNextTask("duplicate"), null);
  assert.equal(restarted.questions().length, 1); // The separate operation still needs inspection.
  assert.equal(
    restarted.attempts(goal.id).filter((a) => a.outcome === "interrupted")
      .length,
    2,
  );
  assert.equal(restarted.canSpend(goal.id).unresolvedUsd, 2);
  restarted.setGoalState(goal.id, "running", goal.revision, "operator");
  const next = restarted.claimNextTask("new-worker")!;
  assert.equal(next.generation, claim.generation + 1);
  // Old intent must reject a newer owner without expiring its live lease.
  restarted.setting("startup-recovery", {
    tasks: [{ taskId: claim.task.id, generation: claim.generation }],
    operations: [],
  });
  assert.throws(() => restarted.fenceStartup(), /generation/);
  restarted.assertLease(next.task.id, next.workerId, next.generation);
  restarted.setting("startup-recovery", {
    tasks: [claim.task.id],
    operations: [],
  });
  assert.throws(() => restarted.fenceStartup(), /Legacy recovery/);
  restarted.assertLease(next.task.id, next.workerId, next.generation);
  assert.equal(
    restarted.attempts(goal.id).find((a) => a.generation === next.generation)!
      .outcome,
    "active",
  );
});

test("startup discovers an orphaned admission without freeing retained ownership on read", async (t) => {
  const f = await fixture(t),
    { store, db, claim, goal } = f;
  db.exec(
    `UPDATE control_tasks SET worker_id=NULL,lease_until=NULL WHERE id=${sql(claim.task.id)}`,
  );
  assert.equal(
    dashboardSnapshot(store).ownership.tasks[0].authority,
    "orphaned",
  );
  assert.equal(db.query("SELECT * FROM control_resources").length, 1);
  assert.equal(store.attempts(goal.id)[0].outcome, "active");
  store.fenceStartup();
  assert.equal(store.ownership().tasks[0].authority, "fenced");
  assert.equal(store.getGoal(goal.id).status, "paused");
  assert.equal(db.query("SELECT * FROM control_resources").length, 1);
  store.finishStartupRecovery();
  assert.equal(store.ownership().tasks[0].authority, "awaiting_operator");
  assert.equal(store.canSpend(goal.id).unresolvedUsd, 1);
  assert.equal(store.claimNextTask("duplicate"), null);
});


test("cancelling expired paused ownership fences it without freeing resources or settling partial usage", async (t) => {
  const f = await fixture(t);
  f.advance();
  f.store.setGoalState(f.goal.id, "cancelled", f.store.getGoal(f.goal.id).revision, "synthetic-operator");
  const task = f.store.getTask(f.claim.task.id);
  assert.equal(task.workerId, f.claim.workerId);
  assert.equal(task.status, "cancelled");
  assert.equal(f.store.ownership().tasks[0].authority, "fenced");
  assert.equal(f.db.one<{ outcome: string }>(`SELECT outcome FROM control_attempts WHERE task_id=${sql(task.id)} AND generation=${task.generation}`)?.outcome, "recovering");
  assert.equal(f.db.query("SELECT * FROM control_resources").length, 1);
  assert.equal(f.store.canSpend(f.goal.id).reservedUsd, 1);
  assert.equal(f.store.canSpend(f.goal.id).settledUsd, 0);
  assert.equal(f.store.claimNextTask("another-worker"), null);
});
