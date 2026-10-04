import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeState, inspectState, lockInstance } from "./instance.js";
import { ControlStore } from "./control/store.js";
import { SqliteStore } from "./sqlite.js";
import {
  createBackup,
  restoreBackup,
  assertQuiescentBackup,
} from "./backup.js";
test(
  "encrypted complete backup restores into new isolated state with hashes and rejects overwrite/corruption",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mc-backup-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = join(root, "state"),
      id = await initializeState(state),
      unlock = await lockInstance(state);
    await mkdir(join(state, "evidence"));
    await writeFile(
      join(state, "evidence/example.txt"),
      "Synthetic private evidence",
    );
    await writeFile(join(state, "evidence/check.sh"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    });
    const identity = join(root, "identity.txt");
    await promisify(execFile)("age-keygen", ["-o", identity]);
    const publicKey = (
        await promisify(execFile)("age-keygen", ["-y", identity])
      ).stdout.trim(),
      recipient = join(root, "recipient.txt");
    await writeFile(recipient, publicKey);
    const db = new SqliteStore(join(state, "mission-control.db"), {
        mustExist: true,
      }),
      backup = join(root, "complete.age");
    try {
      const store = new ControlStore(db);
      store.setProject(
        {
          id: "backlog-fixture",
          name: "Backlog",
          family: "fixture",
          enabled: false,
          config: { title: "Fixture", description: "Fixture", repoPath: root },
        },
        "operator",
      );
      const backlog = store.addBacklog({
        projectId: "backlog-fixture",
        title: "Restore work",
        description: "Durable pending work",
      });
      db.exec(
        `INSERT INTO sessions VALUES('synthetic','task',1,'{"container":"synthetic","status":"active"}')`,
      );
      assert.throws(() => assertQuiescentBackup(db), /reconciled/);
      await assert.rejects(
        createBackup(db, state, join(root, "active.age"), recipient, true),
        /reconciled/,
      );
      db.exec("DELETE FROM sessions");
      const manifest = await createBackup(db, state, backup, recipient, true);
      assert.equal(manifest.instanceId, id.id);
      assert.equal(manifest.complete, true);
      assert.equal(manifest.schemaVersion, 7);
      assert.equal(
        (await readFile(backup)).includes(
          Buffer.from("Synthetic private evidence"),
        ),
        false,
      );
      const restore = join(root, "restored");
      await restoreBackup(backup, identity, restore);
      assert.equal((await inspectState(restore)).id, id.id);
      assert.equal((await inspectState(restore)).schemaVersion, 7);
      const restoredDb = new SqliteStore(join(restore, "mission-control.db"));
      try {
        assert.deepEqual(
          new ControlStore(restoredDb).getBacklog(
            backlog.id,
            "backlog-fixture",
          ),
          backlog,
        );
      } finally {
        restoredDb.close();
      }
      assert.equal(
        await readFile(join(restore, "evidence/example.txt"), "utf8"),
        "Synthetic private evidence",
      );
      assert.equal(
        (await stat(join(restore, "evidence/check.sh"))).mode & 0o777,
        0o700,
      );
      assert.equal(
        (await stat(join(restore, "evidence/example.txt"))).mode & 0o777,
        0o600,
      );
      await assert.rejects(restoreBackup(backup, identity, restore), /new/);
      const corrupt = join(root, "corrupt.age"),
        bytes = await readFile(backup);
      bytes[bytes.length - 10] ^= 0xff;
      await writeFile(corrupt, bytes);
      await assert.rejects(restoreBackup(corrupt, identity, join(root, "bad")));
      await assert.rejects(
        createBackup(db, state, backup, recipient, true),
        /new/,
      );
      await symlink(
        join(state, "evidence/example.txt"),
        join(state, "redirect"),
      );
      await assert.rejects(
        createBackup(db, state, join(root, "redirect.age"), recipient, true),
        /symlink/,
      );
    } finally {
      db.close();
      await unlock();
    }
  },
);
