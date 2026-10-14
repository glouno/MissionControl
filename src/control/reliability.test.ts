import { nativePrompt } from "./nativePrompt.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import {
  ProviderFailure,
  classifyFailure,
  failureRecord,
  boundedCleanup,
  retryProvider,
  safeDiagnosticText,
} from "./reliability.js";
import { AzureProvider } from "./providers.js";
import { validatePlan } from "./schema.js";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-reliability-"));
  const db = new SqliteStore(join(root, "db"));
  let now = Date.now();
  const store = new ControlStore(db, () => now);
  t.after(() => {
    db.close();
    return rm(root, { recursive: true, force: true });
  });
  const goal = store.createGoal({
    title: "Synthetic reliability",
    description: "Synthetic",
    repoPath: root,
    backend: { kind: "fake" },
    timeoutMs: 1000,
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
        },
      ],
    },
    goal.revision,
  );
  const claim = store.claimNextTask("worker")!;
  store.transition(claim.task.id, "worker", claim.generation, "running");
  return {
    root,
    db,
    store,
    goal,
    claim,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const azure = {
  kind: "azure" as const,
  endpoint: "https://example.invalid",
  model: "synthetic",
  reasoningEffort: "medium" as const,
  maxOutputTokens: 64,
  credential: "key" as const,
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 1,
};

test("failure taxonomy separates policy, auth, quota, deployment, rate limits and transport", () => {
  for (const [input, status, kind] of [
    [{ error: { code: "content_filter" } }, 400, "policy_refusal"],
    [{}, 403, "authentication"],
    [{ error: { code: "insufficient_quota" } }, 429, "quota"],
    [{}, 404, "deployment_missing"],
    [{}, 429, "rate_limit"],
    [{}, 503, "service"],
    [new Error("ECONNRESET"), undefined, "transport"],
    [new Error("Task timeout"), undefined, "deadline"],
  ] as const)
    assert.equal(classifyFailure(input, status).kind, kind);
  assert.equal(classifyFailure({}, 403).kind, "authentication");
  assert.equal(
    safeDiagnosticText("Bearer synthetic-secret-value").includes(
      "synthetic-secret-value",
    ),
    false,
  );
});
test("heartbeats cannot extend phase deadline and expired authority cannot checkpoint", async (t) => {
  const f = await fixture(t);
  f.advance(700);
  f.store.heartbeat(f.claim.task.id, "worker", 1);
  f.advance(301);
  assert.throws(() => f.store.heartbeat(f.claim.task.id, "worker", 1), /lease/);
  assert.equal(f.store.expired().length, 1);
  f.store.reconcileExpired(f.claim.task.id, 1);
  assert.equal(f.store.attempts(f.goal.id)[0].outcome, "recovering");
  assert.throws(
    () => f.store.checkpoint(f.claim.task.id, "worker", 1, { summary: "late" }),
    /lease/,
  );
});

test("failed checks release containerless checkpointed execution without fictional cleanup failure", async (t) => {
  const f = await fixture(t);
  const record = {
    id: "synthetic-session",
    taskId: f.claim.task.id,
    generation: 1,
    status: "checkpointed",
    spec: { taskId: f.claim.task.id, authorityGeneration: 1 },
  };
  f.db.exec(
    `INSERT INTO execution_invocations VALUES('synthetic-session','${f.claim.task.id}',1,'${JSON.stringify(record)}')`,
  );
  f.store.transition(f.claim.task.id, "worker", 1, "verifying");
  const released = f.store.release(
    f.claim.task.id,
    "worker",
    1,
    "retry_wait",
    "Task tests failed",
  );
  assert.equal(released.status, "retry_wait");
  assert.equal(f.store.attempts(f.goal.id)[0].outcome, "retry_wait");
  assert.equal(
    f.store.reliability.runtime(`${f.claim.task.id}:1`)!.cleanupStartedAt,
    undefined,
  );
});

test("checkpointed status cannot hide retained execution container", async (t) => {
  const f = await fixture(t);
  const record = {
    id: "synthetic-session",
    taskId: f.claim.task.id,
    generation: 1,
    status: "checkpointed",
    container: "synthetic-owned-container",
  };
  f.db.exec(
    `INSERT INTO execution_invocations VALUES('synthetic-session','${f.claim.task.id}',1,'${JSON.stringify(record)}')`,
  );
  assert.throws(
    () => f.store.release(f.claim.task.id, "worker", 1, "retry_wait", "failed"),
    /resources|execution/i,
  );
  assert.equal(f.store.attempts(f.goal.id)[0].outcome, "active");
});
test("result phase has one shared envelope and preserves implementation evidence", async (t) => {
  const f = await fixture(t);
  const start = f.store.reliability.runtime(`${f.claim.task.id}:1`)!;
  f.advance(300);
  f.store.transition(f.claim.task.id, "worker", 1, "verifying");
  const result = f.store.reliability.runtime(start.attemptId)!;
  assert.equal(result.deadlineAt - result.phaseStartedAt, 30000);
  f.advance(1000);
  f.store.transition(f.claim.task.id, "worker", 1, "integrating");
  assert.equal(
    f.store.reliability.runtime(start.attemptId)!.deadlineAt,
    result.deadlineAt,
  );
});
test("cleanup deadline survives restart without renewing fenced ownership", async (t) => {
  const f = await fixture(t);
  f.advance(1001);
  f.store.reconcileExpired(f.claim.task.id, 1);
  const original = f.store.reliability.runtime(`${f.claim.task.id}:1`)!;
  assert.equal(original.cleanupDeadlineAt, f.store.clock() + 60000);
  f.advance(60001);
  const restarted = new ControlStore(f.db, () => f.store.clock());
  assert.equal(
    restarted.reliability.cleanupSignal(original.attemptId).aborted,
    true,
  );
  assert.equal(
    restarted.reliability.runtime(original.attemptId)!.cleanupDeadlineAt,
    original.cleanupDeadlineAt,
  );
  assert.equal(restarted.getTask(f.claim.task.id).workerId, "worker");
  assert.equal(restarted.attempts(f.goal.id)[0].outcome, "recovering");
});
test("controller recovery refuses live resources and retains unknown usage after inspected stop", async (t) => {
  const f = await fixture(t);
  f.store.release(f.claim.task.id, "worker", 1, "blocked", "Synthetic stop");
  const attemptId = f.store.reserveOperation(f.goal.id, "review");
  f.db.exec(
    `UPDATE control_attempts SET outcome='recovering' WHERE id='${attemptId}'`,
  );
  f.db.exec(
    `INSERT INTO sessions VALUES('synthetic','controller',1,'${JSON.stringify({ status: "active", container: "synthetic", spec: { operationReservationId: attemptId } })}')`,
  );
  assert.throws(
    () => f.store.finishOperationRecovery(attemptId),
    /inspected cleanup/,
  );
  assert.equal(
    f.store.attempts(f.goal.id).find((a) => a.id === attemptId)!.outcome,
    "recovering",
  );
  f.db.exec(
    `UPDATE sessions SET record='${JSON.stringify({ status: "stopped", spec: { operationReservationId: attemptId } })}'`,
  );
  f.store.finishOperationRecovery(attemptId);
  assert.equal(
    f.store.attempts(f.goal.id).find((a) => a.id === attemptId)!.outcome,
    "interrupted",
  );
  assert.equal(f.store.reliability.runtime(attemptId)!.cleanupState, "stopped");
});
test("expired cleanup never invokes resource mutations", async () => {
  let called = false;
  await assert.rejects(
    boundedCleanup(
      async () => {
        called = true;
      },
      60000,
      AbortSignal.abort(),
    ),
  );
  assert.equal(called, false);
});
test("plan installation rejects scope widening and impossible resource prerequisites", async (t) => {
  const f = await fixture(t);
  const goal = f.store.createGoal({
    title: "Scope",
    description: "Synthetic",
    repoPath: f.root,
    backend: { kind: "fake" },
    policy: { approvedPaths: ["src/**"] },
  });
  const task = {
    key: "one",
    title: "One",
    description: "Synthetic",
    allowedPaths: ["**"],
    acceptanceCriteria: ["Meaningful"],
  };
  assert.throws(
    () => f.store.installPlan(goal.id, { tasks: [task] }, goal.revision),
    /scope exceeds/,
  );
  f.store.setting("scheduler-limits", { cpu: 1, memoryMiB: 1024 });
  assert.throws(
    () =>
      f.store.installPlan(
        goal.id,
        { tasks: [{ ...task, allowedPaths: ["src/**"], cpuUnits: 2 }] },
        goal.revision,
      ),
    /host capacity/,
  );
  f.store.installPlan(
    goal.id,
    {
      tasks: [
        { ...task, allowedPaths: ["src/calc.py"], cpuUnits: 1, memoryMiB: 128 },
      ],
    },
    goal.revision,
  );
  assert.equal(f.store.tasks(goal.id).length, 1);
});
test("provider refusal pauses once, survives restart and generic resume cannot bypass it", async (t) => {
  const f = await fixture(t);
  const fail = failureRecord("policy_refusal");
  f.store.recordFailure(f.goal.id, fail, `${f.claim.task.id}:1`);
  f.store.recordFailure(f.goal.id, fail, `${f.claim.task.id}:1`);
  assert.equal(f.db.query("SELECT id FROM reliability_incidents").length, 1);
  assert.equal(
    f.db.query("SELECT id FROM control_outbox WHERE kind='incident'").length,
    1,
  );
  const restarted = new ControlStore(f.db, () => f.store.clock());
  const g = restarted.getGoal(f.goal.id);
  assert.equal(g.status, "paused");
  assert.throws(
    () => restarted.setGoalState(g.id, "running", g.revision, "operator"),
    /provider blocker/,
  );
});
test("cleanup timeout returns bounded failure and retains worker resource ownership", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    boundedCleanup(() => new Promise(() => {}), 30),
    (e: any) =>
      e instanceof ProviderFailure && e.failure.kind === "cleanup_blocked",
  );
  f.store.release(
    f.claim.task.id,
    "worker",
    1,
    "blocked",
    "cleanup",
    undefined,
    undefined,
    failureRecord("cleanup_blocked"),
  );
  assert.equal(f.store.getTask(f.claim.task.id).workerId, "worker");
  assert.equal(f.store.attempts(f.goal.id)[0].outcome, "recovering");
});
test("unchanged provider failures and successful response refusals retain useful sanitized evidence", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  for (const [body, status, kind] of [
    [
      JSON.stringify({
        error: { code: "DeploymentNotFound", message: "secret prompt" },
      }),
      404,
      "deployment_missing",
    ],
    [
      'data: {"type":"response.completed","response":{"output":[{"content":[{"type":"refusal","refusal":"secret prompt"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      200,
      "policy_refusal",
    ],
  ] as const) {
    f.store.reliability.saveRuntime({
      ...f.store.reliability.runtime(`${f.claim.task.id}:1`)!,
      failure: undefined,
    });
    const provider = new AzureProvider(
      azure,
      async () => {
        calls++;
        return new Response(body, {
          status,
          headers: {
            "x-request-id": "synthetic-request",
            "content-type": "text/event-stream",
          },
        });
      },
      async () => ({}),
      f.store.reliability,
    );
    await assert.rejects(
      provider.generate([], [], AbortSignal.timeout(1000), {
        attemptId: `${f.claim.task.id}:1`,
        goalId: f.goal.id,
      }),
      (e: any) => e.failure.kind === kind,
    );
  }
  assert.equal(calls, 2);
  const diagnostics = f.store.reliability.page(
    "inference_diagnostics",
    f.goal.id,
  );
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].requestIds["x-request-id"], "synthetic-request");
  assert.equal(JSON.stringify(diagnostics).includes("secret prompt"), false);
});
test("stalled provider authentication is bounded and recorded before request headers", async (t) => {
  const f = await fixture(t);
  const provider = new AzureProvider(
    azure,
    async () => {
      throw Error("must not fetch");
    },
    () => new Promise(() => {}),
    f.store.reliability,
  );
  await assert.rejects(
    provider.generate([], [], AbortSignal.timeout(30), { goalId: f.goal.id }),
    (e: any) => e.failure.kind === "deadline",
  );
  assert.equal(
    f.store.reliability.page("inference_diagnostics", f.goal.id)[0].phase,
    "authentication",
  );
});
test("transient retry count survives restart and stops at three retries", async (t) => {
  const f = await fixture(t);
  let clock = 0,
    calls = 0;
  const r = f.store.reliability.runtime(`${f.claim.task.id}:1`)!;
  r.deadlineAt = 1000000;
  r.nextRetryAt = undefined;
  await assert.rejects(
    retryProvider(
      async () => {
        calls++;
        throw new ProviderFailure(
          failureRecord("rate_limit", { httpStatus: 429 }),
        );
      },
      AbortSignal.timeout(1000),
      r,
      (x) => f.store.reliability.saveRuntime(x),
      () => clock,
      async (ms) => {
        clock += ms;
      },
    ),
  );
  assert.equal(calls, 4);
  assert.equal(f.store.reliability.runtime(r.attemptId)!.retryCount, 3);
});
test("plan validation rejects mutating checks and unsupported path scopes", () => {
  const plan = (command: string, path = "**") => ({
    tasks: [
      {
        key: "one",
        title: "One",
        description: "Synthetic",
        allowedPaths: [path],
        acceptanceCriteria: ["works"],
        verificationCommands: [command],
      },
    ],
  });
  for (const command of [
    "git commit -m accepted",
    "npm test && git push",
    "git reset --hard",
  ])
    assert.throws(() => validatePlan(plan(command)), /Verification/);
  assert.throws(() => validatePlan(plan("npm test", "../private")), /scope/);
  assert.equal(validatePlan(plan("npm test")).length, 1);
});

test("inspected credential repair queues only affected stopped tasks and does not replenish attempts", async (t) => {
  const f = await fixture(t);
  f.store.release(
    f.claim.task.id,
    "worker",
    1,
    "blocked",
    "Credential repair",
    undefined,
    undefined,
    failureRecord("authentication"),
  );
  const g = f.store.getGoal(f.goal.id);
  assert.equal(f.store.getTask(f.claim.task.id).status, "blocked");
  f.store.recoverGoal(
    g.id,
    g.revision,
    "Configured credential repaired and execution confirmed stopped",
    "operator",
  );
  const task = f.store.getTask(f.claim.task.id);
  assert.equal(task.status, "retry_wait");
  assert.equal(task.attempts, 1);
  assert.equal(f.store.getGoal(g.id).status, "running");
});
test("inspected recovery retires interrupted job intent without rewriting its deadline", async (t) => {
  const f = await fixture(t);
  f.store.release(
    f.claim.task.id,
    "worker",
    1,
    "blocked",
    "Stop for inspection",
  );
  const g = f.store.getGoal(f.goal.id);
  const paused = f.store.setGoalState(g.id, "paused", g.revision, "operator");
  const jobId = f.store.job("plan", { goalId: g.id });
  f.store.setting(`controller-job:${jobId}`, {
    status: "running",
    deadlineAt: 123,
  });
  f.store.recoverGoal(
    g.id,
    paused.revision,
    "Inspected source and effects",
    "operator",
  );
  const record = f.store.setting(`controller-job:${jobId}`);
  assert.equal(record.status, "inspected");
  assert.equal(record.deadlineAt, 123);
  assert.ok(record.recoveryDecisionId);
});

test("native handoff maps controller repository paths to the mounted execution workspace", () => {
  const context: any = {
    workspace: "/synthetic/controller/task",
    claim: { goal: { config: { repoPath: "/synthetic/repository" } } },
    execution: { workspace: "/workspace" },
    prompt:
      "Inspect /synthetic/controller/task/calc.py and /synthetic/repository/README.md. Keep calc.py.",
  };
  const prompt = nativePrompt(context);
  assert.ok(!prompt.includes("/synthetic/controller/task"));
  assert.ok(!prompt.includes("/synthetic/repository"));
  assert.ok(prompt.includes("/workspace/calc.py"));
  assert.ok(prompt.includes("/workspace/README.md"));
  assert.equal(
    nativePrompt({ ...context, execution: undefined }),
    context.prompt,
  );
});
