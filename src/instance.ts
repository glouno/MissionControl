import {
  mkdir,
  lstat,
  realpath,
  writeFile,
  readFile,
  open,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { SqliteStore } from "./sqlite.js";
import { ControlStore } from "./control/store.js";

export async function initializeState(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory() || info.mode & 0o077)
    throw new Error("State root must be a private non-symlink directory");
  for (const name of [
    "instance.json",
    "mission-control.db",
    "controller.lock",
  ]) {
    const existing = await lstat(join(root, name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing)
      throw new Error("EEXIST: initialization requires fresh state");
  }
  const identity = {
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    join(root, "instance.json"),
    JSON.stringify(identity) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const db = new SqliteStore(join(root, "mission-control.db"));
  try {
    new ControlStore(db).setting("instance-identity", identity);
  } finally {
    db.close();
  }
  return identity;
}
export async function inspectState(root: string) {
  const path = resolve(root),
    info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (await realpath(path)) !== path
  )
    throw new Error("State directory must be canonical and private");
  const identity = JSON.parse(
    await readFile(join(path, "instance.json"), "utf8"),
  );
  if (identity.schemaVersion !== 1 || typeof identity.id !== "string")
    throw new Error("Unsupported instance identity");
  const db = new SqliteStore(join(path, "mission-control.db"), {
    mustExist: true,
    readOnly: true,
  });
  try {
    const schemaVersion = Number(
      db.one<{ user_version: number }>("PRAGMA user_version")?.user_version,
    );
    if (![1, 2, 3, 4, 5, 6].includes(schemaVersion))
      throw new Error("Unsupported database schema");
    const ledger = db
      .query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      )
      .map((r) => Number(r.version));
    if (
      JSON.stringify(ledger) !==
      JSON.stringify(Array.from({ length: schemaVersion }, (_, i) => i + 1))
    )
      throw new Error("Migration ledger differs from schema version");
    const recorded = db.one<{ value: string }>(
      "SELECT value FROM control_settings WHERE key='instance-identity'",
    );
    if (!recorded || JSON.parse(recorded.value).id !== identity.id)
      throw new Error("Database instance identity differs from state root");
    if (db.query("PRAGMA foreign_key_check").length)
      throw new Error("Database foreign key check failed");
    const integrity = db.integrityCheck();
    if (integrity.join() !== "ok")
      throw new Error("Database integrity check failed");
    return { ...identity, schemaVersion, integrity };
  } finally {
    db.close();
  }
}
export async function lockInstance(root: string) {
  const path = join(root, "controller.lock"),
    nonce = randomUUID();
  if (await lstat(join(root, "lock-recovery.lock")).catch(() => null))
    throw new Error("Instance lock recovery is in progress");
  // A stale lock is deliberately not removed automatically: PID reuse and
  // concurrent start races must not grant a second controller authority.
  const file = await open(path, "wx", 0o600).catch(() => {
    throw new Error(
      "Instance is locked; inspect the owner before recovering a stale controller lock",
    );
  });
  await file.writeFile(
    JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      nonce,
      createdAt: new Date().toISOString(),
    }),
  );
  await file.sync();
  await file.close();
  if (await lstat(join(root, "lock-recovery.lock")).catch(() => null)) {
    await unlink(path);
    throw new Error("Instance lock recovery is in progress");
  }

  return async () => {
    const current = JSON.parse(await readFile(path, "utf8"));
    if (current.nonce !== nonce)
      throw new Error("Controller lock ownership changed");
    await unlink(path);
  };
}

/** Explicit recovery is permitted only for a dead PID on the same host and nonce. */
export async function recoverInstanceLock(root: string, expectedNonce: string) {
  await inspectState(root);
  const guardPath = join(root, "lock-recovery.lock"),
    guard = await open(guardPath, "wx", 0o600);
  try {
    const path = join(root, "controller.lock"),
      info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.mode & 0o077)
      throw new Error("Controller lock must be private and regular");
    const owner = JSON.parse(await readFile(path, "utf8"));
    if (
      owner.nonce !== expectedNonce ||
      owner.hostname !== hostname() ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1
    )
      throw new Error(
        "Lock owner or recovery nonce differs; explicit local inspection required",
      );
    try {
      process.kill(owner.pid, 0);
      throw new Error("Controller owner is still alive; stop it explicitly");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await unlink(path);
    return { recovered: true, previousOwner: owner.pid };
  } finally {
    await guard.close();
    await unlink(guardPath);
  }
}
