import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  lstat,
  symlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { SqliteStore, sql } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { AzureProvider, BedrockProvider } from "./providers.js";
import { OperationalLog } from "./operationalLog.js";
import { Redactor } from "../privacy.js";
import { supportBundle, writeSupportBundle } from "./supportBundle.js";
import { createControlServer } from "./api.js";
import { failureRecord } from "./reliability.js";
import { openApi } from "./api.js";
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
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-faults-")),
    db = new SqliteStore(join(root, "state.db")),
    store = new ControlStore(db);
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const goal = store.createGoal({
    title: "Synthetic",
    description: "Synthetic",
    repoPath: root,
    backend: { kind: "fake" },
    timeoutMs: 1000,
  });
  return { root, db, store, goal };
}

test("stalled headers, stalled body and keepalive-only Azure stream obey request deadline", async (t) => {
  const f = await fixture(t);
  for (const mode of ["headers", "body", "keepalive"]) {
    let interval: NodeJS.Timeout | undefined;
    const fetcher: any = async () =>
      mode === "headers"
        ? new Promise(() => {})
        : new Response(
            new ReadableStream({
              start(controller) {
                if (mode === "keepalive")
                  interval = setInterval(
                    () =>
                      controller.enqueue(
                        new TextEncoder().encode(": keepalive\n\n"),
                      ),
                    5,
                  );
              },
              cancel() {
                if (interval) clearInterval(interval);
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
    const provider = new AzureProvider(
      azure,
      fetcher,
      async () => ({}),
      f.store.reliability,
    );
    const started = Date.now();
    await assert.rejects(
      provider.generate([], [], AbortSignal.timeout(40), { goalId: f.goal.id }),
      (e: any) => e.failure.kind === "deadline",
    );
    assert.ok(Date.now() - started < 1000);
  }
  const diagnostics = f.store.reliability.page(
    "inference_diagnostics",
    f.goal.id,
  );
  assert.equal(diagnostics.length, 3);
  assert.ok(diagnostics.every((d) => d.endedAt && d.usageStatus === "unknown"));
});
test("provider codes distinguish deterministic HTTP failures from eligible throttling", async (t) => {
  const f = await fixture(t);
  for (const [status, code, kind] of [
    [400, "BadRequest", "invalid_request"],
    [401, "InvalidKey", "authentication"],
    [403, "Forbidden", "authentication"],
    [404, "DeploymentNotFound", "deployment_missing"],
    [429, "insufficient_quota", "quota"],
    [429, "rate_limit", "rate_limit"],
    [503, "Unavailable", "service"],
    [400, "ResponsibleAIPolicyViolation", "policy_refusal"],
  ] as const) {
    let calls = 0;
    const p = new AzureProvider(
      azure,
      async () => {
        calls++;
        return new Response(
          JSON.stringify({
            error: {
              code,
              message: "private prompt Bearer synthetic-private-token",
            },
          }),
          { status, headers: { "request-id": "synthetic-correlation" } },
        );
      },
      async () => ({}),
      f.store.reliability,
    );
    await assert.rejects(
      p.generate([], [], AbortSignal.timeout(1000), { goalId: f.goal.id }),
      (e: any) => e.failure.kind === kind,
    );
    assert.equal(calls, 1);
  }
  assert.ok(
    !JSON.stringify(f.store.reliability.page("inference_diagnostics")).includes(
      "synthetic-private-token",
    ),
  );
});
test("Bedrock structured refusal and throttling remain classified", async () => {
  for (const [event, kind] of [
    [{ messageStop: { stopReason: "guardrail_intervened" } }, "policy_refusal"],
    [{ throttlingException: { message: "private" } }, "rate_limit"],
    [{ validationException: { message: "private" } }, "invalid_request"],
  ] as const) {
    const client: any = {
      send: async () => ({
        stream: (async function* () {
          yield event;
        })(),
        $metadata: { httpStatusCode: 200, requestId: "synthetic-id" },
      }),
    };
    const p = new BedrockProvider(
      {
        kind: "bedrock",
        region: "us-east-1",
        model: "synthetic",
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
      },
      client,
    );
    await assert.rejects(
      p.generate([], [], AbortSignal.timeout(1000)),
      (e: any) => e.failure.kind === kind,
    );
  }
});
test("metadata log rotates privately and excludes arbitrary provider prose", async (t) => {
  const f = await fixture(t),
    redactor = new Redactor();
  redactor.register("synthetic-secret");
  const log = new OperationalLog(
    join(f.root, "logs", "ops.jsonl"),
    redactor,
    300,
    5,
  );
  for (let i = 0; i < 25; i++)
    log.write("attempt_failed", {
      goalId: "synthetic-secret",
      generation: i,
      message: "private prompt",
      authorization: "private token",
    });
  const latest = await readFile(log.path, "utf8");
  assert.ok(!latest.includes("synthetic-secret"));
  assert.ok(!latest.includes("private prompt"));
  assert.equal((await lstat(log.path)).mode & 0o077, 0);
  assert.ok(await lstat(log.path + ".5"));
  await assert.rejects(lstat(log.path + ".6"));
  await rm(log.path);
  await symlink(join(f.root, "state.db"), log.path);
  assert.throws(() => log.write("event"), /ownership/);
});
test("support bundle excludes checkpoints and raw evidence and refuses public destinations", async (t) => {
  const f = await fixture(t);
  f.store.installPlan(
    f.goal.id,
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
    f.goal.revision,
  );
  const claim = f.store.claimNextTask("worker")!;
  f.store.checkpoint(claim.task.id, "worker", 1, {
    summary: "private prompt content",
  });
  f.store.recordFailure(
    f.goal.id,
    failureRecord("policy_refusal"),
    `${claim.task.id}:1`,
  );
  f.store.redactor.register("synthetic-secret");
  const bundle = supportBundle(f.store, f.goal.id, `${claim.task.id}:1`, [
    "Bearer synthetic-secret",
  ]);
  assert.ok(!JSON.stringify(bundle).includes("private prompt content"));
  assert.ok(!JSON.stringify(bundle).includes("synthetic-secret"));
  assert.equal(bundle.manifest.reviewedExcerptCount, 1);
  const destination = join(f.root, "bundle.json");
  await writeSupportBundle(destination, bundle);
  assert.equal((await lstat(destination)).mode & 0o077, 0);
  await assert.rejects(writeSupportBundle(destination, bundle), /exist/);
  const shared = join(f.root, "shared");
  await mkdir(shared);
  await chmod(shared, 0o755);
  await assert.rejects(
    writeSupportBundle(join(shared, "bundle.json"), bundle),
    /private/,
  );
  assert.throws(() => supportBundle(f.store, f.goal.id, "wrong"), /belong/);
});
test("readiness requires scheduler freshness and operator authority; diagnostics are private", async (t) => {
  const f = await fixture(t),
    server = createControlServer(f.store, {
      token: "synthetic-operator-token-012345",
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`,
    headers = { authorization: "Bearer synthetic-operator-token-012345" };
  assert.equal((await fetch(base + "/readiness")).status, 401);
  assert.equal((await fetch(base + "/readiness", { headers })).status, 503);
  f.store.setting("scheduler-heartbeat", { completedAt: Date.now() });
  assert.equal((await fetch(base + "/readiness", { headers })).status, 200);
  assert.equal((await fetch(base + "/inference-diagnostics")).status, 401);
  for (const id of ["older", "recent"])
    f.store.reliability.diagnostic({
      version: 1,
      id,
      goalId: f.goal.id,
      provider: "synthetic",
      endpoint: "https://example.invalid",
      model: "synthetic",
      phase: "body",
      status: "completed",
      startedAt: Date.now(),
    });
  const recent = await (
    await fetch(
      base +
        "/inference-diagnostics?goalId=" +
        f.goal.id +
        "&order=desc&limit=1",
      { headers },
    )
  ).json();
  assert.equal(recent[0].id, "recent");
  const earlier = await (
    await fetch(
      base +
        "/inference-diagnostics?goalId=" +
        f.goal.id +
        "&order=desc&limit=1&after=" +
        recent[0].id,
      { headers },
    )
  ).json();
  assert.equal(earlier[0].id, "older");
  assert.equal(
    (await fetch(base + "/inference-diagnostics?order=malformed", { headers }))
      .status,
    400,
  );
});
test("reported budget totals include histories longer than dashboard pagination", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 510; i++)
    f.db.exec(
      `INSERT INTO control_attempts(id,goal_id,generation,operation,configuration_hash,configuration,started_at,outcome,usage) VALUES(${sql("synthetic_" + i)},${sql(f.goal.id)},0,'plan','synthetic',${sql(JSON.stringify(f.goal.config))},'2026-01-01','completed',${sql(JSON.stringify({ kind: "metered", status: "reported", costUsd: 1 }))})`,
    );
  assert.equal(f.store.canSpend(f.goal.id).reportedUsd, 510);
});

test("replacement retains unknown holds, immutable family ceiling and predecessor fencing", async (t) => {
  const f = await fixture(t),
    original = f.store.createGoal({
      ...f.goal.config,
      title: "Family",
      maxCostUsd: 5,
      estimatePerRunUsd: 1,
    });
  const reservation = f.store.reserveOperation(original.id, "synthetic");
  f.store.settleOperation(
    reservation,
    undefined,
    { kind: "metered", status: "unknown" },
    "interrupted",
  );
  const old = f.store.setGoalState(
    original.id,
    "paused",
    original.revision,
    "operator",
  );
  assert.throws(
    () =>
      f.store.replaceGoal(
        old.id,
        { ...old.config, maxCostUsd: 5 },
        old.revision,
        "operator",
      ),
    /allowance/,
  );
  const replacement = f.store.replaceGoal(
    old.id,
    { ...old.config, maxCostUsd: 4 },
    old.revision,
    "operator",
  );
  assert.equal(f.store.familyBudget(replacement.id).allowanceUsd, 5);
  assert.equal(f.store.familyBudget(replacement.id).consumedUsd, 1);
  assert.equal(f.store.canSpend(old.id).unresolvedUsd, 1);
  assert.throws(
    () => f.store.setGoalState(old.id, "running", old.revision, "operator"),
    /successor/,
  );
  assert.throws(
    () =>
      f.store.replaceGoal(
        old.id,
        { ...old.config, maxCostUsd: 4 },
        old.revision,
        "operator",
      ),
    /successor/,
  );
});

test("cancel fences current workers while keeping reservations and startup diagnostic evidence", async (t) => {
  const f = await fixture(t);
  f.store.installPlan(
    f.goal.id,
    {
      tasks: [
        {
          key: "one",
          title: "One",
          description: "Synthetic",
          allowedPaths: ["**"],
          acceptanceCriteria: ["Synthetic"],
          resources: ["synthetic-lock"],
        },
      ],
    },
    f.goal.revision,
  );
  const claim = f.store.claimNextTask("worker")!;
  f.store.reliability.diagnostic({
    version: 1,
    id: "synthetic-request",
    goalId: f.goal.id,
    attemptId: `${claim.task.id}:1`,
    provider: "azure",
    endpoint: "https://example.invalid",
    model: "synthetic",
    phase: "headers",
    status: "active",
    startedAt: Date.now(),
  });
  f.store.setGoalState(
    f.goal.id,
    "cancelled",
    f.store.getGoal(f.goal.id).revision,
    "operator",
  );
  assert.equal(f.store.getTask(claim.task.id).workerId, "worker");
  assert.equal(f.store.attempts(f.goal.id)[0].outcome, "recovering");
  assert.equal(f.db.query("SELECT * FROM control_resources").length, 1);
  assert.throws(() => f.store.heartbeat(claim.task.id, "worker", 1), /lease/);
  f.store.fenceStartup();
  assert.equal(
    f.store.reliability.page("inference_diagnostics", f.goal.id)[0].status,
    "interrupted",
  );
});

test("support export requires a reviewed manifest and returns the exact preview", async (t) => {
  const f = await fixture(t);
  f.store.installPlan(
    f.goal.id,
    {
      tasks: [
        {
          key: "one",
          title: "Synthetic",
          description: "Synthetic",
          acceptanceCriteria: ["Synthetic"],
          allowedPaths: ["**"],
        },
      ],
    },
    f.goal.revision,
  );
  const claim = f.store.claimNextTask("worker")!;
  const server = createControlServer(f.store, {
    token: "synthetic-operator-token-012345",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1/goals/${f.goal.id}/support-bundle`,
    headers = {
      authorization: "Bearer synthetic-operator-token-012345",
      "content-type": "application/json",
    };
  const attemptId = `${claim.task.id}:1`;
  assert.equal(
    (
      await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ attemptId, reviewed: true }),
      })
    ).status,
    409,
  );
  const preview = await (
    await fetch(base + `?attemptId=${encodeURIComponent(attemptId)}`, {
      headers,
    })
  ).json();
  f.store.recordFailure(f.goal.id, failureRecord("policy_refusal"), attemptId);
  const exported = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({
      attemptId,
      reviewed: true,
      previewSha256: preview.manifest.sha256,
    }),
  });
  assert.equal(exported.status, 200);
  assert.deepEqual(await exported.json(), preview);
  const api = openApi();
  for (const name of [
    "ProviderFailure",
    "AttemptRuntime",
    "InferenceDiagnostic",
    "Incident",
    "PauseRecord",
    "RecoveryDecision",
  ])
    assert.ok(name in api.components.schemas);
});
