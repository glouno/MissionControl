import "./canonical-temp.mjs";
// Offline invented SDK identity only; no homeserver login or sync.
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  chmod,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import {
  backupMatrixStore,
  restoreMatrixStore,
  acquireMatrixSnapshot,
} from "../dist/matrixRecovery.js";
import { createRecoverySet, restoreRecoverySet } from "../dist/recoverySet.js";
import { initializeConfiguration } from "../dist/config.js";
import { initializeState } from "../dist/instance.js";
import { SqliteStore } from "../dist/sqlite.js";
import { ControlStore } from "../dist/control/store.js";
const exec = promisify(execFile),
  root = await mkdtemp(join(tmpdir(), "mc-matrix-recovery-proof-")),
  manifest = resolve("connectors/matrix/Cargo.toml");
process.umask(0o077);
try {
  await exec(
    "cargo",
    [
      "test",
      "--locked",
      "--manifest-path",
      manifest,
      "offline_snapshot_retains_sdk_keys_cursor_fault_and_refuses_an_active_writer",
    ],
    {
      env: { ...process.env, MISSIONCONTROL_MATRIX_RECOVERY_FIXTURE: root },
      timeout: 120000,
    },
  );
  await exec("cargo", ["build", "--locked", "--manifest-path", manifest], {
    timeout: 120000,
  });
  const binary = resolve(
      "connectors/matrix/target/debug/missioncontrol-matrix",
    ),
    config = join(root, "config.json"),
    identity = join(root, "age.key"),
    recipient = join(root, "recipient"),
    bundle = join(root, "crypto.age");
  await exec("age-keygen", ["-o", identity]);
  await writeFile(
    recipient,
    (await exec("age-keygen", ["-y", identity])).stdout,
    { mode: 0o600 },
  );
  const held = await acquireMatrixSnapshot(config, binary);
  try {
    held.assertHeld();
    await assert.rejects(
      backupMatrixStore(config, binary, join(root, "blocked.age"), recipient),
    );
  } finally {
    await held.release();
  }
  const backup = await backupMatrixStore(config, binary, bundle, recipient);
  assert.equal(backup.backedUp, true);
  const bytes = await readFile(bundle);
  assert.equal(
    bytes.includes(Buffer.from("synthetic-not-a-real-token")),
    false,
  );
  const restored = await restoreMatrixStore(
    config,
    binary,
    bundle,
    identity,
    join(root, "restored"),
  );
  assert.equal(restored.sdkInspected, true);
  assert.equal(restored.liveQualified, false);
  assert.equal(
    JSON.parse(await readFile(join(root, "restored/store/inbox.json"), "utf8"))
      .trust_fault,
    true,
  );
  await assert.rejects(
    restoreMatrixStore(
      config,
      binary,
      bundle,
      identity,
      join(root, "restored"),
    ),
    /new/,
  );
  const app = await initializeConfiguration(
    join(root, "app-config"),
    join(root, "app-state"),
    join(root, "app-secrets"),
  );
  await initializeState(app.settings.stateDir);
  await mkdir(app.settings.secretsDir, { mode: 0o700 });
  app.connectors = [
    {
      id: "synthetic",
      kind: "matrix",
      enabled: false,
      bindings: [],
      settings: { binary, companionConfig: config, verified: false },
    },
  ];
  const db = new SqliteStore(
    join(app.settings.stateDir, "mission-control.db"),
    { mustExist: true },
  );
  try {
    const set = await createRecoverySet(
      new ControlStore(db),
      app,
      join(root, "coordinated.age"),
      recipient,
    );
    assert.equal(set.matrixStores, 1);
    const restoredSet = await restoreRecoverySet(
      app,
      join(root, "coordinated.age"),
      identity,
      join(root, "coordinated-restored"),
    );
    assert.equal(restoredSet.matrixStores, 1);
    assert.equal(restoredSet.servicesStarted, false);
    assert.equal(
      JSON.parse(
        await readFile(
          join(root, "coordinated-restored/matrix/synthetic/store/inbox.json"),
          "utf8",
        ),
      ).trust_fault,
      true,
    );
  } finally {
    db.close();
  }
  console.log(
    JSON.stringify({
      passed: true,
      heldOwnershipRefusesConcurrentSnapshot: true,
      coordinatedApplicationMatrixRestore: true,
      offlineSyntheticIdentity: true,
      encryptedBundle: true,
      sdkReopened: true,
      pendingTrustFaultPreserved: true,
      liveQualified: false,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
