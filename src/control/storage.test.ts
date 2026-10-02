import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageManager, storageDefaults } from "./storage.js";
import { git } from "./git.js";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-storage-")),
    managed = join(root, "managed"),
    path = join(managed, "workspaces", "one");
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-b", "task"]);
  await writeFile(join(path, "source"), "source\n");
  await writeFile(join(path, ".gitignore"), "ignored\n.env\n");
  await git(path, ["add", "."]);
  await git(path, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "source",
  ]);
  const head = await git(path, ["rev-parse", "HEAD"]);
  const storage = new StorageManager(managed, join(root, "recovery"));
  t.after(async () => {
    storage.db.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = storage.register({
    id: "workspace_one",
    goalId: "goal",
    path,
    baseSha: head,
    headSha: head,
    generation: 1,
    status: "waiting",
    lastActivityAt: Date.now(),
    unfinished: true,
  });
  return { root, path, storage, workspace };
}
test("unclassified artifacts and active work block archive; verified bundle restores source and classified files", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.path, "ignored"), "retained\n");
  await writeFile(join(f.path, ".env"), "secret-do-not-archive");
  await assert.rejects(
    f.storage.archive(f.workspace.id, {}, async () => {}),
    /Classify/,
  );
  await assert.rejects(
    f.storage.archive(f.workspace.id, { ignored: "retain" }, async () => {
      throw new Error("active lease");
    }),
    /active lease/,
  );
  const archive = await f.storage.archive(
    f.workspace.id,
    { ignored: "retain" },
    async () => {},
  );
  assert.equal(archive.verified, true);
  assert.deepEqual(
    archive.files.map((f) => f.path),
    ["ignored"],
  );
  const restored = await f.storage.restore(archive.id);
  assert.equal(
    await readFile(join(restored.path, "source"), "utf8"),
    "source\n",
  );
  assert.equal(
    await readFile(join(restored.path, "ignored"), "utf8"),
    "retained\n",
  );
  await assert.rejects(readFile(join(restored.path, ".env")));
  assert.equal(
    (await f.storage.preview(async () => true)).actions[0].eligible,
    false,
  );
  assert.equal(
    (await f.storage.preview(async () => false)).archiveEviction[0].eligible,
    false,
  );
  await assert.rejects(f.storage.restore(archive.id), /already exists/);
});
test("archive corruption blocks restore and redirected workspace never gets archived", async (t) => {
  const f = await fixture(t);
  const archive = await f.storage.archive(f.workspace.id, {}, async () => {});
  await writeFile(
    join(f.storage.recoveryRoot, archive.id, "source.bundle"),
    "corrupt",
  );
  await assert.rejects(f.storage.restore(archive.id), /hash mismatch/);
  await rm(f.path, { recursive: true });
  await symlink(f.root, f.path);
  await assert.rejects(
    f.storage.archive(f.workspace.id, {}, async () => {}),
    /non-owned/,
  );
});
test("credentials cannot be explicitly retained or bundled from tracked history", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.path, ".env"), "secret");
  await assert.rejects(
    f.storage.archive(f.workspace.id, { ".env": "retain" }, async () => {}),
    /Credentials/,
  );
  await git(f.path, ["add", "-f", ".env"]);
  await git(f.path, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "bad tracked secret",
  ]);
  await assert.rejects(
    f.storage.archive(f.workspace.id, {}, async () => {}),
    /credential-like path/,
  );
});
test("explicit cleanup archives owned inactive worktrees and restores them; user clones are retained", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.storage.cleanup(
      f.workspace.id,
      {},
      async () => {},
      async () => {},
    ),
    /MissionControl-owned/,
  );
  const linked = join(f.storage.managedRoot, "workspaces", "linked");
  await git(f.path, [
    "worktree",
    "add",
    "-b",
    "missioncontrol/goal/task",
    linked,
    "HEAD",
  ]);
  const workspace = f.storage.register({
    ...f.workspace,
    id: "workspace_linked",
    path: linked,
    status: "waiting",
  });
  const cleaned = await f.storage.cleanup(
    workspace.id,
    {},
    async () => {},
    async () => {},
  );
  assert.equal(cleaned.status, "cleaned");
  assert.ok(cleaned.archiveId);
  await assert.rejects(readFile(join(linked, "source")));
  const restored = await f.storage.restore(cleaned.archiveId!);
  assert.equal(
    await readFile(join(restored.path, "source"), "utf8"),
    "source\n",
  );
  assert.equal(await readFile(join(f.path, "source"), "utf8"), "source\n");
  f.storage.register({ ...cleaned, status: "cleaning" });
  assert.equal(
    (await f.storage.reconcileCleanup(workspace.id))!.status,
    "cleaned",
  );
});

test("registered detached candidates archive and restore while unrelated detached work stays retained", async (t) => {
  const f = await fixture(t);
  const path = join(f.storage.managedRoot, "goals", "goal", "candidate-task-1");
  await git(f.path, ["worktree", "add", "--detach", path, "HEAD"]);
  const record = f.storage.register({
    ...f.workspace,
    id: "candidate_one",
    taskId: "task",
    path,
    kind: "task-candidate",
    generation: 2,
  });
  await assert.rejects(
    f.storage.cleanup(
      record.id,
      {},
      async () => {},
      async () => {},
    ),
    /MissionControl-owned/,
  );
  f.storage.register({ ...record, path, generation: 1 });
  // Exact controller path and durable kind authorize linked detached candidate lifecycle.
  const cleaned = await f.storage.cleanup(
    record.id,
    {},
    async () => {},
    async () => {},
  );
  assert.equal(cleaned.status, "cleaned");
  assert.ok(cleaned.archiveId);
  const restored = await f.storage.restore(cleaned.archiveId!);
  assert.equal(
    await readFile(join(restored.path, "source"), "utf8"),
    "source\n",
  );
});

test("owned branch cleanup fences dependencies, moved refs and crash replay while retaining recovery", async (t) => {
  const f = await fixture(t);
  const linked = join(f.storage.managedRoot, "workspaces", "branch");
  await git(f.path, [
    "worktree",
    "add",
    "-b",
    "missioncontrol/goal/task",
    linked,
    "HEAD",
  ]);
  const w = f.storage.register({
    ...f.workspace,
    id: "task",
    taskId: "task",
    kind: "task",
    path: linked,
  });
  const cleaned = await f.storage.cleanup(
    w.id,
    {},
    async () => {},
    async () => {},
  );
  await assert.rejects(
    f.storage.cleanupBranch(
      w.id,
      async () => {},
      async () => {
        throw new Error("dependent branch");
      },
    ),
    /dependent branch/,
  );
  await assert.rejects(
    f.storage.cleanupBranch(
      w.id,
      async () => {
        throw new Error("active review");
      },
      async () => {},
    ),
    /active review/,
  );
  await git(f.path, [
    "update-ref",
    "refs/heads/missioncontrol/goal/task",
    "HEAD",
  ]);
  const removed = await f.storage.cleanupBranch(
    w.id,
    async () => {},
    async () => {},
  );
  assert.equal(removed.branchCleanup?.status, "deleted");
  assert.equal(
    (await f.storage.restore(cleaned.archiveId!)).headSha,
    w.headSha,
  );
  // The process can die after exact ref removal, before recording completion.
  f.storage.register({
    ...removed,
    branchCleanup: { ...removed.branchCleanup!, status: "deleting" },
  });
  assert.equal(
    (
      await f.storage.cleanupBranch(
        w.id,
        async () => {},
        async () => {},
      )
    ).branchCleanup?.status,
    "deleted",
  );
  await git(f.path, [
    "update-ref",
    "refs/heads/missioncontrol/goal/task",
    w.headSha,
  ]);
  f.storage.register({ ...cleaned });
  await writeFile(join(f.path, "new"), "external change\n");
  await git(f.path, ["add", "new"]);
  await git(f.path, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "external",
  ]);
  const moved = await git(f.path, ["rev-parse", "HEAD"]);
  await git(f.path, [
    "update-ref",
    "refs/heads/missioncontrol/goal/task",
    moved,
  ]);
  await assert.rejects(
    f.storage.cleanupBranch(
      w.id,
      async () => {},
      async () => {},
    ),
    /changed after/,
  );
  assert.equal(
    await git(f.path, ["rev-parse", "refs/heads/missioncontrol/goal/task"]),
    moved,
  );
});

test("partial archival reconciles without deleting source and verified archival recovers after interruption", async (t) => {
  const f = await fixture(t);
  f.storage.register({
    ...f.workspace,
    status: "archiving",
    archiveId: "archive_incomplete",
  });
  assert.equal(
    (await f.storage.reconcileArchive(f.workspace.id))?.status,
    "retained",
  );
  assert.equal(await readFile(join(f.path, "source"), "utf8"), "source\n");
  const archive = await f.storage.archive(f.workspace.id, {}, async () => {});
  f.storage.register({
    ...f.workspace,
    status: "archiving",
    archiveId: archive.id,
  });
  assert.equal(
    (await f.storage.reconcileArchive(f.workspace.id))?.status,
    "archived",
  );
});

test("archive budget eviction preserves unfinished recovery and reconciles exact completed archive intent", async (t) => {
  const f = await fixture(t);
  const unfinished = await f.storage.archive(
    f.workspace.id,
    {},
    async () => {},
  );
  const aged = new StorageManager(
    f.storage.managedRoot,
    f.storage.recoveryRoot,
    () => Date.now() + storageDefaults.archiveRetentionMs + 10000,
  );
  t.after(() => aged.db.close());
  assert.equal(
    (await aged.evictArchives(async () => false)).candidates[0].eligible,
    false,
  );
  // Even a claimed backup field cannot authorize sole unfinished copy eviction.
  aged.db.exec(
    `UPDATE archives SET record=json_set(record,'$.offHostBackup',json('{"encrypted":true,"location":"unverified","verifiedAt":1}'))`,
  );
  const preview = await aged.preview(async () => false);
  assert.equal(preview.archiveEviction[0].eligible, false);
  assert.match(
    preview.archiveEviction[0].reason,
    /verified encrypted off-host/,
  );
  assert.equal(
    (await aged.evictArchives(async () => false)).candidates[0].eligible,
    false,
  );
  f.storage.register({ ...f.workspace, unfinished: false });
  const complete = await f.storage.archive(f.workspace.id, {}, async () => {});
  const priorBudget = storageDefaults.archiveBudgetBytes;
  storageDefaults.archiveBudgetBytes = 0;
  t.after(() => {
    storageDefaults.archiveBudgetBytes = priorBudget;
  });
  const evicted = await aged.evictArchives(async () => false, true);
  assert.deepEqual(evicted.removed, [complete.id]);
  assert.equal((await aged.verifyArchive(unfinished.id)).verified, true);
  await assert.rejects(aged.verifyArchive(complete.id), /evicted/);
  aged.db.exec(
    `UPDATE archives SET record=json_set(record,'$.disposition','evicting') WHERE id='${complete.id}'`,
  );
  assert.deepEqual(
    (await aged.evictArchives(async () => false, true)).removed,
    [complete.id],
  );
});
