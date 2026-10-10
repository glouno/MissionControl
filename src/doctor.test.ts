import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readdir,
  mkdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose } from "./doctor.js";
import { initializeConfiguration } from "./config.js";
import { initializeState } from "./instance.js";
test("doctor inspects fresh disabled configuration without creating secrets, services or state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await initializeConfiguration(
    join(root, "config"),
    join(root, "state"),
    join(root, "secrets"),
  );
  await initializeState(config.settings.stateDir);
  const before = await readdir(config.settings.stateDir);
  const result = await diagnose(config);
  assert.equal(result.inspectionOnly, true);
  assert.equal(result.qualification, "alpha_unqualified");
  assert.equal(result.projects.length, 0);
  assert.equal(result.auth.length, 0);
  assert.equal(result.backup.enabled, false);
  assert.deepEqual(
    (await readdir(config.settings.stateDir)).filter(
      (n) => !n.endsWith("-wal") && !n.endsWith("-shm"),
    ),
    before,
  );
  assert.equal((await readdir(root)).includes("secrets"), false);
});

import {
  authEnvironmentSchema,
  authPolicyHash,
  initializeAuthEnvironment,
  acquireAuthEnvironment,
} from "./control/authEnvironment.js";
import { isolatedRuntimeSchema } from "./control/isolatedRuntime.js";
import {
  SUBSCRIPTION_GATES,
  subscriptionImplementationHash,
} from "./control/subscriptionQualification.js";

async function subscriptionFixture(t: TestContext, enabled = false) {
  const root = await mkdtemp(join(tmpdir(), "mc-doctor-subscription-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await initializeConfiguration(
    join(root, "config"),
    join(root, "state"),
    join(root, "secrets"),
  );
  await initializeState(config.settings.stateDir);
  config.settings.authority.allowedExecutionModes = ["isolated"];
  config.settings.authority.allowedProviders = ["cloud"];
  await mkdir(config.settings.secretsDir, { mode: 0o700 });
  const auth = authEnvironmentSchema.parse({
    id: "dedicated",
    harness: "codex",
    sessionDir: "dedicated",
    imageDigest: `sha256:${"a".repeat(64)}`,
    egress: { hosts: ["provider.example"] },
  });
  await initializeAuthEnvironment(auth, config.settings.secretsDir);
  config.auth = [auth];
  config.providers = [
    {
      id: "cloud",
      enabled,
      backend: { kind: "codex", command: "codex", model: "synthetic" },
      executionContract: {
        harness: "codex",
        provider: "codex-subscription",
        authentication: { kind: "session", reference: auth.id },
        execution: "isolated",
        usagePolicy: {
          kind: "subscription",
          maxAttempts: 2,
          maxConcurrency: 1,
          timeoutMs: 10000,
        },
      },
    },
  ];
  config.hosts = [
    {
      id: "worker",
      isolatedRuntime: isolatedRuntimeSchema.parse({
        projects: { sample: { imageDigest: auth.imageDigest } },
        providers: {
          cloud: {
            protocol: "subscription",
            harness: "codex",
            model: "synthetic",
            authentication: { kind: "session", reference: auth.id },
          },
        },
      }),
    },
  ];
  config.projects = [
    {
      id: "sample",
      name: "Sample",
      family: "synthetic",
      enabled,
      provider: "cloud",
      executionMode: "isolated",
      contextFiles: [],
      promptIds: [],
      config: {
        repoPath: root,
        containerImage: auth.imageDigest,
        maxCostUsd: 0,
        estimatePerRunUsd: 0,
        maxWorkers: 1,
        maxAttempts: 2,
        timeoutMs: 10000,
      },
    },
  ];
  const calls: string[][] = [];
  const command = (file: string, args: string[]) => {
    calls.push([file, ...args]);
    return {
      status: 0,
      stdout: args.includes("inspect") ? auth.imageDigest : "synthetic-version",
    };
  };
  return { config, auth, calls, command };
}

test("doctor exposes subscription image/policy/writer qualification faults without starting native tools or pulling images", async (t) => {
  const { config, auth, calls, command } = await subscriptionFixture(t);
  const result = await diagnose(config, { command });
  const project = result.projects[0];
  assert.equal(project.ready, false);
  assert.equal(project.usageKind, "subscription");
  assert.equal(project.authId, auth.id);
  assert.ok(project.faults.some((f) => f.code === "subscription_unqualified"));
  assert.ok(
    !project.faults.some(
      (f) => f.code === "auth_unprepared" || f.code === "image_unavailable",
    ),
  );
  assert.equal(result.auth[0].nativeLoginInspected, false);
  assert.equal(result.auth[0].liveQualified, false);
  assert.equal(project.liveQualified, false);
  assert.ok(
    calls.every(
      ([file, ...args]) =>
        [
          "git",
          "docker",
          "age",
          ...(process.platform === "darwin" ? ["python3"] : []),
        ].includes(file) &&
        !args.some((a) =>
          ["run", "exec", "pull", "build", "login"].includes(a),
        ),
    ),
  );
  const writer = await acquireAuthEnvironment(auth, config.settings.secretsDir);
  try {
    assert.ok(
      (await diagnose(config, { command })).projects[0].faults.some(
        (f) => f.code === "auth_writer_active",
      ),
    );
  } finally {
    await writer.release();
  }
  config.auth = [
    { ...auth, egress: { ...auth.egress, hosts: ["other.example"] } },
  ];
  const changed = await diagnose(config, {
    command: () => ({ status: 1, stdout: "" }),
  });
  assert.ok(
    changed.projects[0].faults.some((f) => f.code === "auth_unprepared"),
  );
  assert.ok(
    changed.projects[0].faults.some((f) => f.code === "docker_unavailable"),
  );
});

for (const scenario of [
  { name: "valid", qualified: true, change: {} },
  { name: "missing", qualified: false, change: {} },
  {
    name: "expired",
    qualified: false,
    change: { expiresAt: new Date(0).toISOString() },
  },
  {
    name: "mismatched provider",
    qualified: false,
    change: { providerId: "other" },
  },
  { name: "mismatched model", qualified: false, change: { model: "other" } },
  {
    name: "mismatched implementation",
    qualified: false,
    change: { implementationHash: "b".repeat(64) },
  },
  { name: "valid with active writer", qualified: true, change: {} },
  {
    name: "valid with disabled project and provider",
    qualified: true,
    change: {},
  },
]) {
  test(`doctor reports ${scenario.name} private subscription receipt independently of admission`, async (t) => {
    const disabled =
      scenario.name === "valid with disabled project and provider";
    const busy = scenario.name === "valid with active writer";
    const { config, auth, calls, command } = await subscriptionFixture(
      t,
      !disabled,
    );
    const directory = join(
      config.settings.stateDir,
      "qualification",
      "subscriptions",
      auth.id,
    );
    const receiptPath = join(directory, "receipt.json");
    let receiptBytes: string | undefined;
    if (scenario.name !== "missing") {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const evidence = "Synthetic doctor fixture, not vendor qualification";
      await writeFile(join(directory, "proof.json"), evidence, { mode: 0o600 });
      receiptBytes = JSON.stringify({
        schemaVersion: 1,
        authId: auth.id,
        providerId: "cloud",
        model: "synthetic",
        imageDigest: auth.imageDigest,
        authenticationPolicyHash: authPolicyHash(auth),
        implementationHash: subscriptionImplementationHash(),
        platform: process.platform,
        architecture: process.arch,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        gates: SUBSCRIPTION_GATES.map((id) => ({
          id,
          passed: true,
          evidenceFile: "proof.json",
          sha256: createHash("sha256").update(evidence).digest("hex"),
        })),
        ...scenario.change,
      });
      await writeFile(receiptPath, receiptBytes, { mode: 0o600 });
    }
    const writer = busy
      ? await acquireAuthEnvironment(auth, config.settings.secretsDir)
      : undefined;
    try {
      const result = await diagnose(config, { command });
      const project = result.projects[0];
      const identity = result.auth[0];
      assert.equal(project.liveQualified, scenario.qualified);
      assert.equal(identity.liveQualified, scenario.qualified);
      assert.equal(identity.prepared, true);
      assert.equal(identity.policyMatches, true);
      assert.equal(identity.writerActive, busy);
      assert.equal(project.nativeLoginInspected, false);
      assert.equal(identity.nativeLoginInspected, false);
      assert.equal(result.qualification, "alpha_unqualified");
      assert.equal(result.inspectionOnly, true);
      assert.equal(project.ready, scenario.qualified && !busy && !disabled);
      assert.equal(
        project.faults.some((f) => f.code === "subscription_unqualified"),
        !scenario.qualified,
      );
      if (busy) {
        assert.deepEqual(
          project.faults.map((f) => f.code),
          ["auth_writer_active"],
        );
        assert.equal(
          identity.action,
          "Inspect/recover the dedicated writer before admission",
        );
      } else if (scenario.qualified) {
        assert.equal(
          identity.action,
          "Private subscription qualification is valid; native login was not inspected",
        );
        assert.deepEqual(
          project.faults.map((f) => f.code),
          disabled ? ["project_disabled", "provider_disabled"] : [],
        );
      }
      assert.ok(
        calls.every(
          ([file, ...args]) =>
            [
              "git",
              "docker",
              "age",
              ...(process.platform === "darwin" ? ["python3"] : []),
            ].includes(file) &&
            !args.some((a) =>
              ["run", "exec", "pull", "build", "login"].includes(a),
            ),
        ),
      );
      if (receiptBytes !== undefined)
        assert.equal(await readFile(receiptPath, "utf8"), receiptBytes);
      else await assert.rejects(readFile(receiptPath), { code: "ENOENT" });
    } finally {
      await writer?.release();
    }
  });
}
