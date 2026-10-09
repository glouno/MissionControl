import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, sql } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { goalSchema } from "./schema.js";
import { dashboardSnapshot } from "./dashboard.js";
import { assertSessionAuthority } from "./isolatedRuntime.js";
async function fixture(t: any, maxAttempts = 3, tokens?: number) {
  const root = await mkdtemp(join(tmpdir(), "mc-subscription-accounting-"));
  const db = new SqliteStore(join(root, "db")),
    store = new ControlStore(db);
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  // Disposable synthetic database seeding exercises safeguards beneath the still-closed production gate.
  const goal = store.createGoal({
    title: "Synthetic",
    description: "Synthetic",
    repoPath: root,
    backend: { kind: "fake" },
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
          acceptanceCriteria: ["synthetic"],
        },
      ],
    },
    goal.revision,
  );
  const configure = (id: string) => {
    const original = store.getGoal(id).config;
    const config = goalSchema.parse({
      ...original,
      backend: { kind: "codex" },
      maxCostUsd: 0,
      estimatePerRunUsd: 0,
      maxWorkers: 1,
      maxAttempts,
      timeoutMs: 1000,
      executionContract: {
        harness: "codex",
        provider: "codex-subscription",
        authentication: { kind: "session", reference: "synthetic-identity" },
        execution: "isolated",
        usagePolicy: {
          kind: "subscription",
          maxAttempts,
          timeoutMs: 1000,
          maxConcurrency: 1,
          ...(tokens === undefined ? {} : { maxReportedTokens: tokens }),
        },
      },
    });
    db.exec(
      `UPDATE control_goals SET config=${sql(JSON.stringify(config))} WHERE id=${sql(id)}`,
    );
    return config;
  };
  const config = configure(goal.id);
  return { root, db, store, goal: store.getGoal(goal.id), config, configure };
}
test("subscription capacity uses admitted attempts with no dollar reservations and fences identity across goals", async (t) => {
  const f = await fixture(t),
    { db, store, goal } = f;
  store.setting("subscription-auth-runs", [
    { authId: "synthetic-identity", status: "running" },
  ]);
  assert.equal(store.subscriptionCapacity(goal.id)?.admissionAllowed, false);
  assert.throws(() => store.reserveOperation(goal.id, "plan"), /identity/);
  store.setting("subscription-auth-runs", []);
  const op = store.reserveOperation(goal.id, "plan");
  const projected = dashboardSnapshot(store).budgets[goal.id];
  assert.ok("kind" in projected && projected.kind === "subscription");
  assert.ok(!("reservedUsd" in projected));
  assert.equal(db.one("SELECT id FROM control_budgets"), null);
  assert.equal(
    store.attempts(goal.id)[0].configuration.executionContract.usagePolicy.kind,
    "subscription",
  );
  assert.equal(store.subscriptionCapacity(goal.id)?.activeIdentityWriter, true);
  assert.throws(() => store.reserveOperation(goal.id, "review"), /identity/);
  const other = store.createGoal({
    title: "Another",
    description: "Synthetic",
    repoPath: join(f.root, "other"),
    backend: { kind: "fake" },
  });
  f.configure(other.id);
  assert.throws(() => store.reserveOperation(other.id, "plan"), /identity/);
  assertSessionAuthority(store, {
    taskId: "review",
    generation: 1,
    spec: {
      goalId: goal.id,
      workerId: "scheduler",
      authorityGeneration: 0,
      operationReservationId: op,
    },
  } as any);
  store.settleOperation(op, undefined, {
    kind: "subscription",
    status: "reported",
    inputTokens: 2,
    outputTokens: 1,
    elapsedMs: 10,
  });
  store.settleOperation(op, 999); // Closed attempt is immutable despite a conflicting repeated receipt.
  assert.equal(store.subscriptionCapacity(goal.id)?.reportedTokens, 3);
  assert.equal(store.subscriptionCapacity(goal.id)?.remainingAttempts, 2);
  assert.equal(store.attempts(goal.id)[0].usage.kind, "subscription");
  assert.throws(
    () =>
      assertSessionAuthority(store, {
        taskId: "review",
        generation: 1,
        spec: {
          goalId: goal.id,
          workerId: "scheduler",
          authorityGeneration: 0,
          operationReservationId: op,
        },
      } as any),
    /reservation/,
  );
  const next = store.reserveOperation(other.id, "plan");
  store.settleOperation(next);
});
test("subscription task transitions reserve no dollars, preserve unknown usage and enforce invocation limits", async (t) => {
  const { store, goal, db } = await fixture(t, 1);
  const claim = store.claimNextTask("worker", { goalId: goal.id })!;
  assert.ok(claim);
  assert.equal(db.one("SELECT id FROM control_budgets"), null);
  assert.equal(store.subscriptionCapacity(goal.id)?.attempts, 1);
  store.transition(claim.task.id, "worker", claim.generation, "running");
  store.release(
    claim.task.id,
    "worker",
    claim.generation,
    "waiting_provider",
    "synthetic expiry",
  );
  assert.equal(store.attempts(goal.id)[0].usage.kind, "subscription");
  assert.equal(store.attempts(goal.id)[0].usage.status, "unknown");
  assert.equal(store.subscriptionCapacity(goal.id)?.remainingAttempts, 0);
  assert.throws(() => store.reserveOperation(goal.id, "review"), /attempts/);
});
test("unknown/interrupted subscription usage remains non-dollar and closes token-capped admission", async (t) => {
  const { store, goal, db } = await fixture(t, 3, 100);
  const claim = store.claimNextTask("worker", { goalId: goal.id })!;
  store.transition(claim.task.id, "worker", claim.generation, "running");
  store.checkpoint(claim.task.id, "worker", claim.generation, {
    summary: "Synthetic partial",
    usage: {
      kind: "subscription",
      status: "reported",
      inputTokens: 2,
      outputTokens: 2,
    },
  });
  store.fenceStartup();
  store.finishStartupRecovery();
  const attempt = store.attempts(goal.id)[0];
  assert.equal(attempt.outcome, "interrupted");
  assert.equal(attempt.usage.kind, "subscription");
  assert.equal(attempt.usage.status, "unknown");
  assert.equal(db.one("SELECT id FROM control_budgets"), null);
  assert.equal(store.subscriptionCapacity(goal.id)?.unknownAttempts, 1);
  assert.equal(store.subscriptionCapacity(goal.id)?.admissionAllowed, false);
  assert.throws(() => store.reserveOperation(goal.id, "review"), /usage/);
  assert.equal(store.questions().length, 1);
});
test("controller subscription attempts are fenced and recovered without a budget row; public admission remains disabled", async (t) => {
  const { store, goal, config } = await fixture(t);
  const op = store.reserveOperation(goal.id, "review");
  store.fenceStartup();
  store.finishStartupRecovery();
  const attempt = store.attempts(goal.id).find((a) => a.id === op)!;
  assert.equal(attempt.outcome, "interrupted");
  assert.equal(attempt.usage.kind, "subscription");
  assert.equal(store.getGoal(goal.id).status, "paused");
  assert.equal(store.questions().length, 1);
  assert.throws(
    () => store.createGoal(config),
    (e: any) => e.code === "subscription_unqualified",
  );
});
test("paused subscription ownership resolution retains identity fencing and unknown token usage across restart", async (t) => {
  const { store, goal, db } = await fixture(t, 3, 100);
  const claim = store.claimNextTask("worker")!;
  store.transition(claim.task.id, claim.workerId, claim.generation, "running");
  store.checkpoint(claim.task.id, claim.workerId, claim.generation, {
    summary: "Synthetic partial",
    usage: { kind: "subscription", status: "reported", inputTokens: 2 },
  });
  store.setGoalState(
    goal.id,
    "paused",
    store.getGoal(goal.id).revision,
    "operator",
  );
  const revision = store.getGoal(goal.id).revision;
  store.fenceStartup();
  assert.equal(store.subscriptionCapacity(goal.id)?.activeIdentityWriter, true);
  assert.throws(() => store.reserveOperation(goal.id, "review"), /identity/);
  const q = store.questions()[0];
  store.answer(
    q.id,
    "inspect",
    q.revision,
    "operator",
    "Confirmed synthetic identity writer and execution stopped",
  );
  const restartedDb = new SqliteStore(db.path),
    restarted = new ControlStore(restartedDb);
  t.after(() => restartedDb.close());
  restarted.fenceStartup();
  restarted.finishStartupRecovery();
  restarted.fenceStartup();
  restarted.finishStartupRecovery();
  assert.equal(restarted.getGoal(goal.id).status, "paused");
  assert.equal(restarted.getGoal(goal.id).revision, revision);
  assert.equal(restarted.attempts(goal.id)[0].usage.status, "unknown");
  assert.equal(restarted.attempts(goal.id)[0].checkpoint.usage.inputTokens, 2);
  assert.equal(
    restarted.subscriptionCapacity(goal.id)?.activeIdentityWriter,
    false,
  );
  assert.equal(restarted.subscriptionCapacity(goal.id)?.unknownAttempts, 1);
  assert.equal(
    restarted.subscriptionCapacity(goal.id)?.admissionAllowed,
    false,
  );
  assert.equal(db.one("SELECT id FROM control_budgets"), null);
  assert.equal(restarted.claimNextTask("duplicate"), null);
  assert.throws(() => restarted.reserveOperation(goal.id, "review"), /usage/);
});
test("subscription reported token totals stop new invocation admission at the cap", async (t) => {
  const { store, goal } = await fixture(t, 3, 5);
  const first = store.reserveOperation(goal.id, "plan");
  store.settleOperation(first, undefined, {
    kind: "subscription",
    status: "reported",
    inputTokens: 4,
    outputTokens: 1,
  });
  assert.equal(store.subscriptionCapacity(goal.id)?.reportedTokens, 5);
  assert.equal(store.subscriptionCapacity(goal.id)?.admissionAllowed, false);
  assert.throws(() => store.reserveOperation(goal.id, "review"), /usage/);
});

test("completed coding hands its verifying lease to review without admitting another writer", async (t) => {
  const { store, goal } = await fixture(t, 4, 100);
  const claim = store.claimNextTask("worker", { goalId: goal.id })!;
  store.transition(claim.task.id, "worker", claim.generation, "running");
  assert.throws(
    () => store.reserveOperation(goal.id, "review", claim),
    /verifying/,
  );
  store.transition(claim.task.id, "worker", claim.generation, "verifying", {
    executionSessionId: "synthetic-completed-session",
    usage: {
      kind: "subscription",
      status: "reported",
      inputTokens: 2,
      outputTokens: 1,
    },
  });
  assert.throws(() => store.reserveOperation(goal.id, "review"), /identity/);
  assert.throws(
    () =>
      store.reserveOperation(goal.id, "review", { ...claim, generation: 99 }),
    /lease|generation/i,
  );
  store.setting("subscription-auth-runs", [
    { authId: "synthetic-identity", status: "running" },
  ]);
  assert.throws(
    () => store.reserveOperation(goal.id, "review", claim),
    /identity/,
  );
  store.setting("subscription-auth-runs", []);
  const review = store.reserveOperation(goal.id, "review", claim);
  assert.throws(
    () => store.reserveOperation(goal.id, "review", claim),
    /identity/,
  );
  store.settleOperation(review, undefined, {
    kind: "subscription",
    status: "reported",
    inputTokens: 2,
    outputTokens: 1,
  });
  assert.equal(store.subscriptionCapacity(goal.id)?.attempts, 2);
  assert.equal(store.subscriptionCapacity(goal.id)?.reportedTokens, 6);
  assert.equal(
    store.attempts(goal.id).find((a) => a.taskId === claim.task.id)?.outcome,
    "active",
  );
});
