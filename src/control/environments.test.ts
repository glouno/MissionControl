import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.js";
import {
  EnvironmentRegistry,
  FakeEnvironment,
  importWorkerChanges,
} from "./environments.js";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-environment-"));
  const source = join(root, "trusted");
  await mkdir(source);
  await git(source, ["init", "-b", "task"]);
  await writeFile(join(source, "base"), "base");
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
  const registry = new EnvironmentRegistry(join(root, "managed"));
  const env = new FakeEnvironment(registry);
  t.after(async () => {
    registry.db.close();
    await rm(root, { recursive: true, force: true });
  });
  const spec = {
    taskId: "task_one",
    generation: 1,
    source,
    baseSha: await git(source, ["rev-parse", "HEAD"]),
    image: "fixture",
    cpu: 2,
    memoryMiB: 512,
    timeoutMs: 1000,
  };
  return { root, source, registry, env, spec };
}
test("private checkout persists while execution resets its container and preserves task lineage", async (t) => {
  const f = await fixture(t);
  const session = await f.env.prepare(f.spec);
  assert.equal(
    await git(session.path, ["rev-parse", "--git-common-dir"]),
    ".git",
  );
  assert.equal(await git(session.path, ["remote"]), "");
  await f.env.acquire(session.id);
  assert.equal((await f.env.inspect(session.id)).status, "active");
  await f.env.checkpoint(session.id);
  assert.equal(f.registry.get(session.id).status, "checkpointed");
  await f.env.acquire(session.id);
  await f.env.reset(session.id);
  assert.equal(f.registry.get(session.id).container, undefined);
  assert.equal(await readFile(join(session.path, "base"), "utf8"), "base");
  assert.equal((await f.env.prepare(f.spec)).id, session.id);
});
test("trusted import checks task lease and scope without importing worker configuration", async (t) => {
  const f = await fixture(t);
  const s = await f.env.prepare(f.spec);
  await writeFile(join(s.path, "one"), "one\n");
  await git(s.path, ["add", "."]);
  await git(s.path, [
    "-c",
    "user.name=Worker",
    "-c",
    "user.email=worker@localhost",
    "commit",
    "-m",
    "worker",
  ]);
  await assert.rejects(
    importWorkerChanges(s, f.source, ["other"], () => {}),
    /declared paths/,
  );
  await assert.rejects(
    importWorkerChanges(s, f.source, ["one"], () => {
      throw new Error("stale lease");
    }),
    /stale lease/,
  );
  const imported = await importWorkerChanges(s, f.source, ["one"], () => {});
  assert.deepEqual(imported.files, ["one"]);
  assert.equal(await readFile(join(f.source, "one"), "utf8"), "one\n");
  assert.equal(await git(f.source, ["rev-parse", "HEAD"]), f.spec.baseSha);
});
test("worker symlink escapes and Git alternates are rejected before import", async (t) => {
  const f = await fixture(t);
  const s = await f.env.prepare(f.spec);
  await symlink(f.source, join(s.path, "escape"));
  await git(s.path, ["add", "."]);
  await git(s.path, [
    "-c",
    "user.name=Worker",
    "-c",
    "user.email=worker@localhost",
    "commit",
    "-m",
    "escape",
  ]);
  await assert.rejects(
    importWorkerChanges(s, f.source, ["**"], () => {}),
    /escapes checkout/,
  );
  await writeFile(
    join(s.path, ".git", "objects", "info", "alternates"),
    join(f.source, ".git", "objects"),
  );
  await assert.rejects(
    importWorkerChanges(s, f.source, ["**"], () => {}),
    /alternates/,
  );
});
test("destroy refuses a record redirected to a user checkout", async (t) => {
  const f = await fixture(t);
  const s = await f.env.prepare(f.spec);
  f.registry.save({ ...s, path: f.source });
  await assert.rejects(f.env.destroy(s.id), /ownership mismatch/);
  assert.equal(await readFile(join(f.source, "base"), "utf8"), "base");
});
test("gateway networks and worker credentials require explicit controller capability", async (t) => {
  const f = await fixture(t);
  const { DockerEnvironment } = await import("./environments.js");
  const env = new DockerEnvironment(f.registry, async (args) => {
    if (args[0] === "inspect") throw new Error("missing");
    if (args[0] === "image")
      return { stdout: JSON.stringify(`sha256:${"a".repeat(64)}`), stderr: "" };
    if (args[0] === "network")
      return {
        stdout: JSON.stringify([{ Internal: false, Labels: {} }]),
        stderr: "",
      };
    return { stdout: "", stderr: "" };
  });
  const s = await env.prepare({
    ...f.spec,
    gatewayNetwork: "untrusted-network",
  });
  await assert.rejects(env.acquire(s.id), /internal and controller-owned/);
});
test("contract snapshots mount read-only and tampering blocks acquisition", async (t) => {
  const f = await fixture(t);
  const { prepareContractSnapshot } = await import("./contractSnapshots.js");
  const snapshot = await prepareContractSnapshot(
    join(f.registry.root, "contract-snapshots"),
    [{ repositoryPath: f.source, revision: f.spec.baseSha, files: ["base"] }],
  );
  const s = await f.env.prepare({
    ...f.spec,
    contractSnapshot: { path: snapshot.path, digest: snapshot.digest },
  });
  await f.env.acquire(s.id);
  await f.env.reset(s.id);
  const { chmod } = await import("node:fs/promises");
  await chmod(join(snapshot.path, "0/base"), 0o600);
  await writeFile(join(snapshot.path, "0/base"), "tampered");
  await assert.rejects(f.env.acquire(s.id), /snapshot content changed/);
});
