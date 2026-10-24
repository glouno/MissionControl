import { StorageManager } from "./storage.js";
import test from "node:test";
// Synthetic lifecycle fixtures must not depend on the CI host's physical capacity.
test.mock.method(StorageManager.prototype, "pressure", async () => ({
  freeBytes: 100 * 1024 ** 3,
  reserveBytes: 50 * 1024 ** 3,
  admissionAllowed: true,
}));

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { Scheduler } from "./scheduler.js";
import { FakeBackend } from "./backends.js";
import { git } from "./git.js";
import { ProviderFailure, failureRecord } from "./reliability.js";
async function fixture(t: any, clock = Date.now) {
  const root = await mkdtemp(join(tmpdir(), "mc-scheduler-faults-")),
    db = new SqliteStore(join(root, "state.db")),
    store = new ControlStore(db, clock);
  store.setting("storage-maintenance-at", Date.now());
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  async function goal(
    name: string,
    overrides: {
      timeoutMs?: number;
      planning?: { timeoutMs?: number; maxRequests?: number };
      noProgressWarningMs?: number;
      noProgressTimeoutMs?: number;
    } = {},
  ) {
    const repo = join(root, name);
    await mkdir(repo);
    await git(repo, ["init", "-b", "main"]);
    await writeFile(join(repo, "README.md"), "Synthetic");
    await git(repo, ["add", "."]);
    await git(repo, [
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "-m",
      "Synthetic",
    ]);
    return store.createGoal({
      title: name,
      description: "Synthetic",
      repoPath: repo,
      repository: { mode: "local", branch: "main" },
      policy: { targetBranch: "main" },
      backend: { kind: "fake" },
      timeoutMs: 1000,
      maxCostUsd: 5,
      estimatePerRunUsd: 1,
      ...overrides,
    });
  }
  return { root, db, store, goal };
}
async function until(predicate: () => boolean, limit = 3000) {
  const deadline = Date.now() + limit;
  while (!predicate() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(predicate());
}
test("planning and replanning keep shorter deadlines and actionable exhaustion without accepting partial JSON", async (t) => {
  const f = await fixture(t);
  const goal = await f.goal("bounded-planning", {
    timeoutMs: 3600000,
    planning: { timeoutMs: 600000 },
  });
  const seen: any[] = [];
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    backend: () => ({
      run: async (context) => {
        seen.push(context);
        assert.ok(context.deadlineAt! <= Date.now() + 600000);
        assert.equal(context.mode, "plan");
        assert.ok(context.outputSchema);
        throw Object.assign(
          new ProviderFailure(
            failureRecord("incomplete_stream", {
              providerCode: "max_output_tokens",
            }),
          ),
          { usage: { kind: "metered", status: "unknown" } },
        );
      },
    }),
  });
  t.after(() => scheduler.close());
  await assert.rejects(scheduler.plan(goal.id), /reviewed fixed plan/);
  assert.equal(f.store.tasks(goal.id).length, 0);
  assert.equal(f.store.getGoal(goal.id).planRevision, 0);
  assert.equal(f.store.canSpend(goal.id).unresolvedUsd, 1);
  assert.equal(f.store.getGoal(goal.id).config.timeoutMs, 3600000);
  const g2 = await f.goal("bounded-replan", {
    timeoutMs: 3600000,
    planning: { timeoutMs: 600000 },
  });
  await scheduler.workspaces.prepareGoal(g2);
  await assert.rejects(scheduler.replan(g2.id), /reviewed fixed plan/);
  assert.equal(f.store.tasks(g2.id).length, 0);
  assert.equal(seen.length, 2);
});

test("planning inherits a slow-provider allowance instead of imposing two minutes", async (t) => {
  const f = await fixture(t);
  const goal = await f.goal("slow-planning", { timeoutMs: 600000 });
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    backend: () => ({
      run: async (context) => {
        assert.ok(context.deadlineAt! > Date.now() + 120000);
        assert.ok(context.deadlineAt! <= Date.now() + 600000);
        return new FakeBackend().run(context);
      },
    }),
  });
  t.after(() => scheduler.close());
  await scheduler.plan(goal.id);
  assert.equal(f.store.tasks(goal.id).length, 1);
});

test("stopped controller operations reconcile without restart or replay", async (t) => {
  const f = await fixture(t),
    goal = await f.goal("recovery");
  f.store.installPlan(
    goal.id,
    {
      tasks: [
        {
          key: "one",
          title: "One",
          description: "One",
          allowedPaths: ["**"],
          acceptanceCriteria: ["One"],
        },
      ],
    },
    goal.revision,
  );
  const attemptId = f.store.reserveOperation(goal.id, "review");
  f.db.exec(
    `UPDATE control_attempts SET outcome='recovering' WHERE id='${attemptId}'`,
  );
  f.store.reliability.beginCleanup(attemptId);
  let inspected = 0;
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    asynchronousJobs: true,
    spawnWorkers: false,
    recoverOperation: async (id, signal) => {
      assert.equal(id, attemptId);
      signal.throwIfAborted();
      inspected++;
    },
  });
  t.after(() => scheduler.close());
  await scheduler.tick();
  await until(
    () =>
      f.store.attempts(goal.id).find((a) => a.id === attemptId)!.outcome ===
      "interrupted",
  );
  await scheduler.tick();
  assert.equal(inspected, 1);
});

test("asynchronous planning permits independent repositories and avoids duplicate dispatch", async (t) => {
  const f = await fixture(t),
    slow = await f.goal("slow"),
    fast = await f.goal("fast");
  let started = 0;
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    asynchronousJobs: true,
    spawnWorkers: false,
    backend: (g) => ({
      run: async (c) => {
        if (g.id === slow.id) {
          started++;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 2000);
            c.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(c.signal.reason);
              },
              { once: true },
            );
          });
        }
        return new FakeBackend().run(c);
      },
    }),
  });
  t.after(() => scheduler.close());
  const startedAt = Date.now();
  await scheduler.tick();
  assert.ok(Date.now() - startedAt < 500);
  await scheduler.tick();
  await until(() => f.store.getGoal(fast.id).planRevision === 1);
  await until(() => started === 1);
  assert.equal(started, 1);
  await until(() =>
    f.store.attempts(slow.id).some((a) => a.outcome !== "active"),
  );
  assert.equal(
    f.store.reliability.page("reliability_incidents", slow.id)[0].failure.kind,
    "deadline",
  );
  assert.equal(f.store.getGoal(fast.id).status, "running");
});

test("controller refusal blocks unchanged jobs across restart", async (t) => {
  const f = await fixture(t),
    goal = await f.goal("refused");
  let calls = 0;
  const backend = () => ({
    run: async () => {
      calls++;
      throw new ProviderFailure(failureRecord("policy_refusal"));
    },
  });
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    asynchronousJobs: true,
    spawnWorkers: false,
    backend,
  });
  await scheduler.tick();
  await until(() => f.store.getGoal(goal.id).status === "paused");
  await scheduler.close();
  const restarted = new Scheduler(f.store, f.root, "unused", {
    asynchronousJobs: true,
    spawnWorkers: false,
    backend,
  });
  t.after(() => restarted.close());
  await restarted.tick();
  assert.equal(calls, 1);
  assert.equal(
    f.store.reliability.page("reliability_incidents", goal.id).length,
    1,
  );
});

for (const kind of [
  "incomplete_stream",
  "transport",
  "rate_limit",
  "service",
] as const) {
  test(`controller ${kind} does not allocate fresh inference after failed operation`, async (t) => {
    const f = await fixture(t),
      goal = await f.goal(kind);
    let calls = 0;
    const backend = () => ({
      run: async () => {
        calls++;
        throw new ProviderFailure(failureRecord(kind));
      },
    });
    const scheduler = new Scheduler(f.store, f.root, "unused", {
      asynchronousJobs: true,
      spawnWorkers: false,
      backend,
    });
    await scheduler.tick();
    await until(() => f.store.getGoal(goal.id).status === "paused");
    await scheduler.close();
    // Simulate a due deferred job after restart, without waiting thirty seconds.
    f.db.exec("UPDATE control_jobs SET due_at=0 WHERE status='pending'");
    const restarted = new Scheduler(f.store, f.root, "unused", {
      asynchronousJobs: true,
      spawnWorkers: false,
      backend,
    });
    t.after(() => restarted.close());
    for (let i = 0; i < 3; i++) await restarted.tick();
    assert.equal(calls, 1);
    assert.equal(f.store.attempts(goal.id).length, 1);
    assert.equal(f.store.setting(`pause:${goal.id}`).category, kind);
  });
}

test("progress warnings preserve native provider authority and recovered tools can infer again", async (t) => {
  let now = Date.now();
  const f = await fixture(t, () => now);
  const goal = await f.goal("warning", {
    timeoutMs: 1000000,
    noProgressWarningMs: 1000,
    noProgressTimeoutMs: 5000,
  });
  f.store.installPlan(
    goal.id,
    {
      tasks: [
        {
          key: "one",
          title: "One",
          description: "Synthetic",
          allowedPaths: ["**"],
          acceptanceCriteria: ["Synthetic"],
        },
      ],
    },
    goal.revision,
  );
  const claim = f.store.claimNextTask("worker", { goalId: goal.id })!;
  const attemptId = `${claim.task.id}:${claim.generation}`;
  f.db.exec(
    `UPDATE control_attempts SET execution_session_id='warning-session' WHERE id='${attemptId}'`,
  );
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    asynchronousJobs: true,
    spawnWorkers: false,
  });
  t.after(() => scheduler.close());
  now += 1500;
  await scheduler.tick();
  assert.equal(f.store.reliability.runtime(attemptId)!.failure, undefined);
  assert.ok(f.store.setting(`stall-warning:${attemptId}`));
  f.store.reliability.progress(attemptId, "tool_completed");
  const { InferenceGateway } = await import("./inferenceGateway.js");
  const { once } = await import("node:events");
  let calls = 0;
  const gateway = new InferenceGateway(
    f.db,
    {
      synthetic: {
        protocol: "responses",
        endpoint: "https://example.invalid",
        headers: async () => ({}),
      },
    },
    () => {},
    async () => {
      calls++;
      return new Response(
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  const server = gateway.server();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const token = gateway.issue({
    sessionId: "warning-session",
    goalId: goal.id,
    taskId: claim.task.id,
    generation: claim.generation,
    provider: "synthetic",
    protocol: "responses",
    model: "synthetic",
    expiresAt: Date.now() + 60000,
  });
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}/v1/responses`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "synthetic" }),
    },
  );
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const runtime = f.store.reliability.runtime(attemptId)!;
  runtime.failure = failureRecord("rate_limit", {
    httpStatus: 429,
    retryAfterMs: 120000,
  });
  runtime.nextRetryAt = now + 120000;
  f.store.reliability.saveRuntime(runtime);
  f.store.setting(`stall-warning:${attemptId}`, false);
  now += 1500;
  await scheduler.tick();
  assert.deepEqual(
    f.store.reliability.runtime(attemptId)!.failure,
    JSON.parse(JSON.stringify(runtime.failure)),
  );
  assert.equal(
    f.store.reliability.runtime(attemptId)!.nextRetryAt,
    runtime.nextRetryAt,
  );
});

test("controller cleanup recovery retains measured usage while reserved and settles after stopped evidence", async (t) => {
  const f = await fixture(t);
  const goal = await f.goal("measured-cleanup");
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    backend: () => ({
      run: async () => {
        throw Object.assign(
          new ProviderFailure(failureRecord("cleanup_blocked")),
          {
            costUsd: 0.25,
            usage: {
              kind: "metered",
              status: "estimated",
              costUsd: 0.25,
              inputTokens: 100,
              outputTokens: 10,
            },
          },
        );
      },
    }),
  } as any);
  await assert.rejects(
    (scheduler as any).runBackend(
      goal,
      {
        claim: { goal, task: { id: "planning" }, generation: 0 },
        signal: new AbortController().signal,
        onCheckpoint: async () => {},
      },
      "planning",
    ),
  );
  const attempt = f.store.attempts(goal.id)[0];
  assert.equal(attempt.outcome, "recovering");
  assert.deepEqual(attempt.usage, {
    kind: "metered",
    status: "estimated",
    costUsd: 0.25,
    inputTokens: 100,
    outputTokens: 10,
  });
  assert.equal(f.store.canSpend(goal.id).reservedUsd, 1);
  f.store.fenceStartup();
  f.store.finishStartupRecovery();
  assert.equal(f.store.canSpend(goal.id).settledUsd, 0.25);
  assert.equal(f.store.canSpend(goal.id).unresolvedUsd, 0);
  assert.deepEqual(f.store.attempts(goal.id)[0].usage, attempt.usage);
});

test("cancellation retains eventual cleanup failure and measured controller usage", async (t) => {
  const f = await fixture(t);
  const goal = await f.goal("cancelled-cleanup");
  const controller = new AbortController();
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    backend: () => ({
      run: async () => {
        controller.abort(new Error("cancel"));
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw Object.assign(
          new ProviderFailure(failureRecord("cleanup_blocked")),
          {
            usage: {
              kind: "metered",
              status: "estimated",
              costUsd: 0.25,
              inputTokens: 100,
              outputTokens: 10,
            },
            costUsd: 0.25,
          },
        );
      },
    }),
  } as any);
  await assert.rejects(
    (scheduler as any).runBackend(
      goal,
      {
        claim: { goal, task: { id: "planning" }, generation: 0 },
        signal: controller.signal,
        onCheckpoint: async () => {},
      },
      "planning",
    ),
    (error: any) => error.failure.kind === "cleanup_blocked",
  );
  const attempt = f.store.attempts(goal.id)[0];
  assert.equal(attempt.outcome, "recovering");
  assert.equal(attempt.usage?.costUsd, 0.25);
  assert.equal(f.store.canSpend(goal.id).activeReservedUsd, 1);
});

test("worker cleanup fencing retains explicit final measured usage", async (t) => {
  const f = await fixture(t);
  const goal = await f.goal("worker-cleanup");
  f.store.installPlan(
    goal.id,
    {
      tasks: [
        {
          key: "one",
          title: "one",
          description: "one",
          acceptanceCriteria: ["works"],
          allowedPaths: ["**"],
        },
      ],
    },
    goal.revision,
    "operator",
  );
  f.store.registerWorker("worker");
  const claim = f.store.claimNextTask("worker")!;
  f.store.transition(claim.task.id, "worker", claim.generation, "running");
  const usage = {
    kind: "metered" as const,
    status: "estimated" as const,
    costUsd: 0.25,
    inputTokens: 100,
    outputTokens: 10,
  };
  f.store.release(
    claim.task.id,
    "worker",
    claim.generation,
    "failed",
    "cleanup",
    0.25,
    usage,
    failureRecord("cleanup_blocked"),
  );
  const attempt = f.store.attempts(goal.id)[0];
  assert.equal(attempt.outcome, "recovering");
  assert.deepEqual(attempt.usage, usage);
});

test("cancellation retains measured eventual successful completion", async (t) => {
  const f = await fixture(t);
  const goal = await f.goal("cancelled-success");
  const controller = new AbortController();
  const measured = {
    kind: "metered" as const,
    status: "estimated" as const,
    costUsd: 0.25,
    inputTokens: 100,
    outputTokens: 10,
  };
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    backend: () => ({
      run: async () => {
        const result = { text: "done", costUsd: 0.25, usage: measured };
        queueMicrotask(() =>
          queueMicrotask(() => controller.abort(new Error("cancel"))),
        );
        return result;
      },
    }),
  } as any);
  await assert.rejects(
    (scheduler as any).runBackend(
      goal,
      {
        claim: { goal, task: { id: "planning" }, generation: 0 },
        signal: controller.signal,
        onCheckpoint: async () => {},
      },
      "planning",
    ),
  );
  assert.deepEqual(f.store.attempts(goal.id)[0].usage, measured);
  assert.equal(f.store.canSpend(goal.id).settledUsd, 0.25);
});

for (const cleanupBlocked of [false, true])
  test(`startup-fenced controller completion retains ownership and usage ${cleanupBlocked}`, async (t) => {
    const f = await fixture(t),
      goal = await f.goal("fenced-final");
    const usage = {
      kind: "metered" as const,
      status: "estimated" as const,
      costUsd: 0.25,
      inputTokens: 100,
      outputTokens: 10,
    };
    let attemptId = "";
    const scheduler = new Scheduler(f.store, f.root, "unused", {
      backend: () => ({
        run: async (context: any) => {
          attemptId = context.operationReservationId;
          f.db.exec(
            `INSERT INTO execution_invocations(id,task_id,generation,record) VALUES('owned','planning',0,'{"id":"owned","spec":{"operationReservationId":"${attemptId}"},"container":"still-owned","status":"running"}')`,
          );
          f.store.fenceStartup();
          if (cleanupBlocked)
            throw Object.assign(
              new ProviderFailure(failureRecord("cleanup_blocked")),
              { usage, costUsd: 0.25 },
            );
          return {
            text: "done",
            usage,
            costUsd: 0.25,
            inputTokens: 100,
            outputTokens: 10,
          };
        },
      }),
    } as any);
    const run = (scheduler as any).runBackend(
      goal,
      {
        claim: { goal, task: { id: "planning" }, generation: 0 },
        signal: new AbortController().signal,
        onCheckpoint: async () => {},
      },
      "planning",
    );
    await assert.rejects(run);
    assert.equal(f.store.attempts(goal.id)[0].outcome, "recovering");
    assert.deepEqual(f.store.attempts(goal.id)[0].usage, usage);
    assert.equal(f.store.canSpend(goal.id).settledUsd, 0);
    assert.throws(
      () => f.store.finishStartupRecovery(),
      /resources require inspected cleanup/,
    );
    f.db.exec(
      `UPDATE execution_invocations SET record='{"id":"owned","spec":{"operationReservationId":"${attemptId}"},"status":"stopped"}' WHERE id='owned'`,
    );
    f.store.finishStartupRecovery();
    assert.equal(f.store.canSpend(goal.id).settledUsd, 0.25);
  });

test("controller completion after closed recovery retains evidence without restoring authority", async (t) => {
  const f = await fixture(t),
    goal = await f.goal("closed-controller");
  const usage = {
    kind: "metered" as const,
    status: "estimated" as const,
    costUsd: 0.25,
    inputTokens: 100,
    outputTokens: 10,
  };
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    backend: () => ({
      run: async (context: any) => {
        f.store.fenceStartup();
        f.store.finishOperationRecovery(context.operationReservationId);
        return {
          text: "done",
          usage,
          costUsd: 0.25,
          inputTokens: 100,
          outputTokens: 10,
        };
      },
    }),
  } as any);
  await assert.rejects(
    (scheduler as any).runBackend(
      goal,
      {
        claim: { goal, task: { id: "planning" }, generation: 0 },
        signal: new AbortController().signal,
        onCheckpoint: async () => {},
      },
      "planning",
    ),
  );
  assert.equal(f.store.attempts(goal.id)[0].outcome, "interrupted");
  assert.deepEqual(f.store.attempts(goal.id)[0].usage, usage);
  assert.equal(f.store.canSpend(goal.id).settledUsd, 0);
});

test("fenced worker authority cannot revive after paused goal resumes", async (t) => {
  const f = await fixture(t),
    goal = await f.goal("pause-fence");
  f.store.installPlan(
    goal.id,
    {
      tasks: [
        {
          key: "one",
          title: "one",
          description: "one",
          acceptanceCriteria: ["works"],
          allowedPaths: ["**"],
        },
      ],
    },
    goal.revision,
  );
  f.store.registerWorker("worker");
  const claim = f.store.claimNextTask("worker")!;
  const usage = {
    kind: "metered" as const,
    status: "estimated" as const,
    costUsd: 0.25,
    inputTokens: 100,
    outputTokens: 10,
  };
  f.store.setGoalState(
    goal.id,
    "paused",
    f.store.getGoal(goal.id).revision,
    "operator",
  );
  f.store.release(
    claim.task.id,
    "worker",
    claim.generation,
    "blocked",
    "paused",
    0.25,
    usage,
  );
  f.store.setGoalState(
    goal.id,
    "running",
    f.store.getGoal(goal.id).revision,
    "operator",
  );
  assert.throws(
    () => f.store.assertLease(claim.task.id, "worker", claim.generation),
    /lease is no longer valid/,
  );
  assert.equal(f.store.attempts(goal.id)[0].outcome, "recovering");
  assert.equal(f.store.canSpend(goal.id).settledUsd, 0);
});
