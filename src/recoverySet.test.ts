import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { initializeConfiguration } from "./config.js";
import { initializeState } from "./instance.js";
import { SqliteStore } from "./sqlite.js";
import { ControlStore } from "./control/store.js";
import {
  authEnvironmentSchema,
  initializeAuthEnvironment,
  acquireAuthEnvironment,
  inspectAuthEnvironment,
} from "./control/authEnvironment.js";
import { createRecoverySet, restoreRecoverySet } from "./recoverySet.js";
import { acquireMatrixSnapshot } from "./matrixRecovery.js";
test("coordinated recovery encrypts application and auth identity, refuses owners/overwrite and restores into isolated paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-coordinated-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await initializeConfiguration(
    join(root, "config"),
    join(root, "application"),
    join(root, "private"),
  );
  await initializeState(config.settings.stateDir);
  await mkdir(config.settings.secretsDir, { mode: 0o700 });
  const auth = authEnvironmentSchema.parse({
    id: "synthetic",
    harness: "codex",
    imageDigest: "sha256:" + "a".repeat(64),
    sessionDir: "synthetic",
    egress: { hosts: ["provider.example"] },
  });
  config.auth = [auth];
  await initializeAuthEnvironment(auth, config.settings.secretsDir);
  const original = await inspectAuthEnvironment(
    auth,
    config.settings.secretsDir,
  );
  await writeFile(
    join(original.session, "auth.json"),
    "synthetic-private-session",
    { mode: 0o600 },
  );
  const db = new SqliteStore(
      join(config.settings.stateDir, "mission-control.db"),
      { mustExist: true },
    ),
    store = new ControlStore(db);
  t.after(() => db.close());
  store.setting("configuration-snapshot", config);
  store.createGoal({
    title: "Synthetic unfinished",
    description: "Synthetic",
    repoPath: root,
  });
  const key = join(root, "identity"),
    recipient = join(root, "recipient"),
    bundle = join(root, "recovery.age"),
    exec = promisify(execFile);
  await exec("age-keygen", ["-o", key]);
  await writeFile(recipient, (await exec("age-keygen", ["-y", key])).stdout, {
    mode: 0o600,
  });
  const owner = await acquireAuthEnvironment(auth, config.settings.secretsDir);
  await assert.rejects(
    createRecoverySet(store, config, bundle, recipient),
    /writer/,
  );
  await owner.release();
  const existing = join(root, "existing");
  await writeFile(existing, "retain me");
  await assert.rejects(
    createRecoverySet(store, config, existing, recipient),
    /new/,
  );
  assert.equal(await readFile(existing, "utf8"), "retain me");
  const result = await createRecoverySet(store, config, bundle, recipient);
  assert.equal(result.authStores, 1);
  assert.equal(result.qualified, false);
  assert.ok(
    !(await readFile(bundle)).includes(
      Buffer.from("synthetic-private-session"),
    ),
  );
  assert.equal(
    (await inspectAuthEnvironment(auth, config.settings.secretsDir)).writer,
    undefined,
  );
  const restored = join(root, "restored");
  const receipt = await restoreRecoverySet(config, bundle, key, restored);
  assert.equal(receipt.servicesStarted, false);
  assert.equal(receipt.authStores, 1);
  const next = await inspectAuthEnvironment(
    auth,
    join(restored, "authentication"),
  );
  assert.equal(next.identity.instance, original.identity.instance);
  assert.equal(
    await readFile(join(next.session, "auth.json"), "utf8"),
    "synthetic-private-session",
  );
  assert.equal(
    (await stat(join(next.session, "auth.json"))).mode & 0o777,
    0o600,
  );
  await assert.rejects(
    restoreRecoverySet(config, bundle, key, restored),
    /new/,
  );
  const restoredDb = new SqliteStore(
    join(restored, "application/mission-control.db"),
    { mustExist: true },
  );
  try {
    const r = new ControlStore(restoredDb);
    assert.equal(r.goals()[0].config.title, "Synthetic unfinished");
    assert.equal(restoredDb.integrityCheck()[0], "ok");
  } finally {
    restoredDb.close();
  }
  await assert.rejects(
    restoreRecoverySet(
      { ...config, hash: "f".repeat(64) },
      bundle,
      key,
      join(root, "wrong"),
    ),
    /configuration/,
  );
  assert.equal(
    JSON.parse(await readFile(join(root, "wrong/restore-status.json"), "utf8"))
      .restored,
    false,
  );
});
test("Matrix snapshot coordinator holds native ownership until explicit release and detects lost process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-matrix-held-wrapper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config.json"),
    binary = join(root, "companion");
  const input = {
    homeserver: "https://example.invalid",
    room_id: "!synthetic:example.invalid",
    own_user: "@synthetic:example.invalid",
    own_device: "SYNTHETIC",
    allowed_users: [],
    state_dir: join(root, "store"),
    session_file: join(root, "session"),
    passphrase_file: join(root, "passphrase"),
    controller_url: "http://127.0.0.1:43201",
    controller_token_file: join(root, "control"),
  };
  await writeFile(config, JSON.stringify(input), { mode: 0o600 });
  await writeFile(
    binary,
    `#!/usr/bin/env node\nconst fs=require('node:fs');const [action,path,destination]=process.argv.slice(2);if(action!=='snapshot-held')process.exit(1);fs.mkdirSync(destination,{mode:448});fs.writeFileSync(destination+'/recovery-identity.json',JSON.stringify({homeserver:'https://example.invalid/',user:'@synthetic:example.invalid',device:'SYNTHETIC',room:'!synthetic:example.invalid'}));console.log(JSON.stringify({snapshotPrepared:true,ownershipHeld:true}));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`,
    { mode: 0o700 },
  );
  const owner = await acquireMatrixSnapshot(config, binary);
  owner.assertHeld();
  assert.ok((await stat(owner.snapshot)).isDirectory());
  await owner.release();
  assert.throws(owner.assertHeld, /lost/);
});
