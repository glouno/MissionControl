import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { SqliteStore, registryDatabase } from "./sqlite.js";
import {
  initializeState,
  inspectState,
  lockInstance,
  recoverInstanceLock,
} from "./instance.js";
import { ControlStore } from "./control/store.js";
test("fresh instance refuses concurrent ownership and inspection never creates missing state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-instance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(inspectState(join(root, "missing")));
  assert.deepEqual(await readdir(root), []);
  const state = join(root, "state");
  const identity = await initializeState(state);
  assert.equal((await inspectState(state)).id, identity.id);
  const unlock = await lockInstance(state);
  await assert.rejects(lockInstance(state), /locked/);
  await unlock();
  const unlockAgain = await lockInstance(state);
  await unlockAgain();
  await assert.rejects(initializeState(state), /EEXIST/);
});
test("pre-v1 and future databases are refused, registry tables share application state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = new SqliteStore(join(root, "legacy.db"));
  legacy.exec("CREATE TABLE missions(id TEXT)");
  assert.throws(() => new ControlStore(legacy), /Pre-v1/);
  legacy.close();
  const future = new SqliteStore(join(root, "future.db"));
  future.exec("PRAGMA user_version=99");
  assert.throws(() => new ControlStore(future), /newer/);
  future.close();
  const state = join(root, "state");
  await initializeState(state);
  await mkdir(join(state, "sandbox"));
  assert.throws(
    () => registryDatabase(join(state, "sandbox"), "execution-registry.db"),
    /controller-owned database/,
  );
  assert.deepEqual(await readdir(join(state, "sandbox")), []);
});
test("failed transactional changes roll back and online backups contain committed data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-sqlite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new SqliteStore(join(root, "source.db"));
  try {
    db.exec("CREATE TABLE sample(value TEXT)");
    assert.throws(() =>
      db.transaction(() => {
        db.exec("INSERT INTO sample VALUES('lost')");
        throw new Error("crash");
      }),
    );
    assert.equal(db.query("SELECT * FROM sample").length, 0);
    db.transaction(() => db.exec("INSERT INTO sample VALUES('committed')"));
    const target = join(root, "backup.db");
    await db.backup(target);
    await assert.rejects(db.backup(target), /new/);
    const restored = new SqliteStore(target, {
      mustExist: true,
      readOnly: true,
    });
    assert.deepEqual(restored.integrityCheck(), ["ok"]);
    assert.equal(restored.one("SELECT * FROM sample")?.value, "committed");
    restored.close();
  } finally {
    db.close();
  }
});

test("stale lock recovery refuses living owners, wrong nonces and foreign hosts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-lock-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeState(root);
  const unlock = await lockInstance(root),
    path = join(root, "controller.lock"),
    owner = JSON.parse(await readFile(path, "utf8"));
  await assert.rejects(recoverInstanceLock(root, owner.nonce), /still alive/);
  await unlock();
  const stale = {
    pid: 2147483647,
    hostname: hostname(),
    nonce: "synthetic-recovery",
    createdAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(stale), { mode: 0o600 });
  await assert.rejects(recoverInstanceLock(root, "wrong"), /nonce/);
  await writeFile(path, JSON.stringify({ ...stale, hostname: "another-host" }));
  await assert.rejects(
    recoverInstanceLock(root, stale.nonce),
    /local inspection/,
  );
  await writeFile(path, JSON.stringify(stale));
  assert.equal((await recoverInstanceLock(root, stale.nonce)).recovered, true);
  const release = await lockInstance(root);
  await release();
  const db = new SqliteStore(join(root, "mission-control.db"));
  new ControlStore(db).setting("instance-identity", { id: "wrong" });
  db.close();
  await assert.rejects(inspectState(root), /identity differs/);
});

test("instance artifacts record relative paths and reject traversal and symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state");
  await initializeState(state);
  const db = new SqliteStore(join(state, "mission-control.db")),
    store = new ControlStore(db);
  t.after(() => db.close());
  const goal = store.createGoal({
    title: "Synthetic",
    description: "Synthetic",
    repoPath: root,
    backend: { kind: "fake" },
  });
  const file = join(state, "evidence.txt");
  await writeFile(file, "Synthetic evidence");
  store.artifact(goal.id, undefined, "evidence", file);
  assert.equal(
    db.one("SELECT location FROM control_artifacts")?.location,
    "evidence.txt",
  );
  await writeFile(join(root, "outside.txt"), "Private");
  assert.throws(
    () => store.artifact(goal.id, undefined, "evidence", "../outside.txt"),
    /inside instance/,
  );
  const { symlink } = await import("node:fs/promises");
  await symlink(file, join(state, "link"));
  assert.throws(
    () => store.artifact(goal.id, undefined, "evidence", join(state, "link")),
    /symlink/,
  );
});

test("controller redaction also covers execution registries and filesystem checkpoints/reports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-shared-redaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeState(root);
  const db = new SqliteStore(join(root, "mission-control.db"), {
    mustExist: true,
  });
  t.after(() => db.close());
  const store = new ControlStore(db);
  store.redactor.register("synthetic-private-secret");
  const { EnvironmentRegistry } = await import("./control/environments.js"),
    { WorkspaceManager } = await import("./control/workspaces.js");
  const registry = new EnvironmentRegistry(join(root, "sandbox"), db);
  registry.save({
    id: "execution",
    taskId: "task",
    generation: 1,
    path: join(root, "sandbox/execution/repo"),
    baseSha: "a".repeat(40),
    image: "sha256:" + "b".repeat(64),
    status: "checkpointed",
    createdAt: 0,
    lastActivityAt: 0,
    spec: { invocationId: "run", taskId: "task", generation: 1 },
    completion: {
      outcome: "verified",
      commit: "a".repeat(40),
      recordedAt: 0,
      evidence: {
        output: "contains synthetic-private-secret",
        access_token: "synthetic-private-secret",
      },
    },
  } as any);
  assert.ok(
    !JSON.stringify(registry.get("execution")).includes(
      "synthetic-private-secret",
    ),
  );
  const path = await new WorkspaceManager(root, db).report(
    { id: "goal" } as any,
    {
      output: "contains synthetic-private-secret",
      password: "synthetic-private-secret",
    },
  );
  assert.ok(
    !(await readFile(path, "utf8")).includes("synthetic-private-secret"),
  );
});

test("migration failure preserves its prior ledger/schema and retries transactionally", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-migration-fault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new SqliteStore(join(root, "db"));
  t.after(() => db.close());
  new ControlStore(db);
  db.exec(
    "DELETE FROM schema_migrations WHERE version>=4; DROP TABLE usage_reconciliations; DROP TABLE control_attempts; PRAGMA user_version=3; CREATE TRIGGER inject_migration_failure BEFORE INSERT ON schema_migrations WHEN NEW.version=4 BEGIN SELECT RAISE(ABORT,'injected migration failure'); END;",
  );
  assert.throws(() => new ControlStore(db), /injected migration/);
  assert.equal(
    db.one<{ user_version: number }>("PRAGMA user_version")!.user_version,
    3,
  );
  assert.deepEqual(
    db
      .query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      )
      .map((r) => r.version),
    [1, 2, 3],
  );
  db.exec("DROP TRIGGER inject_migration_failure");
  new ControlStore(db);
  assert.equal(
    db.one<{ user_version: number }>("PRAGMA user_version")!.user_version,
    6,
  );
  assert.equal(db.integrityCheck()[0], "ok");
});
