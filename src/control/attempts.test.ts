import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, sql } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { usageSchema } from "./usage.js";
import { reconcileRuntime } from "./runtimeRecovery.js";
import { EnvironmentRegistry, DockerEnvironment } from "./environments.js";
import { createHash } from "node:crypto";

test("usage reconciliation preserves unknown attempt evidence, requires scoped artifact and settles exactly once", async (t) => {
  const f = await fixture(t, true);
  const { store, goal, claim } = f;
  const evidence = Buffer.from("Synthetic provider invoice: USD 1.25");
  const path = join(f.root, "invoice.txt");
  await writeFile(path, evidence);
  const artifact = store.artifact(
    goal.id,
    undefined,
    "usage-evidence",
    "invoice.txt",
  );
  const input = {
    costUsd: 1.25,
    status: "reported" as const,
    evidenceArtifactId: artifact,
    explanation: "Matched synthetic request identifiers to invoice",
  };
  const hash = createHash("sha256").update(evidence).digest("hex");
  const attemptId = `${claim.task.id}:${claim.generation}`;
  assert.throws(
    () => store.reconcileUsage(attemptId, input, hash, "operator"),
    /closed unresolved/,
  );
  store.release(
    claim.task.id,
    claim.workerId,
    claim.generation,
    "failed",
    "Ambiguous provider response",
  );
  assert.equal(store.unresolvedUsage().length, 1);
  const { createControlServer } = await import("./api.js"),
    { once } = await import("node:events");
  const token = "synthetic-usage-operator-token",
    server = createControlServer(store, { token, stateRoot: f.root });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/v1/attempts/${encodeURIComponent(attemptId)}/usage-reconciliation`;
  const request = (credential: string, body: any) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  for (const role of ["worker", "connector"] as const)
    assert.equal(
      (await request(store.createToken("restricted", role), input)).status,
      403,
    );
  assert.equal(store.canSpend(goal.id).unresolvedUsd, 1);
  assert.equal(
    (await request(token, { ...input, evidenceArtifactId: "missing" })).status,
    409,
  );
  const foreign = store.createGoal({
    title: "Other",
    description: "Other",
    repoPath: f.root,
  });
  const foreignArtifact = store.artifact(
    foreign.id,
    undefined,
    "usage-evidence",
    "invoice.txt",
  );
  assert.equal(
    (await request(token, { ...input, evidenceArtifactId: foreignArtifact }))
      .status,
    409,
  );
  const first = await request(token, input);
  assert.equal(first.status, 200);
  const record = await first.json();
  assert.equal(record.evidenceSha256, hash);
  assert.deepEqual(await (await request(token, input)).json(), record);
  assert.equal((await request(token, { ...input, costUsd: 0 })).status, 409);
  assert.equal(store.unresolvedUsage().length, 0);
  assert.equal(store.canSpend(goal.id).settledUsd, 1.25); // Actual can exceed reservation; never clamp evidence.
  const attempt = store.attempts(goal.id)[0];
  assert.equal(attempt.usage.status, "unknown");
  assert.equal(attempt.usageReconciliation.costUsd, 1.25);
  assert.equal(
    store.events(0, goal.id).filter((e: any) => e.type === "USAGE_RECONCILED")
      .length,
    1,
  );
  assert.throws(
    () => store.db.exec("UPDATE usage_reconciliations SET record='{}'"),
    /immutable/,
  );
  store.settleOperation(attemptId, 0);
  assert.equal(store.canSpend(goal.id).settledUsd, 1.25);
});
async function fixture(t: any, metered = false, clock = Date.now) {
  const root = await mkdtemp(join(tmpdir(), "mc-attempt-")),
    db = new SqliteStore(join(root, "db")),
    store = new ControlStore(db, clock);
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const goal = store.createGoal({
    title: "Synthetic",
    description: "Synthetic",
    repoPath: root,
    maxCostUsd: 10,
    estimatePerRunUsd: 1,
    ...(metered
      ? {
          executionContract: {
            harness: "tool-loop",
            provider: "azure",
            authentication: { kind: "controller", reference: "synthetic" },
            execution: "isolated",
            usagePolicy: {
              kind: "metered",
              maxCostUsd: 10,
              estimatePerRunUsd: 1,
            },
          },
        }
      : {}),
    backend: metered
      ? {
          kind: "azure",
          model: "synthetic",
          endpoint: "https://example.invalid",
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 1,
        }
      : { kind: "fake" },
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
          acceptanceCriteria: ["recorded evidence"],
        },
      ],
    },
    goal.revision,
  );
  const claim = store.claimNextTask("worker", { goalId: goal.id })!;
  return { root, db, store, goal, claim };
}
test("attempt admission, checkpoint and reported usage survive closure without rewriting configuration", async (t) => {
  const { db, store, goal, claim } = await fixture(t, true);
  store.transition(claim.task.id, "worker", claim.generation, "running");
  store.checkpoint(claim.task.id, "worker", claim.generation, {
    summary: "Synthetic continuation",
  });
  const usage = {
    kind: "metered" as const,
    status: "reported" as const,
    costUsd: 0.12,
    inputTokens: 40,
  };
  store.transition(claim.task.id, "worker", claim.generation, "verifying", {
    usage,
    executionSessionId: "synthetic-session",
  });
  store.release(
    claim.task.id,
    "worker",
    claim.generation,
    "retry_wait",
    "Checks failed",
    0.12,
  );
  const attempt = store.attempts(goal.id)[0];
  assert.equal(attempt.outcome, "retry_wait");
  assert.ok(attempt.endedAt);
  assert.equal(attempt.executionSessionId, "synthetic-session");
  assert.deepEqual(attempt.usage, usage);
  assert.equal(attempt.checkpoint.summary, "Synthetic continuation");
  assert.equal(store.canSpend(goal.id).settledUsd, 0.12);
  assert.throws(
    () => db.exec("UPDATE control_attempts SET configuration='{}'"),
    /immutable/,
  );
  const snapshot = JSON.stringify(attempt.configuration);
  store.setGoalState(
    goal.id,
    "paused",
    store.getGoal(goal.id).revision,
    "operator",
  );
  assert.equal(
    JSON.stringify(store.attempts(goal.id)[0].configuration),
    snapshot,
  );
});
test("unknown billing preserves reservation without inventing measured zero or a settled estimate", async (t) => {
  const { store, goal, claim } = await fixture(t, true);
  store.transition(claim.task.id, "worker", claim.generation, "running");
  store.transition(claim.task.id, "worker", claim.generation, "verifying", {
    usage: { kind: "metered", status: "unknown", inputTokens: 4 },
  });
  store.release(
    claim.task.id,
    "worker",
    claim.generation,
    "retry_wait",
    "Interrupted",
    0,
  );
  assert.equal(store.canSpend(goal.id).settledUsd, 0);
  assert.equal(store.canSpend(goal.id).unresolvedUsd, 1);
  assert.equal(store.canSpend(goal.id).remaining, 9);
  assert.equal(store.attempts(goal.id)[0].usage.status, "unknown");
});
test("attempt transitions and controller settlement cannot replace metered policy with subscription or synthetic usage", async (t) => {
  const { store, goal, claim } = await fixture(t, true);
  const task = claim.task.id;
  store.transition(task, claim.workerId, claim.generation, "running");
  for (const usage of [
    { kind: "synthetic" as const },
    { kind: "subscription" as const, status: "unknown" as const },
  ]) {
    assert.throws(
      () =>
        store.transition(task, claim.workerId, claim.generation, "verifying", {
          usage,
        }),
      /differs/,
    );
    assert.equal(store.getTask(task).status, "running");
    assert.throws(
      () =>
        store.checkpoint(task, claim.workerId, claim.generation, {
          summary: "invalid receipt",
          usage,
        }),
      /differs/,
    );
    assert.throws(
      () =>
        store.release(
          task,
          claim.workerId,
          claim.generation,
          "failed",
          "invalid receipt",
          undefined,
          usage,
        ),
      /differs/,
    );
    assert.equal(store.attempts(goal.id)[0].outcome, "active");
  }
  const operation = store.reserveOperation(goal.id, "review");
  assert.throws(
    () => store.settleOperation(operation, 0, { kind: "synthetic" }),
    /differs/,
  );
  assert.equal(
    store.attempts(goal.id).find((a) => a.id === operation)!.outcome,
    "active",
  );
  store.settleOperation(operation, undefined, undefined, "failed");
  assert.equal(
    store.unresolvedUsage().some((r: any) => r.attemptId === operation),
    true,
  );
});
test("restart cannot settle a partial running checkpoint as total inference spending", async (t) => {
  const { store, claim, goal } = await fixture(t, true);
  store.transition(claim.task.id, "worker", claim.generation, "running");
  store.checkpoint(claim.task.id, "worker", claim.generation, {
    summary: "Partial",
    costUsd: 0.05,
    usage: { kind: "metered", status: "estimated", costUsd: 0.05 },
  });
  store.fenceStartup();
  store.finishStartupRecovery();
  assert.equal(store.canSpend(goal.id).unresolvedUsd, 1);
  assert.equal(store.attempts(goal.id)[0].usage.status, "unknown");
});
test("operation attempts close transactionally and unresolved spending stays counted", async (t) => {
  const { store, goal } = await fixture(t, true),
    id = store.reserveOperation(goal.id, "review");
  store.settleOperation(id, undefined, undefined, "failed");
  store.settleOperation(id, 0); // A repeated completion cannot turn uncertainty into free inference.
  const attempt = store.attempts(goal.id).find((a) => a.id === id)!;
  assert.equal(attempt.operation, "review");
  assert.equal(attempt.outcome, "failed");
  assert.equal(attempt.usage.status, "unknown");
  assert.equal(store.canSpend(goal.id).unresolvedUsd, 1);
});
test("attempt pages show newest activity first and reject foreign cursors", async (t) => {
  let now = 1700000000000;
  const { store, goal } = await fixture(t, true, () => now);
  // Distinguish the fixture task, older operation and latest operation explicitly.
  // Wall-clock millisecond ties otherwise make random attempt IDs decide order.
  now += 1000;
  const old = store.reserveOperation(goal.id, "older");
  store.settleOperation(old, 0.01);
  now += 1000;
  const latest = store.reserveOperation(goal.id, "latest");
  const first = store.attempts(goal.id, 1);
  assert.equal(first[0].id, latest);
  const page = store.attempts(goal.id, 1, first[0].id);
  assert.equal(page[0].id, old);
  assert.throws(() => store.attempts(goal.id, 1, "unknown"), /cursor/);
});
test("startup fences authority before cleanup and creates one persistent recovery decision", async (t) => {
  const { store, goal, claim, db, root } = await fixture(t, true),
    token = store.createToken("worker", "worker", "worker");
  store.checkpoint(claim.task.id, "worker", claim.generation, {
    summary: "Synthetic state",
    pendingTool: {
      id: "tool",
      name: "shell",
      arguments: { command: "synthetic" },
    },
  });
  const calls: string[] = [];
  const registry = {
    all: () => [{ id: "synthetic-session", status: "active" }],
  } as any;
  const environment = {
    reset: async () => {
      assert.throws(() =>
        store.assertLease(claim.task.id, "worker", claim.generation),
      );
      assert.equal(
        db.query("SELECT * FROM control_tokens WHERE role='worker'").length,
        0,
      );
      calls.push("stop");
    },
  } as any;
  const networks = {
    records: () => [{ sessionId: "synthetic-session" }],
    reconcile: async () => {
      calls.push("network");
    },
  } as any;
  await reconcileRuntime(store, registry, environment, networks, () =>
    calls.push("revoke"),
  );
  assert.ok(calls.indexOf("revoke") < calls.indexOf("stop"));
  assert.equal(store.getTask(claim.task.id).status, "waiting_human");
  assert.equal(store.attempts(goal.id)[0].outcome, "interrupted");
  assert.equal(store.canSpend(goal.id).unresolvedUsd, 1);
  await reconcileRuntime(store, registry, environment, networks, () => {});
  assert.equal(store.questions().length, 1);
  const question = store.questions()[0];
  store.answer(question.id, "defer", question.revision, "operator");
  assert.equal(store.question(question.id).status, "pending");
  store.answer(question.id, "inspect", question.revision, "operator");
  assert.equal(store.getTask(claim.task.id).checkpoint?.pendingTool, undefined);
  assert.equal(db.integrityCheck()[0], "ok");
});
test("cleanup failure retains fenced claims and resumes the same recovery intent on restart", async (t) => {
  const { store, claim, goal } = await fixture(t, true);
  const registry = {
    all: () => [{ id: "synthetic", status: "active" }],
  } as any;
  const networks = { records: () => [], reconcile: async () => {} } as any;
  await assert.rejects(
    reconcileRuntime(
      store,
      registry,
      {
        reset: async () => {
          throw Error("daemon unavailable");
        },
      } as any,
      networks,
      () => {},
    ),
    /daemon/,
  );
  assert.equal(store.getTask(claim.task.id).workerId, "worker");
  assert.throws(() =>
    store.assertLease(claim.task.id, "worker", claim.generation),
  );
  assert.equal(store.attempts(goal.id)[0].outcome, "recovering");
  assert.equal(store.setting("startup-recovery-fault").status, "blocked");
  await reconcileRuntime(
    store,
    registry,
    { reset: async () => {} } as any,
    networks,
    () => {},
  );
  assert.equal(store.questions().length, 1);
  assert.equal(store.setting("startup-recovery-fault"), null);
});
test("missing Docker container preserves source record but daemon and ownership errors prevent cleanup", async (t) => {
  const { db, root } = await fixture(t),
    registry = new EnvironmentRegistry(join(root, "sandbox"), db);
  const record: any = {
    id: "synthetic",
    taskId: "task",
    generation: 1,
    path: join(root, "sandbox/execution/synthetic/repo"),
    baseSha: "a".repeat(40),
    image: "synthetic",
    container: "mc-synthetic",
    status: "active",
    createdAt: 1,
    lastActivityAt: 1,
    spec: {},
  };
  registry.save(record);
  const calls: string[][] = [];
  const missing = new DockerEnvironment(registry, async (args) => {
    calls.push(args);
    throw Object.assign(Error("missing"), {
      stderr: "Error: No such container: mc-synthetic",
    });
  });
  await missing.reset(record.id);
  assert.equal(registry.get(record.id).container, undefined);
  assert.equal(registry.get(record.id).path, record.path);
  assert.equal(calls.length, 1);
  registry.save(record);
  await assert.rejects(
    new DockerEnvironment(registry, async () => {
      throw Object.assign(Error("offline"), {
        stderr: "Cannot connect to Docker daemon",
      });
    }).reset(record.id),
    /offline/,
  );
  await assert.rejects(
    new DockerEnvironment(registry, async () => ({
      stdout: JSON.stringify([
        { Config: { Labels: {} }, State: { Running: true } },
      ]),
      stderr: "",
    })).reset(record.id),
    /ownership/,
  );
  assert.equal(registry.get(record.id).container, record.container);
});
test("usage contract rejects fabricated subscription dollars and ambiguous metered amounts", () => {
  assert.throws(() =>
    usageSchema.parse({ kind: "subscription", status: "reported", costUsd: 0 }),
  );
  assert.throws(() =>
    usageSchema.parse({ kind: "metered", status: "unknown", costUsd: 0 }),
  );
  assert.throws(() =>
    usageSchema.parse({ kind: "metered", status: "reported" }),
  );
  assert.equal(
    usageSchema.parse({ kind: "subscription", status: "unknown" }).kind,
    "subscription",
  );
});
test("execution contracts reject host fallback, mismatched harness and subscription dollar policy", async () => {
  const { executionContractSchema, validateBackendContract, contractHash } =
    await import("./executionContract.js");
  const metered = {
    harness: "tool-loop",
    provider: "azure",
    authentication: { kind: "controller", reference: "synthetic" },
    execution: "isolated",
    usagePolicy: { kind: "metered", maxCostUsd: 5, estimatePerRunUsd: 1 },
  };
  assert.throws(() =>
    executionContractSchema.parse({ ...metered, execution: "fake" }),
  );
  assert.throws(() =>
    executionContractSchema.parse({
      ...metered,
      provider: "codex-subscription",
    }),
  );
  const subscription = executionContractSchema.parse({
    harness: "codex",
    provider: "codex-subscription",
    authentication: { kind: "session", reference: "dedicated" },
    execution: "isolated",
    usagePolicy: {
      kind: "subscription",
      maxAttempts: 3,
      timeoutMs: 60000,
      maxConcurrency: 1,
    },
  });
  assert.equal(
    validateBackendContract({ kind: "codex", command: "codex" }, subscription)
      .provider,
    "codex-subscription",
  );
  assert.throws(
    () =>
      validateBackendContract(
        { kind: "claude-code", command: "claude", maxTurns: 3 },
        subscription,
      ),
    /differ/,
  );
  assert.equal(contractHash(subscription).length, 64);
});

test("attempt API is an authenticated operator read and excludes connector/worker scope", async (t) => {
  const { store, goal } = await fixture(t);
  const { createControlServer, openApi } = await import("./api.js"),
    { once } = await import("node:events");
  const token = "synthetic-attempt-api-operator-token",
    server = createControlServer(store, { token });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/goals/${goal.id}/attempts`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as any[]).length, 1);
  for (const [role, workerId] of [
    ["worker", "worker"],
    ["connector", undefined],
  ] as const) {
    const restricted = store.createToken("synthetic", role, workerId);
    assert.equal(
      (await fetch(url, { headers: { Authorization: `Bearer ${restricted}` } }))
        .status,
      403,
    );
  }
  assert.ok(
    (openApi().paths["/api/v1/goals/{id}/attempts"] as { get?: unknown }).get,
  );
});
