import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeAuthEnvironment,
  acquireAuthEnvironment,
  authEnvironmentSchema,
} from "./authEnvironment.js";
test("dedicated subscription stores start empty, fence identity/single writers and reject ambient roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-auth-environment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = join(root, "private");
  await mkdir(secrets, { mode: 0o700 });
  const config = authEnvironmentSchema.parse({
    id: "subscription",
    harness: "codex",
    imageDigest: `sha256:${"a".repeat(64)}`,
    sessionDir: "dedicated",
    egress: { hosts: ["provider.example"] },
  });
  await initializeAuthEnvironment(config, secrets);
  const owner = await acquireAuthEnvironment(config, secrets);
  assert.match(
    await readFile(join(owner.session, "config.toml"), "utf8"),
    /forced_login_method = "chatgpt"/,
  );
  await assert.rejects(acquireAuthEnvironment(config, secrets), /writer/);
  await owner.release();
  const again = await acquireAuthEnvironment(config, secrets);
  await again.release();
  await assert.rejects(
    initializeAuthEnvironment({ ...config, sessionDir: "../ambient" }, secrets),
    /explicit private/,
  );
  await writeFile(
    join(secrets, "dedicated/identity.json"),
    JSON.stringify({ schemaVersion: 1, id: "different", harness: "codex" }),
  );
  await assert.rejects(acquireAuthEnvironment(config, secrets), /identity/);
  const claude = {
    ...config,
    id: "claude",
    harness: "claude-code" as const,
    sessionDir: "claude",
  };
  await initializeAuthEnvironment(claude, secrets);
  const c = await acquireAuthEnvironment(claude, secrets);
  await symlink(join(root, "outside"), join(c.session, "redirect"));
  await assert.rejects(c.privateFiles(), /redirected/);
  await c.release();
});

test("auth crash recovery refuses live or changed writers and cleans resources before unlocking", async (t) => {
  const { recoverAuthEnvironment } = await import("./authEnvironment.js"),
    { hostname } = await import("node:os"),
    { randomUUID } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "mc-auth-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "private"), { mode: 0o700 });
  const config = authEnvironmentSchema.parse({
    id: "subscription",
    harness: "codex",
    imageDigest: `sha256:${"b".repeat(64)}`,
    sessionDir: "dedicated",
    egress: { hosts: ["provider.example"] },
  });
  await initializeAuthEnvironment(config, join(root, "private"));
  const owner = await acquireAuthEnvironment(config, join(root, "private"));
  await assert.rejects(
    recoverAuthEnvironment(
      config,
      join(root, "private"),
      owner.nonce,
      async () => {},
    ),
    /alive/,
  );
  await owner.release();
  const nonce = randomUUID(),
    lock = join(root, "private/dedicated/writer.lock");
  await writeFile(
    lock,
    JSON.stringify({
      pid: 2147483647,
      hostname: hostname(),
      nonce,
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  await assert.rejects(
    recoverAuthEnvironment(config, join(root, "private"), nonce, async () => {
      throw Error("daemon down");
    }),
    /daemon down/,
  );
  assert.ok(await readFile(lock, "utf8"));
  let cleaned = false;
  await recoverAuthEnvironment(
    config,
    join(root, "private"),
    nonce,
    async () => {
      cleaned = true;
      assert.ok(await readFile(lock, "utf8"));
    },
  );
  assert.equal(cleaned, true);
  const again = await acquireAuthEnvironment(config, join(root, "private"));
  await again.release();
});
