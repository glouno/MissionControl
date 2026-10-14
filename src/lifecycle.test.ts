import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

test("ordinary CLI records sanitized startup phase when controller ownership blocks serving", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-startup-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state"),
    config = join(root, "config");
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const args = [cli, "--config-dir", config];
  await exec(process.execPath, [
    ...args,
    "init",
    "--state-dir",
    state,
    "--secrets-dir",
    join(root, "secrets"),
  ]);
  const lock = {
    pid: process.pid,
    hostname: "synthetic-other-host",
    nonce: "synthetic-sensitive-nonce-value",
    prompt: "synthetic-private-prompt-excerpt",
  };
  await writeFile(join(state, "controller.lock"), JSON.stringify(lock), {
    mode: 0o600,
  });
  await assert.rejects(
    exec(process.execPath, [...args, "serve"], { timeout: 5000 }),
    (error: any) => {
      assert.equal(error.code, 1);
      assert.ok(!error.stderr.includes(lock.nonce));
      assert.ok(!error.stderr.includes(lock.prompt));
      return true;
    },
  );
  const contents = await readFile(
    join(state, "logs", "operations.jsonl"),
    "utf8",
  );
  const records = contents
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    records.some(
      (record) =>
        record.event === "controller_start_failed" &&
        record.phase === "controller_lock",
    ),
  );
  assert.ok(!contents.includes(lock.nonce));
  assert.ok(!contents.includes(lock.prompt));
  assert.deepEqual(
    JSON.parse(await readFile(join(state, "controller.lock"), "utf8")),
    lock,
  );
});
