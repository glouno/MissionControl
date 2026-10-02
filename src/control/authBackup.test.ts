import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import {
  authEnvironmentSchema,
  initializeAuthEnvironment,
  acquireAuthEnvironment,
  inspectAuthEnvironment,
} from "./authEnvironment.js";
import { backupAuthStore, restoreAuthStore } from "./authBackup.js";
test("dedicated auth backup encrypts sessions, retains identity, rejects active writers and restores only into new admitted store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-auth-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = join(root, "secrets"),
    fresh = join(root, "fresh");
  await mkdir(secrets, { mode: 0o700 });
  await mkdir(fresh, { mode: 0o700 });
  const config = authEnvironmentSchema.parse({
    id: "synthetic",
    harness: "codex",
    imageDigest: "sha256:" + "a".repeat(64),
    sessionDir: "synthetic",
    egress: { hosts: ["example.invalid"] },
  });
  await initializeAuthEnvironment(config, secrets);
  const info = await inspectAuthEnvironment(config, secrets),
    sessionContent = "synthetic-session-sensitive";
  await writeFile(join(info.session, "auth.json"), sessionContent, {
    mode: 0o600,
  });
  await mkdir(join(info.session, "empty"), { mode: 0o700 });
  await symlink("/unavailable", join(info.session, "tmp/temporary-wrapper"));
  const db = new SqliteStore(join(root, "db"));
  t.after(() => db.close());
  const store = new ControlStore(db),
    identity = join(root, "age.key"),
    recipient = join(root, "recipient"),
    bundle = join(root, "auth.age");
  await promisify(execFile)("age-keygen", ["-o", identity]);
  await writeFile(
    recipient,
    (await promisify(execFile)("age-keygen", ["-y", identity])).stdout,
    { mode: 0o600 },
  );
  const owner = await acquireAuthEnvironment(config, secrets);
  await assert.rejects(
    backupAuthStore(store, config, secrets, bundle, recipient),
    /writer/,
  );
  await owner.release();
  store.setting("subscription-auth-runs", [
    { authId: config.id, status: "active" },
  ]);
  await assert.rejects(
    backupAuthStore(store, config, secrets, bundle, recipient),
    /containers/,
  );
  store.setting("subscription-auth-runs", []);
  const result = await backupAuthStore(
    store,
    config,
    secrets,
    bundle,
    recipient,
  );
  assert.equal(result.storeInstance, info.identity.instance);
  assert.equal(
    (await readFile(bundle)).includes(Buffer.from(sessionContent)),
    false,
  );
  const wrong = { ...config, id: "other" };
  await assert.rejects(
    restoreAuthStore(store, wrong, fresh, bundle, identity),
    /identity/,
  );
  await assert.rejects(
    restoreAuthStore(store, config, secrets, bundle, identity),
    /new/,
  );
  const restored = await restoreAuthStore(
    store,
    config,
    fresh,
    bundle,
    identity,
  );
  assert.equal(restored.storeInstance, info.identity.instance);
  const next = await inspectAuthEnvironment(config, fresh);
  assert.equal(next.writer, undefined);
  assert.equal(
    await readFile(join(next.session, "auth.json"), "utf8"),
    sessionContent,
  );
  assert.ok((await stat(join(next.session, "empty"))).isDirectory());
  assert.ok((await stat(join(next.session, "tmp"))).isDirectory());
  assert.equal(
    (await stat(join(next.session, "auth.json"))).mode & 0o777,
    0o600,
  );
  await symlink("/unavailable", join(info.session, "redirect"));
  await assert.rejects(
    backupAuthStore(store, config, secrets, join(root, "bad.age"), recipient),
    /entries/,
  );
});
