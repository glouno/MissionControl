import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { StorageManager, storageDefaults } from "./storage.js";
import { StorageMaintenance } from "./storageMaintenance.js";
import { git } from "./git.js";

test("progressive maintenance previews, verifies publication, preserves pinned work and restores removed source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-progressive-maintenance-"));
  const managed = join(root, "managed"),
    repo = join(managed, "repo");
  await mkdir(managed);
  await mkdir(repo);
  await git(repo, ["init", "-b", "development"]);
  await writeFile(join(repo, "source"), "preserved\n");
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "initial",
  ]);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const store = new ControlStore(new SqliteStore(join(root, "control.db")));
  const storage = new StorageManager(managed, join(root, "recovery"));
  t.after(async () => {
    store.db.close();
    storage.db.close();
    await rm(root, { recursive: true, force: true });
  });
  const goal = store.createGoal({
    title: "Maintenance",
    description: "Fixture",
    repoPath: repo,
    backend: { kind: "fake" },
  });
  store.setGoalState(goal.id, "completed", goal.revision, "fixture", {
    publication: {
      merged: true,
      verifiedCandidate: head,
      url: "local://fixture",
    },
  });
  const path = join(managed, "integration");
  await git(repo, [
    "worktree",
    "add",
    "-b",
    `missioncontrol/${goal.id}/integration`,
    path,
    "HEAD",
  ]);
  const w = storage.register({
    id: goal.id,
    goalId: goal.id,
    kind: "goal",
    path,
    baseSha: head,
    headSha: head,
    generation: 0,
    status: "retained",
    unfinished: false,
    lastActivityAt: Date.now(),
    acceptedAt: Date.now() - storageDefaults.mergedRetentionMs - 1000,
    publication: {
      candidateSha: head,
      url: "local://fixture",
      recordedAt: Date.now(),
    },
  });
  const maintenance = new StorageMaintenance(storage, store);
  assert.deepEqual((await maintenance.maintain()).removed, []);
  storage.register({ ...w, pinned: true });
  assert.deepEqual((await maintenance.maintain("branches")).removed, []);
  storage.register({
    ...w,
    publication: { ...w.publication!, url: "local://wrong" },
  });
  const refused = await maintenance.maintain("workspaces");
  assert.equal(refused.errors.length, 1);
  assert.equal(await readFile(join(path, "source"), "utf8"), "preserved\n");
  storage.register(w);
  // Real GithubHost results contain merged/url, with the exact candidate in the
  // durable publication record rather than duplicated in the result envelope.
  store.db.exec(
    `UPDATE control_goals SET result='{"publication":{"merged":true,"url":"local://fixture"}}' WHERE id='${goal.id}'`,
  );
  store.setting(`publication:${goal.id}`, { commit: head });
  const cleaned = await maintenance.maintain("workspaces");
  assert.deepEqual(cleaned.errors, []);
  assert.deepEqual(cleaned.removed, [w.id]);
  assert.equal(
    await git(repo, [
      "rev-parse",
      `refs/heads/missioncontrol/${goal.id}/integration`,
    ]),
    head,
  );
  const branch = await maintenance.maintain("branches");
  assert.deepEqual(branch.errors, []);
  assert.deepEqual(branch.branches, [w.id]);
  const restored = await storage.restore(storage.workspaces()[0].archiveId!);
  assert.equal(
    await readFile(join(restored.path, "source"), "utf8"),
    "preserved\n",
  );
});
