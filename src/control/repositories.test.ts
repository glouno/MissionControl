import { StorageManager } from "./storage.js";
import test from "node:test";
// CI runner disk capacity is unrelated to fixture lifecycle behavior.
test.mock.method(StorageManager.prototype, "pressure", async () => ({
  freeBytes: 100 * 1024 ** 3,
  reserveBytes: 50 * 1024 ** 3,
  admissionAllowed: true,
}));

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, WorkspaceManager } from "./workspaces.js";
import { parseWorktrees, repositoryIdentity } from "./repositories.js";
import { goalSchema, taskSchema, type Goal, type Task } from "./schema.js";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-fresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git"),
    repo = join(root, "human");
  await mkdir(remote);
  await mkdir(repo);
  await git(remote, ["init", "--bare"]);
  await git(repo, ["init", "-b", "development"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@localhost"]);
  await writeFile(join(repo, "base"), "base");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  const initial = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "origin", "development"]);
  const g: Goal = {
    id: "goal_test",
    status: "planning",
    revision: 1,
    planRevision: 0,
    createdAt: new Date().toISOString(),
    config: goalSchema.parse({
      title: "Fresh",
      description: "Fresh",
      repoPath: repo,
      backend: { kind: "fake" },
      repository: {
        mode: "remote",
        remoteUrl: remote,
        primaryBranch: "development",
        auditedPrimarySha: initial,
        verificationEnvironment: "fixture-v1",
      },
    }),
  };
  const manager = new WorkspaceManager(join(root, "managed"));
  t.after(() => manager.repositories.db.close());
  return { root, remote, repo, initial, g, manager };
}
async function advance(f: Awaited<ReturnType<typeof fixture>>) {
  const upstream = join(f.root, "upstream");
  await mkdir(upstream);
  await git(upstream, ["clone", "--branch", "development", f.remote, "."]);
  await writeFile(join(upstream, "fresh"), "fresh");
  await git(upstream, ["add", "."]);
  await git(upstream, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "remote advance",
  ]);
  await git(upstream, ["push", "origin", "development"]);
  return git(upstream, ["rev-parse", "HEAD"]);
}
test("fresh remote base ignores dirty off-branch checkout and remains pinned across restarts and force pushes", async (t) => {
  const f = await fixture(t);
  const fresh = await advance(f);
  await git(f.repo, ["switch", "-c", "old-task"]);
  await writeFile(join(f.repo, "base"), "dirty");
  const path = await f.manager.prepareGoal(f.g);
  assert.equal(await git(path, ["rev-parse", "HEAD"]), fresh);
  assert.equal(await readFile(join(f.repo, "base"), "utf8"), "dirty");
  const base = f.manager.repositories.record(f.g.id)!;
  assert.ok(base.fetchedAt);
  assert.notEqual(base.repositoryPath, f.repo);
  await git(f.repo, ["push", "--force", "origin", `${f.initial}:development`]);
  const restarted = new WorkspaceManager(f.manager.root);
  t.after(() => restarted.repositories.db.close());
  assert.equal(await restarted.prepareGoal(f.g), path);
  assert.equal(restarted.repositories.record(f.g.id)!.baseSha, fresh);
  const next = { ...f.g, id: "goal_next" };
  assert.equal(
    await git(await restarted.prepareGoal(next), ["rev-parse", "HEAD"]),
    f.initial,
  );
});
test("missing remote branch and unavailable remote never select stale HEAD", async (t) => {
  const f = await fixture(t);
  f.g.config.policy.targetBranch = "missing";
  await assert.rejects(f.manager.prepareGoal(f.g), /fetch failed/);
  assert.equal(f.manager.repositories.record(f.g.id), undefined);
  f.g.config.policy.targetBranch = "development";
  await rm(f.remote, { recursive: true });
  await assert.rejects(f.manager.prepareGoal(f.g), /fetch failed/);
  assert.equal(f.manager.repositories.record(f.g.id), undefined);
});
test("restart after base intent creates exactly one workspace with the recorded base", async (t) => {
  const f = await fixture(t);
  await f.manager.repositories.resolveGoal(
    f.g,
    f.manager.goalPath(f.g),
    f.manager.goalBranch(f.g),
  );
  await advance(f);
  const path = await f.manager.prepareGoal(f.g);
  await f.manager.prepareGoal(f.g);
  assert.equal(await git(path, ["rev-parse", "HEAD"]), f.initial);
  const repo = f.manager.repositories.record(f.g.id)!.repositoryPath;
  assert.equal(
    parseWorktrees(
      await git(repo, ["worktree", "list", "--porcelain", "-z"]),
    ).filter((w) => w.path === path).length,
    1,
  );
});
test("task changes use the recorded base after the goal integration branch advances", async (t) => {
  const f = await fixture(t);
  const task: Task = {
    id: "task_one",
    goalId: f.g.id,
    key: "one",
    status: "running",
    generation: 1,
    attempts: 1,
    revision: 1,
    workerId: "worker",
    leaseUntil: null,
    retryAt: null,
    createdAt: f.g.createdAt,
    spec: taskSchema.parse({
      key: "one",
      title: "One",
      description: "One",
      allowedPaths: ["one"],
      acceptanceCriteria: ["exists"],
    }),
  };
  const w = await f.manager.prepareTask(f.g, task);
  await writeFile(join(w.path, "one"), "one");
  await f.manager.commit(task);
  const candidate = await f.manager.candidate(f.g, task);
  await f.manager.advance(f.g, candidate);
  assert.deepEqual(await f.manager.changed(f.g, task), ["one"]);
  assert.equal((await f.manager.prepareTask(f.g, task)).baseCommit, f.initial);
});
test("new goals require explicit policy and reject task integration targets", async (t) => {
  const f = await fixture(t);
  delete f.g.config.repository;
  await assert.rejects(f.manager.prepareGoal(f.g), /audited remote policy/);
  f.g.config.repository = { mode: "local", branch: "development" };
  f.g.config.policy.targetBranch = "codex/old-task";
  await assert.rejects(f.manager.prepareGoal(f.g), /Task branches/);
  f.g.config.policy.targetBranch = "../unsafe";
  await assert.rejects(f.manager.prepareGoal(f.g), /Invalid Git branch/);
});
test("worktree parser handles newline paths exactly and remote identities exclude secrets", () => {
  assert.deepEqual(
    parseWorktrees("worktree /tmp/a\nname\0HEAD abc\0branch refs/heads/x\0\0"),
    [{ path: "/tmp/a\nname", head: "abc", branch: "refs/heads/x" }],
  );
  assert.equal(
    repositoryIdentity("https://GITHUB.com/a/b.git"),
    "https://github.com/a/b",
  );
  assert.throws(
    () => repositoryIdentity("https://user:secret@github.com/a/b"),
    /credentials/,
  );
});
test("two goals retain both results when development advances between publications", async (t) => {
  const f = await fixture(t);
  const g2 = { ...f.g, id: "goal_second" };
  const p1 = await f.manager.prepareGoal(f.g),
    p2 = await f.manager.prepareGoal(g2);
  for (const [path, name] of [
    [p1, "first"],
    [p2, "second"],
  ]) {
    await writeFile(join(path, name), name);
    await git(path, ["add", "."]);
    await git(path, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      name,
    ]);
  }
  const c1 = await f.manager.refreshCandidate(f.g);
  await f.manager.advance(f.g, c1);
  await git(p1, ["push", "origin", "HEAD:development"]);
  const c2 = await f.manager.refreshCandidate(g2);
  assert.equal(c2.targetSha, c1.commit);
  assert.equal(await readFile(join(c2.path, "first"), "utf8"), "first");
  assert.equal(await readFile(join(c2.path, "second"), "utf8"), "second");
  assert.equal((await f.manager.refreshCandidate(g2)).commit, c2.commit);
  const records = f.manager.storage
    .workspaces()
    .filter((w) => w.goalId === g2.id);
  assert.ok(
    records.some(
      (w) =>
        w.path === c2.path &&
        w.kind === "publication-candidate" &&
        w.unfinished,
    ),
  );
  await assert.rejects(
    f.manager.recordPublication(g2, c2.commit, "local://verified", Date.now()),
    /head differs/,
  );
  await f.manager.advance(g2, c2);
  const publishedAt = Date.now();
  await f.manager.recordPublication(
    g2,
    c2.commit,
    "local://verified",
    publishedAt,
  );
  await f.manager.prepareGoal(g2);
  const retained = f.manager.storage
    .workspaces()
    .filter((w) => w.goalId === g2.id);
  assert.ok(
    retained.every(
      (w) =>
        !w.unfinished &&
        w.publication?.candidateSha === c2.commit &&
        w.acceptedAt === publishedAt,
    ),
  );
  await f.manager.recordPublication(
    g2,
    c2.commit,
    "local://verified",
    publishedAt + 1000,
  );
  assert.ok(
    f.manager.storage
      .workspaces()
      .filter((w) => w.goalId === g2.id)
      .every((w) => w.acceptedAt === publishedAt),
  );

  assert.equal(f.manager.repositories.record(g2.id)!.baseSha, f.initial);
});
test("publication conflicts retain unresolved candidate evidence across retries", async (t) => {
  const f = await fixture(t);
  const path = await f.manager.prepareGoal(f.g);
  await writeFile(join(path, "base"), "goal");
  await git(path, ["add", "."]);
  await git(path, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "goal",
  ]);
  await writeFile(join(f.repo, "base"), "external");
  await git(f.repo, ["add", "."]);
  await git(f.repo, ["commit", "-m", "external"]);
  await git(f.repo, ["push", "origin", "development"]);
  await assert.rejects(f.manager.refreshCandidate(f.g), /conflict retained/);
  await assert.rejects(f.manager.refreshCandidate(f.g), /conflict retained/);
  const conflict = f.manager.storage
    .workspaces()
    .find((w) => w.kind === "publication-candidate")!;
  assert.equal(conflict.unfinished, true);
  assert.equal(conflict.status, "checkpointed");
  assert.equal(conflict.publication, undefined);
});

test("GitHub transport aliases share deterministic repository ownership", () => {
  assert.equal(
    repositoryIdentity("git@github.com:ExampleOrg/ExampleRepo.git"),
    repositoryIdentity("https://github.com/exampleorg/ExampleRepo"),
  );
  assert.throws(
    () => repositoryIdentity("https://token@github.com/a/b"),
    /credentials/,
  );
});
test("bounded instructions include pinned sibling contracts and reject traversal", async (t) => {
  const { instructionManifest } = await import("./projectContext.js");
  const f = await fixture(t);
  const path = await f.manager.prepareGoal(f.g);
  f.g.config.instructionFiles = ["base"];
  f.g.config.siblingContracts = [
    { repositoryPath: f.repo, revision: f.initial, files: ["base"] },
  ];
  const manifest = await instructionManifest(f.g, path);
  assert.equal(manifest.instructions[0].content, "base");
  assert.equal(manifest.siblingContracts[0].revision, f.initial);
  assert.equal(manifest.siblingContracts[0].files[0].content, "base");
  f.g.config.instructionFiles = ["../escape"];
  await assert.rejects(instructionManifest(f.g, path), /repository-relative/);
});
test("disk reserve blocks new workspaces and preserves recorded existing lineage", async (t) => {
  const f = await fixture(t);
  const path = await f.manager.prepareGoal(f.g);
  f.manager.storage.pressure = async () => ({
    freeBytes: 1,
    reserveBytes: 50 * 1024 ** 3,
    admissionAllowed: false,
  });
  assert.equal(await f.manager.prepareGoal(f.g), path);
  await assert.rejects(
    f.manager.prepareGoal({ ...f.g, id: "goal_low_disk" }),
    /configured free storage reserve/,
  );
  assert.equal(f.manager.repositories.record("goal_low_disk"), undefined);
});
test("local publication target mismatch and unaudited remote primary are rejected", async (t) => {
  const f = await fixture(t);
  f.g.config.repository = { mode: "local", branch: "old-task" };
  await assert.rejects(f.manager.prepareGoal(f.g), /must match/);
  f.g.config.repository = {
    mode: "remote",
    remoteUrl: f.remote,
    primaryBranch: "development",
    auditedPrimarySha: "a".repeat(40),
    verificationEnvironment: "fixture",
  };
  await assert.rejects(f.manager.prepareGoal(f.g), /Audited primary/);
  assert.equal(f.manager.repositories.record(f.g.id), undefined);
});

test("retired goal source cannot silently be recreated from retained refs", async (t) => {
  const f = await fixture(t);
  await f.manager.prepareGoal(f.g);
  const record = f.manager.storage.workspaces().find((w) => w.id === f.g.id)!;
  f.manager.storage.register({ ...record, status: "cleaned" });
  await assert.rejects(f.manager.prepareGoal(f.g), /do not recreate/);
});
