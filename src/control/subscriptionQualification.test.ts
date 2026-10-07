import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  SUBSCRIPTION_GATES,
  subscriptionImplementationHash,
  assertSubscriptionQualification,
} from "./subscriptionQualification.js";
import { authEnvironmentSchema, authPolicyHash } from "./authEnvironment.js";
import { goalSchema } from "./schema.js";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";

test("subscription admission requires exact private evidence and refuses expiry, replacement, widening and symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-qualification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const auth = authEnvironmentSchema.parse({
    id: "dedicated",
    harness: "codex",
    sessionDir: "dedicated",
    imageDigest: "sha256:" + "a".repeat(64),
    egress: { hosts: ["example.invalid"] },
  });
  const config = goalSchema.parse({
    title: "Synthetic",
    description: "Synthetic",
    repoPath: root,
    projectId: "synthetic",
    backend: { kind: "codex", model: "synthetic" },
    maxCostUsd: 0,
    estimatePerRunUsd: 0,
    maxWorkers: 1,
    timeoutMs: 1000,
    maxAttempts: 2,
    executionContract: {
      harness: "codex",
      provider: "codex-subscription",
      authentication: { kind: "session", reference: auth.id },
      execution: "isolated",
      usagePolicy: {
        kind: "subscription",
        maxAttempts: 2,
        maxConcurrency: 1,
        timeoutMs: 1000,
      },
    },
    admission: {
      configurationHash: "c".repeat(64),
      runtimeHash: "d".repeat(64),
      executionMode: "isolated",
      providerId: "subscription",
      executionImageDigest: auth.imageDigest,
      authenticationPolicyHash: authPolicyHash(auth),
      prompts: [],
    },
  });
  const check = (input = config) =>
    assertSubscriptionQualification(root, input, auth, 1000);
  assert.throws(() => check(), /acceptance/);
  const directory = join(root, "qualification/subscriptions/dedicated");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bytes = "Synthetic acceptance fixture, not vendor qualification";
  await writeFile(join(directory, "proof.json"), bytes, { mode: 0o600 });
  const receipt = {
    schemaVersion: 1,
    authId: auth.id,
    providerId: "subscription",
    model: "synthetic",
    imageDigest: auth.imageDigest,
    authenticationPolicyHash: authPolicyHash(auth),
    implementationHash: subscriptionImplementationHash(),
    platform: process.platform,
    architecture: process.arch,
    expiresAt: new Date(2000).toISOString(),
    gates: SUBSCRIPTION_GATES.map((id) => ({
      id,
      passed: true,
      evidenceFile: "proof.json",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  const path = join(directory, "receipt.json");
  const save = async (value = receipt) =>
    writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await save();
  check();
  const db = new SqliteStore(join(root, "test.db"));
  t.after(() => db.close());
  const refused = new ControlStore(db);
  assert.throws(() => refused.createGoal(config), /qualified/);
  const store = new ControlStore(
    db,
    () => 1000,
    (input) => assertSubscriptionQualification(root, input, auth, 1000),
  );
  const goal = store.createGoal(config);
  assert.equal(goal.config.executionContract?.usagePolicy.kind, "subscription");
  assert.equal(store.canSpend(goal.id).reservedUsd, 0);
  for (const change of [
    { model: "other" },
    { implementationHash: "b".repeat(64) },
    { expiresAt: new Date(1000).toISOString() },
    { expiresAt: new Date(1000 + 31 * 86400000).toISOString() },
    { gates: receipt.gates.slice(1) },
    { gates: [...receipt.gates.slice(1), receipt.gates[1]] },
  ]) {
    await save({ ...receipt, ...change });
    assert.throws(() => check(), /acceptance/);
  }
  await save();
  assert.throws(
    () =>
      check({
        ...config,
        admission: { ...config.admission!, providerId: "other" },
      }),
    /acceptance/,
  );
  await chmod(path, 0o644);
  assert.throws(() => check(), /acceptance/);
  await chmod(path, 0o600);
  await writeFile(join(directory, "proof.json"), "changed");
  assert.throws(() => check(), /acceptance/);
  await rm(join(directory, "proof.json"));
  await writeFile(join(root, "outside"), bytes, { mode: 0o600 });
  await symlink(join(root, "outside"), join(directory, "proof.json"));
  assert.throws(() => check(), /acceptance/);
  assert.throws(() => store.createGoal(config), /acceptance/);
  assert.equal(store.goals().length, 1);
});
