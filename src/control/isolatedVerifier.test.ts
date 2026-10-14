import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.js";
import { EnvironmentRegistry, FakeEnvironment } from "./environments.js";
import { IsolatedVerifier } from "./isolatedVerifier.js";
const exec = promisify(execFile);
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-verifier-")),
    source = join(root, "trusted");
  await mkdir(source);
  await git(source, ["init", "-b", "task"]);
  await writeFile(join(source, "base"), "base\n");
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
    environment = new FakeEnvironment(registry);
  environment.execute = async (id, command, signal) => {
    const s = await environment.acquire(id);
    return exec(command[0], command.slice(1), { cwd: s.path, signal });
  };
  const verifier = new IsolatedVerifier(
    environment,
    `sha256:${"a".repeat(64)}`,
  );
  const claim: any = {
    generation: 1,
    task: {
      id: "task",
      spec: { cpuUnits: 1, memoryMiB: 512, verificationCommands: [] },
    },
    goal: {
      config: { verificationCommands: ["test -f base"], timeoutMs: 1000 },
    },
  };
  t.after(async () => {
    registry.db.close();
    await rm(root, { recursive: true });
  });
  return { source, registry, verifier, claim, environment };
}
test("isolated verification keys evidence to commit/image/commands and releases execution", async (t) => {
  const f = await fixture(t),
    result = await f.verifier.verify(f.claim, f.source);
  assert.equal(result.passed, true);
  assert.equal(result.commit, await git(f.source, ["rev-parse", "HEAD"]));
  assert.equal(result.imageDigest, `sha256:${"a".repeat(64)}`);
  assert.equal(result.verifierVersion, "private-source-v1");
  assert.equal(result.results[0].exitCode, 0);
  assert.equal(f.registry.get(result.executionSessionId!).container, undefined);
});

test("independent checks receive the pinned contract snapshot despite sibling checkout changes", async (t) => {
  const f = await fixture(t);
  const revision = await git(f.source, ["rev-parse", "HEAD"]);
  f.claim.goal.config.siblingContracts = [
    { repositoryPath: f.source, revision, files: ["base"] },
  ];
  f.claim.goal.config.verificationCommands = [
    "test $(cat /contracts/0/base) = base",
  ];
  await writeFile(join(f.source, "base"), "new sibling value\n");
  await git(f.source, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-am",
    "New sibling value",
  ]);
  const execute = f.environment.execute.bind(f.environment);
  f.environment.execute = async (id, command, signal) => {
    const snapshot = f.registry.get(id).spec.contractSnapshot;
    assert.ok(snapshot, "verifier must receive the admitted contracts");
    assert.equal(
      await readFile(join(snapshot.path, "0/base"), "utf8"),
      "base\n",
    );
    // Fake environments translate the container's immutable mount into its
    // private host fixture path; real Docker mount coverage is in installed acceptance.
    return execute(
      id,
      command.map((part) => part.replaceAll("/contracts", snapshot.path)),
      signal,
    );
  };
  const result = await f.verifier.verify(f.claim, f.source);
  assert.equal(result.passed, true);
  assert.equal(
    await readFile(join(f.source, "base"), "utf8"),
    "new sibling value\n",
  );
});
test("failing checks and source mutation never alter the trusted checkout", async (t) => {
  const f = await fixture(t);
  f.claim.goal.config.verificationCommands = ["printf changed > base; exit 2"];
  const result = await f.verifier.verify(f.claim, f.source);
  assert.equal(result.passed, false);
  assert.equal(result.unchanged, false);
  assert.equal(result.results[0].exitCode, 2);
  assert.equal(await readFile(join(f.source, "base"), "utf8"), "base\n");
});
