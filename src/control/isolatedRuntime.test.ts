import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import {
  assertSessionAuthority,
  isolatedRuntimeSchema,
} from "./isolatedRuntime.js";
test("runtime inference authority fences worker generations, owner identity, goal state and review reservation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-runtime-")),
    db = new SqliteStore(join(root, "db")),
    store = new ControlStore(db);
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true });
  });
  const goal = store.createGoal({
    title: "fixture",
    description: "fixture",
    repoPath: root,
    backend: { kind: "fake" },
    maxCostUsd: 10,
    estimatePerRunUsd: 1,
  });
  store.installPlan(
    goal.id,
    {
      tasks: [
        {
          key: "one",
          title: "one",
          description: "one",
          allowedPaths: ["**"],
          acceptanceCriteria: ["done"],
        },
      ],
    },
    goal.revision,
  );
  const claim = store.claimNextTask("worker", { goalId: goal.id })!;
  const session: any = {
    id: "session",
    taskId: claim.task.id,
    generation: claim.generation,
    spec: {
      goalId: goal.id,
      workerId: "worker",
      authorityGeneration: claim.generation,
    },
  };
  assertSessionAuthority(store, session);
  assert.throws(
    () =>
      assertSessionAuthority(store, {
        ...session,
        spec: { ...session.spec, workerId: "other" },
      }),
    /lease/,
  );
  assert.throws(
    () =>
      assertSessionAuthority(store, session, {
        sessionId: "other",
        goalId: goal.id,
        taskId: session.taskId,
        generation: session.generation,
      } as any),
    /differs/,
  );
  const reservation = store.reserveOperation(goal.id, "review");
  const review: any = {
    id: "review",
    taskId: "planning",
    generation: 1,
    spec: {
      goalId: goal.id,
      workerId: "planner",
      authorityGeneration: 0,
      operationReservationId: reservation,
    },
  };
  assertSessionAuthority(store, review);
  store.settleOperation(reservation, 0.1);
  assert.throws(() => assertSessionAuthority(store, review), /reservation/);
  store.release(
    claim.task.id,
    "worker",
    claim.generation,
    "retry_wait",
    "fixture",
  );
  assert.throws(() => assertSessionAuthority(store, session), /lease/);
  assert.throws(() =>
    isolatedRuntimeSchema.parse({
      projects: { one: { imageDigest: "mutable:latest" } },
      providers: {},
    }),
  );
});
test("isolated service refuses external claims before reserving task ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-runtime-api-")),
    db = new SqliteStore(join(root, "db")),
    store = new ControlStore(db);
  const { createControlServer } = await import("./api.js");
  const { once } = await import("node:events");
  const token = "runtime-operator-token-0123456789";
  const server = createControlServer(store, {
    token,
    externalClaimsDisabled: true,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    await rm(root, { recursive: true });
  });
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}/api/v1/claims`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workerId: "remote" }),
    },
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "execution_mode");
});

test("execution maintenance is operator-only, preview by default and unavailable in host mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-runtime-maintenance-api-")),
    db = new SqliteStore(join(root, "db")),
    store = new ControlStore(db);
  const { createControlServer } = await import("./api.js");
  const { ControlClient } = await import("./client.js");
  const { once } = await import("node:events");
  const token = "runtime-operator-token-0123456789",
    calls: boolean[] = [];
  const server = createControlServer(store, {
    token,
    onExecutionMaintenance: async (apply) => {
      calls.push(apply);
      return { previewOnly: !apply };
    },
  });
  const host = createControlServer(store, { token });
  for (const s of [server, host]) {
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
  }
  t.after(async () => {
    for (const s of [server, host])
      await new Promise<void>((r) => s.close(() => r()));
    db.close();
    await rm(root, { recursive: true });
  });
  const url = (s: typeof server) =>
    `http://127.0.0.1:${(s.address() as any).port}`;
  const operator = new ControlClient(url(server), token);
  const worker = new ControlClient(
    url(server),
    store.createToken("worker", "worker", "worker"),
  );
  for (const method of ["GET", "POST"]) {
    await assert.rejects(
      worker.request(
        "/execution-maintenance",
        method,
        method === "POST" ? { apply: true } : undefined,
      ),
      (e: any) => e.status === 403,
    );
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(await operator.request("/execution-maintenance"), {
    previewOnly: true,
  });
  assert.deepEqual(
    await operator.request("/execution-maintenance", "POST", {}),
    { previewOnly: true },
  );
  await assert.rejects(
    operator.request("/execution-maintenance", "POST", { apply: "true" }),
    (e: any) => e.status === 400,
  );
  await assert.rejects(
    operator.request("/execution-maintenance", "POST", {
      apply: true,
      path: root,
    }),
    (e: any) => e.status === 400,
  );
  assert.deepEqual(
    await operator.request("/execution-maintenance", "POST", { apply: true }),
    { previewOnly: false },
  );
  assert.deepEqual(calls, [false, false, true]);
  await assert.rejects(
    new ControlClient(url(host), token).request("/execution-maintenance"),
    (e: any) => e.code === "execution_mode",
  );
});

test("portable runtime requires strict provider/authentication definitions and cannot use fake/native backends", () => {
  const backend = {
      kind: "bedrock",
      model: "synthetic",
      region: "eu-west-1",
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    },
    reference = { kind: "file", path: "synthetic-session" };
  const input = {
    projects: {},
    providers: {
      synthetic: {
        protocol: "tool-loop",
        backend,
        authentication: {
          kind: "aws-session",
          accessKey: reference,
          secretKey: reference,
          sessionToken: reference,
        },
      },
    },
  };
  assert.equal(
    isolatedRuntimeSchema.parse(input).providers.synthetic.protocol,
    "tool-loop",
  );
  assert.throws(() =>
    isolatedRuntimeSchema.parse({
      ...input,
      providers: {
        synthetic: { ...input.providers.synthetic, backend: { kind: "fake" } },
      },
    }),
  );
  assert.throws(() =>
    isolatedRuntimeSchema.parse({
      ...input,
      providers: {
        synthetic: {
          ...input.providers.synthetic,
          authentication: { kind: "ambient" },
        },
      },
    }),
  );
});

import { subscriptionBinding } from "./isolatedRuntime.js";
import { authEnvironmentSchema, authPolicyHash } from "./authEnvironment.js";
import { goalSchema } from "./schema.js";
test("subscription binding pins admitted provider/model/image/auth policy and refuses widening or missing snapshots", () => {
  const auth = authEnvironmentSchema.parse({
    id: "dedicated",
    harness: "codex",
    sessionDir: "dedicated",
    imageDigest: `sha256:${"a".repeat(64)}`,
    egress: { hosts: ["provider.example"] },
  });
  const runtime = isolatedRuntimeSchema.parse({
    projects: { sample: { imageDigest: auth.imageDigest } },
    providers: {
      cloud: {
        protocol: "subscription",
        harness: "codex",
        model: "synthetic",
        authentication: { kind: "session", reference: auth.id },
      },
    },
  });
  const config = goalSchema.parse({
    title: "synthetic",
    description: "synthetic",
    repoPath: "/synthetic",
    projectId: "sample",
    backend: { kind: "codex", model: "synthetic" },
    maxWorkers: 1,
    maxCostUsd: 0,
    estimatePerRunUsd: 0,
    executionContract: {
      harness: "codex",
      provider: "codex-subscription",
      execution: "isolated",
      authentication: { kind: "session", reference: auth.id },
      usagePolicy: {
        kind: "subscription",
        timeoutMs: 10000,
        maxAttempts: 2,
        maxConcurrency: 1,
      },
    },
    admission: {
      configurationHash: "c".repeat(64),
      runtimeHash: "d".repeat(64),
      executionMode: "isolated",
      providerId: "cloud",
      executionImageDigest: auth.imageDigest,
      authenticationPolicyHash: authPolicyHash(auth),
      prompts: [],
    },
  });
  const goal = { id: "synthetic", config } as any;
  assert.equal(
    subscriptionBinding(goal, runtime, [auth], "d".repeat(64)).image,
    auth.imageDigest,
  );
  for (const changed of [
    {
      ...config,
      admission: { ...config.admission, authenticationPolicyHash: undefined },
    },
    {
      ...config,
      admission: {
        ...config.admission,
        executionImageDigest: `sha256:${"b".repeat(64)}`,
      },
    },
    { ...config, admission: { ...config.admission, providerId: "other" } },
    { ...config, backend: { kind: "codex", model: "other" } },
  ])
    assert.throws(
      () =>
        subscriptionBinding(
          { ...goal, config: changed },
          runtime,
          [auth],
          "d".repeat(64),
        ),
      /differs/,
    );
  assert.throws(
    () =>
      subscriptionBinding(goal, runtime, [
        { ...auth, egress: { ...auth.egress, hosts: ["other.example"] } },
      ]),
    /policy differs/,
  );
  assert.throws(
    () => subscriptionBinding(goal, runtime, [auth], "e".repeat(64)),
    /configuration changed/,
  );
  assert.throws(() => subscriptionBinding(goal, runtime, []), /policy differs/);
  assert.throws(() =>
    authEnvironmentSchema.parse({ ...auth, qualified: true }),
  );
});
