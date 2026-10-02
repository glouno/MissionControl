import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeState } from "./instance.js";
import { SqliteStore } from "./sqlite.js";
import { ControlStore } from "./control/store.js";
import { createBackup } from "./backup.js";
import { runScheduledBackup, backupPolicySchema } from "./backupPolicy.js";
import {
  verifyBackupReceipt,
  pinBackupReceipt,
  pruneBackups,
} from "./backupRetention.js";
import type { ControlClient } from "./control/client.js";
test("retention requires isolated restore, explicit unpin and newer verified copy; unregistered files stay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state"),
    backups = join(root, "backups"),
    identity = join(root, "age.key"),
    recipient = join(root, "recipient");
  await initializeState(state);
  await mkdir(backups, { mode: 0o700 });
  await promisify(execFile)("age-keygen", ["-o", identity]);
  await writeFile(
    recipient,
    (await promisify(execFile)("age-keygen", ["-y", identity])).stdout,
    { mode: 0o600 },
  );
  const db = new SqliteStore(join(state, "mission-control.db"), {
    mustExist: true,
  });
  t.after(() => db.close());
  const client = {
    request: async (_p: string, _m: string, args: any) =>
      createBackup(db, state, args.destination, args.recipientFile, true),
  } as ControlClient;
  const policy = backupPolicySchema.parse({
    enabled: true,
    destinationDir: backups,
    recipientFile: recipient,
  });
  await runScheduledBackup(client, policy);
  await runScheduledBackup(client, policy);
  const receipts = (await readdir(backups))
    .filter((n) => n.endsWith("receipt.json"))
    .sort()
    .map((n) => join(backups, n));
  await writeFile(
    join(backups, "unregistered.age"),
    "Synthetic retained file",
    { mode: 0o600 },
  );
  assert.equal(
    (await pruneBackups(backups)).actions.some((a) => a.eligible),
    false,
  );
  await assert.rejects(pinBackupReceipt(receipts[0], false), /Unverified/);
  await verifyBackupReceipt(receipts[0], identity);
  await pinBackupReceipt(receipts[0], false);
  assert.equal(
    (await pruneBackups(backups)).actions.some((a) => a.eligible),
    false,
  );
  await verifyBackupReceipt(receipts[1], identity);
  const secondReceipt = await readFile(receipts[1], "utf8");
  const missingRecords = JSON.parse(secondReceipt);
  missingRecords.recoveryRecords = undefined;
  await writeFile(receipts[1], JSON.stringify(missingRecords), { mode: 0o600 });
  assert.equal(
    (await pruneBackups(backups)).actions.some((a) => a.eligible),
    false,
  );
  await writeFile(receipts[1], secondReceipt, { mode: 0o600 });
  const preview = await pruneBackups(backups);
  assert.equal(preview.actions.filter((a) => a.eligible).length, 1);
  assert.equal(preview.removed.length, 0);
  const pruned = await pruneBackups(backups, true);
  assert.equal(pruned.removed.length, 1);
  assert.equal(
    (await readdir(backups)).filter((n) => n.endsWith("receipt.json")).length,
    1,
  );
  assert.equal(
    await readFile(join(backups, "unregistered.age"), "utf8"),
    "Synthetic retained file",
  );
  const remaining = JSON.parse(await readFile(receipts[1], "utf8"));
  const journal = join(backups, ".prune-synthetic.json");
  await writeFile(journal, "{}", { mode: 0o600 });
  await assert.rejects(
    pruneBackups(backups, true),
    /Interrupted backup deletion/,
  );
  await rm(journal);
  remaining.bundle = "../escape.age";
  await writeFile(receipts[1], JSON.stringify(remaining), { mode: 0o600 });
  await assert.rejects(pruneBackups(backups));
  await writeFile(receipts[1], secondReceipt, { mode: 0o600 });
  new ControlStore(db).createGoal({
    title: "Unfinished synthetic",
    description: "Preserve recovery",
    repoPath: root,
    backend: { kind: "fake" },
  });
  await runScheduledBackup(client, policy);
  const unfinished = (await readdir(backups))
    .filter((n) => n.endsWith("receipt.json"))
    .sort()
    .at(-1)!;
  await verifyBackupReceipt(join(backups, unfinished), identity);
  await assert.rejects(
    pinBackupReceipt(join(backups, unfinished), false),
    /unfinished/,
  );
});
