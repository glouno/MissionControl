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
  return { source, registry, verifier, claim };
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
test("failing checks and source mutation never alter the trusted checkout", async (t) => {
  const f = await fixture(t);
  f.claim.goal.config.verificationCommands = ["printf changed > base; exit 2"];
  const result = await f.verifier.verify(f.claim, f.source);
  assert.equal(result.passed, false);
  assert.equal(result.unchanged, false);
  assert.equal(result.results[0].exitCode, 2);
  assert.equal(await readFile(join(f.source, "base"), "utf8"), "base\n");
});
