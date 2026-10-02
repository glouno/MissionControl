import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  backupPolicySchema,
  resolveBackupPolicy,
  prepareBackupServices,
  runScheduledBackup,
  validateBackupDestination,
} from "./backupPolicy.js";
import { initializeState } from "./instance.js";
import { SqliteStore } from "./sqlite.js";
import { createBackup, restoreBackup } from "./backup.js";
import type { ControlClient } from "./control/client.js";
test("daily backup preparation stays disabled, checks explicit destinations and records unverified encrypted recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-daily-backup-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  assert.equal(backupPolicySchema.parse({}).enabled, false);
  assert.throws(
    () => backupPolicySchema.parse({ enabled: true }),
    /destinationDir/,
  );
  assert.throws(
    () =>
      resolveBackupPolicy(
        backupPolicySchema.parse({ destinationDir: "nested" }),
        root,
        join(root, "state"),
        join(root, "secrets"),
      ),
    /separate/,
  );
  const state = join(root, "state"),
    backups = join(root, "backups"),
    recipient = join(root, "recipient"),
    identity = join(root, "age.key");
  await initializeState(state);
  await mkdir(backups, { mode: 0o700 });
  await promisify(execFile)("age-keygen", ["-o", identity]);
  await writeFile(
    recipient,
    (await promisify(execFile)("age-keygen", ["-y", identity])).stdout,
    { mode: 0o600 },
  );
  const policy = backupPolicySchema.parse({
      enabled: true,
      destinationDir: backups,
      recipientFile: recipient,
      hourUtc: 4,
    }),
    db = new SqliteStore(join(state, "mission-control.db"), {
      mustExist: true,
    });
  t.after(() => db.close());
  const client = {
    request: async (path: string, method: string, args: any) => {
      assert.equal(path, "/backups");
      assert.equal(method, "POST");
      assert.equal(args.complete, true);
      return createBackup(
        db,
        state,
        args.destination,
        args.recipientFile,
        true,
      );
    },
  } as ControlClient;
  await assert.rejects(
    runScheduledBackup(client, { ...policy, enabled: false }),
    /disabled/,
  );
  const prepared = await prepareBackupServices(
    join(root, "config & private $HOME"),
    policy,
    join(root, "prepared"),
    "linux",
    "/installed/node",
    "/installed/cli.js",
  );
  assert.equal(prepared.enabled, false);
  const timer = await readFile(
    join(root, "prepared/mission-control-v1-backup.timer"),
    "utf8",
  );
  assert.match(timer, /04:00:00 UTC/);
  const service = await readFile(
    join(root, "prepared/mission-control-v1-backup.service"),
    "utf8",
  );
  assert.match(service, /UMask=0077/);
  assert.ok(service.includes("$$HOME"));
  assert.ok(!service.includes(identity));
  assert.ok(!service.includes("43190"));
  const mac = await prepareBackupServices(
    join(root, "config & private $HOME"),
    policy,
    join(root, "prepared-mac"),
    "darwin",
    "/installed/node",
    "/installed/cli.js",
  );
  assert.equal(mac.enabled, false);
  assert.match(
    await readFile(
      join(root, "prepared-mac/org.missioncontrol.v1.backup.plist"),
      "utf8",
    ),
    /config &amp; private/,
  );
  await runScheduledBackup(client, policy);
  const names = await readdir(backups),
    bundle = names.find((n) => n.endsWith(".age"))!;
  const receipt = JSON.parse(
    await readFile(
      join(
        backups,
        names.find((n) => n.endsWith("receipt.json"))!,
      ),
      "utf8",
    ),
  );
  assert.equal(receipt.restoreVerified, false);
  assert.equal(receipt.pinned, true);
  await restoreBackup(join(backups, bundle), identity, join(root, "restore"));
  await symlink(backups, join(root, "redirect"));
  await assert.rejects(
    validateBackupDestination({
      ...policy,
      destinationDir: join(root, "redirect"),
    }),
    /canonical/,
  );
});
