import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { EnvironmentRegistry, FakeEnvironment } from "./environments.js";
import { ExecutionMaintenance } from "./executionMaintenance.js";
import { git } from "./git.js";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-execution-maintenance-")),
    source = join(root, "source");
  await mkdir(source);
  await git(source, ["init", "-b", "main"]);
  await writeFile(join(source, "base"), "base");
  await writeFile(join(source, ".gitignore"), "scratch\n__pycache__/\n");
  await git(source, ["add", "."]);
  await git(source, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "base",
  ]);
  const registry = new EnvironmentRegistry(join(root, "managed")),
    environment = new FakeEnvironment(registry),
    baseSha = await git(source, ["rev-parse", "HEAD"]);
  const session = await environment.prepare({
    source,
    baseSha,
    taskId: "task",
    generation: 1,
    invocationId: "verify_one",
    image: `sha256:${"a".repeat(64)}`,
    cpu: 1,
    memoryMiB: 512,
    timeoutMs: 1000,
  });
  registry.save({
    ...session,
    completion: {
      outcome: "verified",
      commit: baseSha,
      recordedAt: Date.now(),
      evidence: { passed: true },
    },
  });
  let active = false;
  const maintenance = new ExecutionMaintenance(
    registry,
    environment,
    async () => active,
  );
  t.after(async () => {
    registry.db.close();
    await rm(root, { recursive: true });
  });
  return {
    session,
    registry,
    environment,
    maintenance,
    setActive: (v: boolean) => {
      active = v;
    },
  };
}
test("temporary cleanup preserves active, imported, changed and unclassified source", async (t) => {
  const f = await fixture(t);
  f.setActive(true);
  assert.equal((await f.maintenance.preview()).actions[0].eligible, false);
  f.setActive(false);
  await writeFile(join(f.session.path, "scratch"), "unknown ignored");
  assert.equal((await f.maintenance.preview()).actions[0].eligible, false);
  await rm(join(f.session.path, "scratch"));
  await writeFile(join(f.session.path, "base"), "changed");
  assert.equal((await f.maintenance.preview()).actions[0].eligible, false);
  await git(f.session.path, ["restore", "base"]);
  f.registry.save({
    ...f.registry.get(f.session.id),
    completion: {
      outcome: "imported",
      commit: f.session.baseSha,
      recordedAt: Date.now(),
    },
  });
  assert.equal((await f.maintenance.preview()).actions[0].eligible, false);
});
test("verified temporary source is previewed before cleanup and crashed removal reconciles", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.maintenance.maintain()).removed.length, 0);
  const result = await f.maintenance.maintain(true);
  assert.deepEqual(result.removed, [f.session.id]);
  assert.equal(f.registry.get(f.session.id).status, "destroyed");
  await assert.rejects(lstat(f.session.path));
  f.registry.save({ ...f.registry.get(f.session.id), status: "destroying" });
  await f.maintenance.reconcile();
  assert.equal(f.registry.get(f.session.id).status, "destroyed");
});
test("cleanup repeats active-authority check and cannot remove newly active source", async (t) => {
  const f = await fixture(t);
  let n = 0;
  const maintenance = new ExecutionMaintenance(
    f.registry,
    f.environment,
    async () => ++n > 1,
  );
  assert.equal((await maintenance.maintain(true)).removed.length, 0);
  assert.ok(await lstat(f.session.path));
});

test("cleanup intent reconciles retained source and preserves unverified or active recovery", async (t) => {
  const f = await fixture(t);
  f.registry.save({ ...f.registry.get(f.session.id), status: "destroying" });
  f.setActive(true);
  await assert.rejects(f.maintenance.reconcile(), /active authority/);
  assert.equal(f.registry.get(f.session.id).status, "destroying");
  f.setActive(false);
  f.registry.save({ ...f.registry.get(f.session.id), completion: undefined });
  await assert.rejects(f.maintenance.reconcile(), /Only verified/);
  assert.ok(await lstat(f.session.path));
  f.registry.save({
    ...f.registry.get(f.session.id),
    completion: {
      outcome: "verified",
      commit: f.session.baseSha,
      recordedAt: Date.now(),
    },
  });
  await f.maintenance.reconcile();
  assert.equal(f.registry.get(f.session.id).status, "checkpointed");
  assert.equal((await f.maintenance.preview()).actions[0].eligible, true);
});
