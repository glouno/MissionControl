import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { SqliteStore, sql } from "../sqlite.js";
import { initializeConfiguration, effectiveGoal } from "../config.js";
import { ControlStore } from "./store.js";
import { createControlServer } from "./api.js";
import { provisionAutomation } from "./automationAuth.js";
import type { BacklogEntry, Goal } from "./schema.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "mc-backlog-"));
  const config = await initializeConfiguration(
    join(root, "config"),
    join(root, "state"),
    join(root, "secrets"),
  );
  config.projects = ["a", "b"].map((id) => ({
    id,
    name: id,
    family: "fixture",
    enabled: true,
    executionMode: "fake" as const,
    promptIds: [],
    contextFiles: [],
    config: {
      repoPath: root,
      repository: { mode: "local" as const, branch: "development" },
      verificationCommands: ["true"],
      backend: { kind: "fake" as const },
      maxCostUsd: 0,
    },
  }));
  config.settings.authority.allowedExecutionModes = ["fake"];
  const path = join(root, "db");
  let db = new SqliteStore(path),
    store = new ControlStore(db);
  for (const p of config.projects)
    store.setProject(
      { ...p, config: effectiveGoal(config, p.id, "Fixture") },
      "operator",
    );
  store.setting("configuration-snapshot", config);
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    config,
    get db() {
      return db;
    },
    get store() {
      return store;
    },
    reopen() {
      db.close();
      db = new SqliteStore(path);
      store = new ControlStore(db);
      return store;
    },
  };
}
const input = (projectId = "a", dependencies: string[] = []) => ({
  projectId,
  title: "Durable work",
  description: "Implement feature",
  priority: 5,
  dependencies,
  acceptanceCriteria: ["Works"],
});
function executionState(db: SqliteStore) {
  return Object.fromEntries(
    [
      "control_goals",
      "control_tasks",
      "control_jobs",
      "control_attempts",
      "control_budgets",
      "control_workers",
      "control_resources",
      "control_events",
      "control_outbox",
    ]
      .map((table) => [table, db.query(`SELECT * FROM ${table}`)])
      .concat([
        [
          "accounting",
          db.query(
            "SELECT * FROM control_settings WHERE key='admitted-cost-usd'",
          ),
        ],
      ]),
  );
}
test("backlog CRUD is inert, validated, revision-controlled and durable", async (t) => {
  const f = await fixture(t),
    before = executionState(f.db);
  const entry = f.store.addBacklog(input());
  assert.equal(entry.revision, 1);
  assert.equal(entry.status, "backlog");
  assert.throws(() =>
    f.store.addBacklog({ ...input(), backend: { kind: "azure" } }),
  );
  assert.throws(() => f.store.addBacklog({ ...input(), title: " " }));
  assert.throws(() => f.store.addBacklog(input("missing")), /Unknown project/);
  assert.throws(
    () =>
      f.store.updateBacklog(entry.id, {
        projectId: "a",
        revision: 2,
        title: "Changed",
      }),
    /revision/,
  );
  const updated = f.store.updateBacklog(entry.id, {
    projectId: "a",
    revision: 1,
    title: "Changed",
  });
  assert.equal(updated.priority, 5);
  assert.deepEqual(updated.acceptanceCriteria, ["Works"]);
  assert.equal(updated.id, entry.id);
  assert.equal(updated.createdAt, entry.createdAt);
  assert.equal(updated.revision, 2);
  assert.throws(() => f.store.getBacklog(entry.id, "b"), /scope/);
  assert.equal(f.store.listBacklog("a").length, 1);
  const archived = f.store.archiveBacklog(entry.id, {
    projectId: "a",
    revision: 2,
  });
  assert.equal(archived.revision, 3);
  assert.throws(
    () => f.store.launchBacklog(entry.id, { projectId: "a", revision: 3 }),
    /pending/,
  );
  assert.deepEqual(executionState(f.db), before);
  assert.deepEqual(f.reopen().getBacklog(entry.id, "a"), archived);
});
test("launch derives trusted authority, rolls back all side effects, races and replays after restart", async (t) => {
  const f = await fixture(t),
    entry = f.store.addBacklog(input());
  const request = { projectId: "a", revision: 1 };
  const before = executionState(f.db);
  f.db.exec(
    "CREATE TRIGGER fail_backlog_launch BEFORE UPDATE ON control_backlog WHEN NEW.status='launched' BEGIN SELECT RAISE(ABORT,'injected launch failure'); END",
  );
  assert.throws(
    () => f.store.launchBacklog(entry.id, request),
    /injected launch/,
  );
  assert.deepEqual(executionState(f.db), before);
  assert.equal(f.store.getBacklog(entry.id, "a").status, "backlog");
  f.db.exec("DROP TRIGGER fail_backlog_launch");
  for (const mutate of [
    (c: typeof f.config) => {
      c.projects[0].enabled = false;
    },
    (c: typeof f.config) => {
      c.settings.authority.allowedExecutionModes = [];
    },
  ]) {
    const changed = structuredClone(f.config);
    mutate(changed);
    f.store.setting("configuration-snapshot", changed);
    assert.throws(
      () => f.store.launchBacklog(entry.id, request),
      /disabled|authorized/,
    );
    assert.deepEqual(executionState(f.db), before);
  }
  f.store.setting("configuration-snapshot", f.config);
  assert.throws(() =>
    f.store.launchBacklog(entry.id, { ...request, backend: { kind: "fake" } }),
  );
  const goals = await Promise.all(
    [1, 2].map(() =>
      Promise.resolve().then(() => f.store.launchBacklog(entry.id, request)),
    ),
  );
  assert.equal(goals[0].id, goals[1].id);
  assert.equal(f.db.query("SELECT * FROM control_goals").length, 1);
  assert.equal(f.db.query("SELECT * FROM control_jobs").length, 1);
  assert.equal(goals[0].config.backend.kind, "fake");
  assert.match(goals[0].config.description, /Acceptance criteria/);
  assert.throws(
    () => f.store.launchBacklog(entry.id, { ...request, revision: 2 }),
    /revision/,
  );
  assert.equal(f.reopen().launchBacklog(entry.id, request).id, goals[0].id);
});
test("dependency references reject unknown, cross-project and cyclic entries; only completed goals satisfy", async (t) => {
  const f = await fixture(t),
    first = f.store.addBacklog(input()),
    foreign = f.store.addBacklog(input("b"));
  assert.throws(() => f.store.addBacklog(input("a", ["unknown"])), /not found/);
  assert.throws(() => f.store.addBacklog(input("a", [foreign.id])), /scope/);
  assert.throws(
    () => f.store.addBacklog(input("a", [first.id, first.id])),
    /Duplicate/,
  );
  const next = f.store.addBacklog(input("a", [first.id]));
  assert.throws(
    () =>
      f.store.updateBacklog(first.id, {
        projectId: "a",
        revision: 1,
        dependencies: [next.id],
      }),
    /cycle/,
  );
  const req = { projectId: "a", revision: 1 };
  assert.throws(() => f.store.launchBacklog(next.id, req), /not completed/);
  const goal = f.store.launchBacklog(first.id, req);
  for (const status of ["running", "paused", "failed", "cancelled"]) {
    f.db.exec(
      `UPDATE control_goals SET status=${sql(status)} WHERE id=${sql(goal.id)}`,
    );
    assert.throws(() => f.store.launchBacklog(next.id, req), /not completed/);
  }
  f.db.exec(
    `UPDATE control_goals SET status='completed' WHERE id=${sql(goal.id)}`,
  );
  assert.ok(f.store.launchBacklog(next.id, req).id);
});
test("schema 6 migration advances ledger atomically and retries after failure", async (t) => {
  const f = await fixture(t);
  f.db.exec(
    "DROP TABLE control_backlog; DELETE FROM schema_migrations WHERE version>=7; PRAGMA user_version=6; CREATE TRIGGER fail_migration BEFORE INSERT ON schema_migrations WHEN NEW.version=7 BEGIN SELECT RAISE(ABORT,'injected migration'); END",
  );
  assert.throws(() => new ControlStore(f.db), /injected migration/);
  assert.equal(
    f.db.one<{ user_version: number }>("PRAGMA user_version")!.user_version,
    6,
  );
  assert.equal(
    f.db.one("SELECT name FROM sqlite_master WHERE name='control_backlog'"),
    null,
  );
  f.db.exec("DROP TRIGGER fail_migration");
  new ControlStore(f.db);
  assert.equal(
    f.db.one<{ user_version: number }>("PRAGMA user_version")!.user_version,
    8,
  );
  assert.deepEqual(
    f.db
      .query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      )
      .map((r) => r.version),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});
test("API enforces identity, stored project scope, dependencies and explicit revisions without changing drafts", async (t) => {
  const f = await fixture(t),
    hidden = f.store.addBacklog(input("b"));
  const token = provisionAutomation(f.store, {
    id: "agent",
    projectIds: ["a"],
    permissions: ["goals:read", "goals:create"],
  }).token;
  const readonly = provisionAutomation(f.store, {
    id: "reader",
    projectIds: ["a"],
    permissions: ["goals:read"],
  }).token;
  const server = createControlServer(f.store, {
    token: "synthetic-operator-backlog-tests",
    validateGoal: (body) =>
      effectiveGoal(f.config, body.projectId!, body.description, body),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  let n = 0;
  const req = (path: string, body?: unknown, credential = token) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `request-${++n}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal(
    (await req("/backlog?projectId=a", undefined, "invalid")).status,
    401,
  );
  assert.equal((await req("/backlog")).status, 400);
  assert.equal((await req("/backlog?projectId=b")).status, 403);
  assert.equal((await req(`/backlog/${hidden.id}?projectId=a`)).status, 403);
  for (const suffix of ["", "/archive", "/launch"])
    assert.equal(
      (
        await req(`/backlog/${hidden.id}${suffix}`, {
          projectId: "a",
          revision: 1,
        })
      ).status,
      403,
    );
  assert.equal((await req("/backlog", input("b"))).status, 403);
  assert.equal((await req("/backlog", input("a", [hidden.id]))).status, 403);
  assert.equal((await req("/backlog", input(), readonly)).status, 403);
  const before = executionState(f.db);
  const added = await req("/backlog", input());
  assert.equal(added.status, 200);
  const entry = (await added.json()) as BacklogEntry;
  assert.equal((await req(`/backlog/${entry.id}?projectId=a`)).status, 200);
  assert.equal(
    (
      await req(`/backlog/${entry.id}`, {
        projectId: "a",
        revision: 1,
        title: "Edited",
      })
    ).status,
    200,
  );
  assert.deepEqual(executionState(f.db), before);
  assert.equal(
    (await req(`/backlog/${entry.id}/launch`, { projectId: "a" })).status,
    400,
  );
  assert.equal(
    (await req(`/backlog/${entry.id}/launch`, { projectId: "a", revision: 1 }))
      .status,
    409,
  );
  assert.equal(
    (
      await req("/goal-drafts", {
        projectId: "a",
        description: "Draft",
        backend: { kind: "fake" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await req("/goal-drafts", { projectId: "a", description: "Draft" }))
      .status,
    200,
  );
  const launches = await Promise.all([
    req(`/backlog/${entry.id}/launch`, { projectId: "a", revision: 2 }),
    req(`/backlog/${entry.id}/launch`, { projectId: "a", revision: 2 }),
  ]);
  assert.deepEqual(
    launches.map((r) => r.status),
    [200, 200],
  );
  const goals = await Promise.all(
    launches.map((r) => r.json() as Promise<Goal>),
  );
  assert.equal(goals[0].id, goals[1].id);
});

test("draft, direct and backlog admission reject excessive pinned instructions without admitting work", async (t) => {
  const f = await fixture(t);
  const root = f.config.projects[0].config.repoPath!;
  await writeFile(join(root, "AGENTS.md"), "x".repeat(256001));
  const entry = f.store.addBacklog(input());
  const before = executionState(f.db);
  const server = createControlServer(f.store, {
    token: "synthetic-contract-preflight",
    validateGoal: (body) =>
      effectiveGoal(f.config, body.projectId!, body.description, body),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  for (const [path, body] of [
    ["/goal-drafts", { projectId: "a", description: "Draft" }],
    ["/goals", { projectId: "a", description: "Direct" }],
    [`/backlog/${entry.id}/launch`, { projectId: "a", revision: 1 }],
  ] as const) {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer synthetic-contract-preflight",
        "Content-Type": "application/json",
        "Idempotency-Key": path,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 409, await response.text());
    assert.deepEqual(executionState(f.db), before);
  }
  assert.equal(f.store.getBacklog(entry.id, "a").status, "backlog");
});

test("admission retries return stored goals after contract drift but reject changed requests and unauthorized callers", async (t) => {
  const f = await fixture(t);
  const root = f.config.projects[0].config.repoPath!;
  const server = createControlServer(f.store, {
    token: "synthetic-replay",
    validateGoal: (body) =>
      effectiveGoal(f.config, body.projectId!, body.description, body),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const request = (
    path: string,
    body: unknown,
    key: string,
    token = "synthetic-replay",
  ) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
  const body = { projectId: "a", description: "Direct" };
  const direct = await request("/goals", body, "direct");
  assert.equal(direct.status, 200);
  const goal = await direct.json();
  const entry = f.store.addBacklog(input());
  const launchPath = `/backlog/${entry.id}/launch`;
  const launchBody = { projectId: "a", revision: 1 };
  const launched = await request(launchPath, launchBody, "launch");
  assert.equal(launched.status, 200);
  const backlogGoal = await launched.json();
  await writeFile(join(root, "AGENTS.md"), "x".repeat(256001));
  assert.deepEqual(
    await (await request("/goals", body, "direct")).json(),
    goal,
  );
  assert.deepEqual(
    await (await request(launchPath, launchBody, "launch")).json(),
    backlogGoal,
  );
  const changed = await request(
    "/goals",
    { ...body, description: "Changed" },
    "direct",
  );
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error.code, "idempotency_conflict");
  const denied = await request("/goals", body, "direct", "invalid");
  assert.equal(denied.status, 401);
  await denied.text();
  assert.equal(f.store.goals().length, 2);
});
