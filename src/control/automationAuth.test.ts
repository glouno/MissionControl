import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { ControlStore } from "./store.js";
import { SqliteStore } from "../sqlite.js";
import { createControlServer } from "./api.js";

test("served automation identities enforce project scope, idempotent mutations, expiration and revocation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-automation-"));
  const db = new SqliteStore(join(root, "app.db"));
  let now = Date.now();
  const store = new ControlStore(db, () => now),
    operator = "synthetic-operator-automation-tests";
  const input = (projectId: string, description = "Synthetic task") => ({
    projectId,
    description,
    title: description,
    repoPath: "/synthetic",
    repository: { mode: "local" as const, branch: "development" },
    verificationCommands: ["test -f artifact.txt"],
    backend: { kind: "fake" as const },
    policy: {
      targetBranch: "development",
      approvedPaths: ["**"],
      requiredChecks: ["test -f artifact.txt"],
      productionDeploymentExcluded: true,
    },
  });
  for (const id of ["allowed", "other"])
    store.setProject(
      { id, name: id, family: "synthetic", enabled: true, config: input(id) },
      "operator",
    );
  const hidden = store.createGoal(input("other"), "operator");
  const server = createControlServer(store, {
    token: operator,
    externalClaimsDisabled: true,
    validateGoal: (body) =>
      store.projects().find((p) => p.id === body.projectId)!.config,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const req = (path: string, token = operator, body?: unknown, key?: string) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const created = await req("/automation-identities", operator, {
    id: "operator",
    projectIds: ["allowed"],
    permissions: ["goals:read", "goals:create", "goals:control"],
    expiresInHours: 1,
  });
  assert.equal(created.status, 200);
  const { token } = (await created.json()) as { token: string };
  assert.deepEqual(
    ((await (await req("/projects", token)).json()) as { id: string }[]).map(
      (p) => p.id,
    ),
    ["allowed"],
  );
  assert.deepEqual(await (await req("/goals", token)).json(), []);
  assert.equal((await req(`/goals/${hidden.id}`, token)).status, 403);
  assert.equal((await req("/events", token)).status, 403);
  assert.equal(
    (
      await req("/goals", token, {
        projectId: "allowed",
        description: "Create artifact",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await req(
        "/goals",
        token,
        {
          projectId: "allowed",
          description: "Create artifact",
          maxCostUsd: 500,
        },
        "widen",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await req(
        "/goals",
        token,
        { projectId: "other", description: "Create artifact" },
        "other",
      )
    ).status,
    403,
  );
  const first = (await (
    await req(
      "/goals",
      token,
      { projectId: "allowed", description: "Create artifact" },
      "goal-one",
    )
  ).json()) as { id: string; revision: number };
  const replay = (await (
    await req(
      "/goals",
      token,
      { projectId: "allowed", description: "Create artifact" },
      "goal-one",
    )
  ).json()) as { id: string };
  assert.equal(first.id, replay.id);
  const operatorGoal = (await (
    await req(
      "/goals",
      operator,
      { projectId: "allowed", description: "Operator request" },
      "goal-one",
    )
  ).json()) as { id: string };
  assert.notEqual(
    first.id,
    operatorGoal.id,
    "Role namespace prevents automation actor name colliding with operator idempotency",
  );
  assert.equal(
    (
      await req(
        "/goals",
        token,
        { projectId: "allowed", description: "Different" },
        "goal-one",
      )
    ).status,
    409,
  );
  for (const [path, body] of [
    ["/configuration", { hash: "a".repeat(64) }],
    ["/questions/question_x/answer", { option: "approve", revision: 1 }],
    [`/goals/${first.id}/backend`, { backend: { kind: "fake" }, revision: 1 }],
    ["/tokens", { workerId: "intruder" }],
    ["/claims", { workerId: "intruder" }],
  ] as [string, unknown][])
    assert.equal((await req(path, token, body, "denied")).status, 403, path);
  const paused = await req(
    `/goals/${first.id}/state`,
    token,
    { status: "paused", revision: first.revision },
    "pause-one",
  );
  assert.equal(paused.status, 200);
  assert.equal(
    (await req(`/goals/${first.id}/attempts?limit=501`, token)).status,
    400,
  );
  now += 3600001;
  assert.equal((await req(`/goals/${first.id}`, token)).status, 401);
  now -= 3600001;
  assert.equal(
    (await req("/automation-identities/operator/revoke", operator, {})).status,
    200,
  );
  assert.equal((await req(`/goals/${first.id}`, token)).status, 401);
});
