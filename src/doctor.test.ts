import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
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

import { mkdir } from "node:fs/promises";
import {
  authEnvironmentSchema,
  initializeAuthEnvironment,
  acquireAuthEnvironment,
} from "./control/authEnvironment.js";
import { isolatedRuntimeSchema } from "./control/isolatedRuntime.js";
test("doctor exposes subscription image/policy/writer qualification faults without starting native tools or pulling images", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-doctor-subscription-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await initializeConfiguration(
    join(root, "config"),
    join(root, "state"),
    join(root, "secrets"),
  );
  await initializeState(config.settings.stateDir);
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
      enabled: false,
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
      enabled: false,
      provider: "cloud",
      executionMode: "isolated",
      contextFiles: [],
      promptIds: [],
      config: {
        repoPath: root,
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
  assert.ok(
    calls.every(
      ([file, ...args]) =>
        ["git", "docker", "age"].includes(file) &&
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
