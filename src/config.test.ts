import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeConfiguration,
  loadConfiguration,
  effectiveGoal,
  readSecret,
} from "./config.js";
import { userPaths } from "./paths.js";
import { goalSchema, backendSchema, policySchema } from "./control/schema.js";
import { validateExecutionLimits } from "./control/executionContract.js";

test("Matrix setup uses its scoped controller reference before token provisioning", async (t) => {
  const f = await fixture(t);
  const connector = {
    id: "matrix",
    kind: "matrix",
    enabled: true,
    controllerCredential: { kind: "file", path: "connector-matrix" },
    bindings: [
      {
        connectorId: "matrix",
        kind: "matrix",
        operatorId: "operator",
        externalIdentity: "@operator:example.invalid",
        destination: "!room:example.invalid",
        projectIds: ["sample"],
        permissions: ["projects"],
        enabled: true,
      },
    ],
    settings: {},
  };
  await writeFile(
    join(f.configDir, "config.json"),
    JSON.stringify({
      ...f.settings,
      files: { ...f.settings.files, connectors: ["connector.json"] },
    }),
  );
  await writeFile(
    join(f.configDir, "connector.json"),
    JSON.stringify(connector),
  );
  const loaded = await loadConfiguration(f.configDir);
  assert.equal(loaded.connectors[0].credential, undefined);
  await writeFile(
    join(f.configDir, "connector.json"),
    JSON.stringify({
      ...connector,
      controllerCredential: undefined,
      credential: { kind: "file", path: "unrelated-session" },
    }),
  );
  await assert.rejects(loadConfiguration(f.configDir), /explicit credentials/);
});

test("provider configuration resolves exact authentication/protocol and permits disabled subscription preparation", async (t) => {
  const f = await fixture(t);
  const contract = {
    harness: "tool-loop",
    provider: "azure",
    authentication: { kind: "controller", reference: "cloud" },
    execution: "isolated",
    usagePolicy: { kind: "metered", maxCostUsd: 5, estimatePerRunUsd: 1 },
  };
  const backend = {
    kind: "azure",
    model: "synthetic",
    endpoint: "https://example.invalid",
    credential: "key",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
  };
  const provider = {
    id: "cloud",
    enabled: false,
    backend,
    executionContract: contract,
  };
  const runtime = {
    id: "worker",
    isolatedRuntime: {
      projects: {},
      providers: {
        cloud: {
          protocol: "tool-loop",
          backend,
          authentication: {
            kind: "secret",
            reference: { kind: "file", path: "synthetic-key" },
          },
        },
      },
    },
  };
  await writeFile(
    join(f.configDir, "config.json"),
    JSON.stringify({
      ...f.settings,
      files: {
        ...f.settings.files,
        providers: ["provider.json"],
        hosts: ["host.json"],
        auth: ["auth.json"],
      },
    }),
  );
  await writeFile(join(f.configDir, "provider.json"), JSON.stringify(provider));
  await writeFile(join(f.configDir, "host.json"), JSON.stringify(runtime));
  await writeFile(
    join(f.configDir, "auth.json"),
    JSON.stringify({
      id: "dedicated",
      harness: "codex",
      imageDigest: `sha256:${"a".repeat(64)}`,
      sessionDir: "dedicated",
      egress: { hosts: ["provider.example"] },
    }),
  );
  assert.equal((await loadConfiguration(f.configDir)).providers.length, 1);
  for (const changed of [
    { ...provider, executionContract: undefined },
    {
      ...provider,
      executionContract: {
        ...contract,
        authentication: { kind: "controller", reference: "other" },
      },
    },
    { ...provider, backend: { ...backend, model: "unapproved" } },
    { ...provider, credential: { kind: "file", path: "ignored-key" } },
  ]) {
    await writeFile(
      join(f.configDir, "provider.json"),
      JSON.stringify(changed),
    );
    await assert.rejects(
      loadConfiguration(f.configDir),
      /executionContract|reference|differs|credentials/,
    );
  }
  const subscription = {
    id: "cloud",
    enabled: false,
    backend: { kind: "codex", model: "synthetic" },
    executionContract: {
      harness: "codex",
      provider: "codex-subscription",
      authentication: { kind: "session", reference: "dedicated" },
      execution: "isolated",
      usagePolicy: {
        kind: "subscription",
        maxAttempts: 2,
        timeoutMs: 10000,
        maxConcurrency: 1,
      },
    },
  };
  await writeFile(
    join(f.configDir, "provider.json"),
    JSON.stringify(subscription),
  );
  await writeFile(
    join(f.configDir, "projects/sample.json"),
    JSON.stringify({
      ...f.project,
      enabled: false,
      provider: "cloud",
      executionMode: "isolated",
      config: {
        ...f.project.config,
        maxCostUsd: 0,
        estimatePerRunUsd: 0,
        maxWorkers: 1,
        maxAttempts: 2,
        timeoutMs: 10000,
      },
    }),
  );
  await writeFile(
    join(f.configDir, "config.json"),
    JSON.stringify({
      ...f.settings,
      authority: { allowedExecutionModes: ["fake", "isolated"] },
      files: {
        ...f.settings.files,
        providers: ["provider.json"],
        hosts: ["host.json"],
        auth: ["auth.json"],
      },
    }),
  );
  await writeFile(
    join(f.configDir, "host.json"),
    JSON.stringify({
      id: "worker",
      isolatedRuntime: {
        projects: { sample: { imageDigest: `sha256:${"a".repeat(64)}` } },
        providers: {
          cloud: {
            protocol: "subscription",
            harness: "codex",
            model: "synthetic",
            authentication: { kind: "session", reference: "dedicated" },
          },
        },
      },
    }),
  );
  const staged = await loadConfiguration(f.configDir);
  assert.equal(
    effectiveGoal(staged, "sample", "Prepare login").executionContract
      ?.usagePolicy.kind,
    "subscription",
  );
  const admitted = effectiveGoal(staged, "sample", "Prepare login").admission!;
  assert.equal(admitted.executionImageDigest, staged.auth[0].imageDigest);
  assert.match(admitted.authenticationPolicyHash!, /^[a-f0-9]{64}$/);
  const host = {
    id: "worker",
    isolatedRuntime: {
      projects: { sample: { imageDigest: staged.auth[0].imageDigest } },
      providers: {
        cloud: {
          protocol: "subscription",
          harness: "codex",
          model: "synthetic",
          authentication: { kind: "session", reference: "dedicated" },
        },
      },
    },
  };
  for (const changed of [
    {
      ...host,
      isolatedRuntime: {
        ...host.isolatedRuntime,
        projects: { sample: { imageDigest: `sha256:${"b".repeat(64)}` } },
      },
    },
    {
      ...host,
      isolatedRuntime: {
        ...host.isolatedRuntime,
        providers: {
          cloud: { ...host.isolatedRuntime.providers.cloud, model: "other" },
        },
      },
    },
    {
      ...host,
      isolatedRuntime: {
        ...host.isolatedRuntime,
        providers: {
          cloud: {
            ...host.isolatedRuntime.providers.cloud,
            authentication: { kind: "session", reference: "other" },
          },
        },
      },
    },
    { ...host, isolatedRuntime: { ...host.isolatedRuntime, providers: {} } },
  ]) {
    await writeFile(join(f.configDir, "host.json"), JSON.stringify(changed));
    await assert.rejects(
      loadConfiguration(f.configDir),
      /pinned image|differs|runtime definition/,
    );
  }
  await writeFile(join(f.configDir, "host.json"), JSON.stringify(host));
  await writeFile(
    join(f.configDir, "host-two.json"),
    JSON.stringify({ ...host, id: "second" }),
  );
  await writeFile(
    join(f.configDir, "config.json"),
    JSON.stringify({
      ...staged.settings,
      files: {
        ...staged.settings.files,
        hosts: ["host.json", "host-two.json"],
      },
    }),
  );
  await assert.rejects(loadConfiguration(f.configDir), /multiple runtimes/);
  await writeFile(
    join(f.configDir, "config.json"),
    JSON.stringify(staged.settings),
  );
  await writeFile(
    join(f.configDir, "provider.json"),
    JSON.stringify({ ...subscription, enabled: true }),
  );
  await writeFile(
    join(f.configDir, "projects/sample.json"),
    JSON.stringify({
      ...staged.projects[0],
      enabled: true,
      config: {
        ...staged.projects[0].config,
        containerImage: "sha256:" + "a".repeat(64),
      },
    }),
  );
  await writeFile(
    join(f.configDir, "config.json"),
    JSON.stringify({
      ...staged.settings,
      authority: {
        ...staged.settings.authority,
        allowedProviders: ["cloud"],
        allowedExecutionModes: ["isolated"],
      },
    }),
  );
  const recoverable = await loadConfiguration(f.configDir);
  assert.throws(
    () => effectiveGoal(recoverable, "sample", "Coding admission"),
    /acceptance/,
  );
  assert.ok(
    effectiveGoal(recoverable, "sample", "Maintenance inspection", {}, false),
  );
});

test("execution limits reject absent real contracts, unsupported native providers and subscription widening", () => {
  const input = goalSchema.parse({
    title: "Synthetic",
    description: "Synthetic",
    repoPath: "/synthetic",
    backend: { kind: "codex", model: "synthetic" },
    maxWorkers: 1,
    maxAttempts: 2,
    timeoutMs: 10000,
    executionContract: {
      harness: "codex",
      provider: "codex-subscription",
      authentication: { kind: "session", reference: "dedicated" },
      execution: "isolated",
      usagePolicy: {
        kind: "subscription",
        maxAttempts: 2,
        timeoutMs: 10000,
        maxConcurrency: 1,
      },
    },
  });
  validateExecutionLimits(input);
  for (const changed of [
    { maxCostUsd: 1 },
    { estimatePerRunUsd: 1 },
    { maxWorkers: 2 },
    { maxAttempts: 3 },
    { timeoutMs: 10001 },
    { executionContract: undefined },
  ])
    assert.throws(
      () => validateExecutionLimits({ ...input, ...changed }),
      /Subscription|subscription|executionContract/,
    );
  assert.throws(
    () =>
      validateExecutionLimits({
        ...input,
        executionContract: {
          harness: "codex",
          provider: "bedrock",
          authentication: { kind: "controller", reference: "cloud" },
          execution: "isolated",
          usagePolicy: { kind: "metered", maxCostUsd: 5, estimatePerRunUsd: 1 },
        },
      }),
    /Bedrock/,
  );
});

test("goal defaults select synthetic execution and reject hidden provider/policy keys or alternate native executables", () => {
  assert.equal(
    goalSchema.parse({
      title: "Synthetic",
      description: "Synthetic",
      repoPath: "/synthetic",
    }).backend.kind,
    "fake",
  );
  assert.throws(
    () => backendSchema.parse({ kind: "fake", credential: "synthetic" }),
    /Unrecognized key/,
  );
  assert.throws(
    () => policySchema.parse({ publish: false, unknownAuthority: true }),
    /Unrecognized key/,
  );
  assert.throws(
    () =>
      backendSchema.parse({ kind: "codex", command: "/ambient/private/tool" }),
    /codex/,
  );
  assert.throws(
    () =>
      goalSchema.parse({
        title: "Synthetic",
        description: "Synthetic",
        repoPath: "/synthetic",
        repository: { mode: "local", branch: "main", credentials: "synthetic" },
      }),
    /Unrecognized key/,
  );
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "mc-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config"),
    state = join(root, "state"),
    secrets = join(root, "secrets");
  const initial = await initializeConfiguration(configDir, state, secrets);
  await mkdir(join(configDir, "projects"));
  await mkdir(join(configDir, "profiles"));
  const settings = {
    ...initial.settings,
    files: {
      ...initial.settings.files,
      projects: ["projects/sample.json"],
      profiles: ["profiles/base.json"],
    },
  };
  await writeFile(join(configDir, "config.json"), JSON.stringify(settings));
  await writeFile(
    join(configDir, "profiles/base.json"),
    JSON.stringify({
      id: "base",
      defaults: {
        backend: { kind: "fake" },
        maxWorkers: 1,
        timeoutMs: 10000,
        policy: { targetBranch: "main", approvedPaths: ["src/**"] },
      },
    }),
  );
  const project = {
    id: "sample",
    name: "Sample",
    enabled: true,
    profile: "base",
    config: {
      repoPath: "../../repository",
      repository: { mode: "local", branch: "main" },
      verificationCommands: ["true"],
      policy: { protectedPaths: ["private/**"] },
    },
  };
  await writeFile(
    join(configDir, "projects/sample.json"),
    JSON.stringify(project),
  );
  return { root, configDir, state, secrets, settings, project };
}
test("configuration preserves precedence and resolves repositories from their declaring file", async (t) => {
  const f = await fixture(t),
    c = await loadConfiguration(f.configDir),
    g = effectiveGoal(c, "sample", "Synthetic task");
  assert.equal(g.repoPath, join(f.root, "repository"));
  assert.equal(g.backend.kind, "fake");
  assert.equal(g.maxWorkers, 1);
  assert.equal(g.timeoutMs, 10000);
  assert.equal(g.policy.targetBranch, "main");
  assert.deepEqual(g.policy.approvedPaths, ["src/**"]);
  assert.deepEqual(g.policy.protectedPaths, ["private/**"]);
  assert.equal(
    effectiveGoal(c, "sample", "Task", { timeoutMs: 5000 }).timeoutMs,
    5000,
  );
  assert.throws(
    () => effectiveGoal(c, "sample", "Task", { timeoutMs: 20000 }),
    /increase/,
  );
  assert.throws(
    () => effectiveGoal(c, "sample", "Task", { repoPath: "/elsewhere" }),
    /override/,
  );
  assert.throws(
    () => effectiveGoal(c, "sample", "Task", { backend: { kind: "codex" } }),
    /override/,
  );
  assert.throws(
    () => effectiveGoal(c, "sample", "Task", { policy: { publish: true } }),
    /override/,
  );
});
test("configuration rejects unknown keys, missing references, reserved ports and redirected files", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.configDir, "projects/sample.json"),
    JSON.stringify({ ...f.project, accidentalSecret: "synthetic" }),
  );
  await assert.rejects(loadConfiguration(f.configDir), /Unrecognized key/);
  await writeFile(
    join(f.configDir, "projects/sample.json"),
    JSON.stringify({ ...f.project, profile: "missing" }),
  );
  await assert.rejects(loadConfiguration(f.configDir), /Unknown profile/);
  await writeFile(
    join(f.configDir, "config.json"),
    JSON.stringify({ ...f.settings, server: { port: 43190 } }),
  );
  await assert.rejects(loadConfiguration(f.configDir), /reserved/);
  await writeFile(join(f.configDir, "config.json"), JSON.stringify(f.settings));
  await rm(join(f.configDir, "projects/sample.json"));
  await writeFile(join(f.root, "outside.json"), JSON.stringify(f.project));
  await symlink(
    join(f.root, "outside.json"),
    join(f.configDir, "projects/sample.json"),
  );
  await assert.rejects(loadConfiguration(f.configDir), /escapes|symlink/);
});
test("credential references enforce private files and state never defaults into source", async (t) => {
  const f = await fixture(t);
  await mkdir(f.secrets, { mode: 0o700 });
  await writeFile(join(f.secrets, "token"), "synthetic-token", { mode: 0o600 });
  assert.equal(
    await readSecret({ kind: "file", path: "token" }, f.secrets),
    "synthetic-token",
  );
  await writeFile(join(f.secrets, "open"), "synthetic", { mode: 0o644 });
  // Creation mode is filtered by umask; ensure this fixture is non-private.
  await chmod(join(f.secrets, "open"), 0o644);
  await assert.rejects(
    readSecret({ kind: "file", path: "open" }, f.secrets),
    /private/,
  );
  await symlink(join(f.secrets, "token"), join(f.secrets, "link"));
  await assert.rejects(
    readSecret({ kind: "file", path: "link" }, f.secrets),
    /private/,
  );
  await writeFile(
    join(f.configDir, "config.json"),
    JSON.stringify({ ...f.settings, stateDir: "state" }),
  );
  await assert.rejects(loadConfiguration(f.configDir), /outside/);
  assert.equal(
    userPaths("linux", "/example", {}).state,
    "/example/.local/state/mission-control",
  );
  assert.match(
    userPaths("darwin", "/example", {}).state,
    /Application Support\/MissionControl\/state$/,
  );
});

test("configuration revision includes built-in assets and rejects duplicate prompts and runtime keys", async (t) => {
  const f = await fixture(t),
    c = await loadConfiguration(f.configDir);
  assert.ok(c.profiles.some((p) => p.id === "builtin.synthetic"));
  await writeFile(
    join(f.configDir, "p.json"),
    JSON.stringify({ id: "instruction", path: "prompt.txt" }),
  );
  await writeFile(join(f.configDir, "prompt.txt"), "Synthetic instructions");
  await writeFile(
    join(f.configDir, "config.json"),
    JSON.stringify({
      ...f.settings,
      files: { ...f.settings.files, prompts: ["p.json", "p.json"] },
    }),
  );
  await assert.rejects(loadConfiguration(f.configDir), /Duplicate prompt/);
  await writeFile(
    join(f.configDir, "host.json"),
    JSON.stringify({
      id: "worker",
      isolatedRuntime: { projects: {}, providers: {}, unknown: true },
    }),
  );
  await writeFile(
    join(f.configDir, "config.json"),
    JSON.stringify({
      ...f.settings,
      files: { ...f.settings.files, hosts: ["host.json"] },
    }),
  );
  await assert.rejects(loadConfiguration(f.configDir), /Unrecognized key/);
});

test("private context is explicitly selected from approved roots and prompt selection stays project-scoped", async (t) => {
  const f = await fixture(t),
    contextRoot = join(f.root, "private-context");
  await mkdir(contextRoot);
  await writeFile(join(contextRoot, "spec.md"), "Private synthetic spec");
  await writeFile(
    join(f.configDir, "prompt.json"),
    JSON.stringify({ id: "instruction", path: "prompt.txt" }),
  );
  await writeFile(
    join(f.configDir, "prompt.txt"),
    "Synthetic project instruction",
  );
  await writeFile(
    join(f.configDir, "config.json"),
    JSON.stringify({
      ...f.settings,
      contextRoots: [{ id: "specs", path: "../private-context" }],
      files: { ...f.settings.files, prompts: ["prompt.json"] },
    }),
  );
  await writeFile(
    join(f.configDir, "projects/sample.json"),
    JSON.stringify({
      ...f.project,
      promptIds: ["instruction"],
      contextFiles: [{ rootId: "specs", path: "spec.md" }],
    }),
  );
  const loaded = await loadConfiguration(f.configDir),
    goal = effectiveGoal(loaded, "sample", "Synthetic goal");
  assert.equal(
    goal.admission?.prompts[0].content,
    "Synthetic project instruction",
  );
  assert.equal(goal.admission?.contexts[0].content, "Private synthetic spec");
  assert.equal(goal.admission?.contexts[0].path, "specs:spec.md");
  await writeFile(join(contextRoot, "spec.md"), "Revised private spec");
  const revised = await loadConfiguration(f.configDir);
  assert.notEqual(revised.hash, loaded.hash);
  assert.equal(revised.runtimeHash, loaded.runtimeHash);
  await symlink(join(contextRoot, "spec.md"), join(contextRoot, "link.md"));
  await writeFile(
    join(f.configDir, "projects/sample.json"),
    JSON.stringify({
      ...f.project,
      contextFiles: [{ rootId: "specs", path: "link.md" }],
    }),
  );
  await assert.rejects(loadConfiguration(f.configDir), /symlink/);
  await writeFile(
    join(f.configDir, "projects/sample.json"),
    JSON.stringify({ ...f.project, promptIds: ["missing"] }),
  );
  await assert.rejects(loadConfiguration(f.configDir), /Unknown prompt/);
});

test("authentication configuration rejects shared stores, ambient roots and claimed qualification", async (t) => {
  const f = await fixture(t),
    auth = {
      id: "subscription",
      harness: "codex",
      imageDigest: `sha256:${"a".repeat(64)}`,
      sessionDir: "dedicated",
      egress: { hosts: ["provider.example"] },
    };
  await writeFile(join(f.configDir, "auth.json"), JSON.stringify(auth));
  await writeFile(
    join(f.configDir, "config.json"),
    JSON.stringify({
      ...f.settings,
      files: { ...f.settings.files, auth: ["auth.json"] },
    }),
  );
  const loaded = await loadConfiguration(f.configDir);
  assert.equal(loaded.auth.length, 1);
  assert.equal(loaded.auth[0].qualified, false);
  await writeFile(
    join(f.configDir, "auth.json"),
    JSON.stringify({ ...auth, qualified: true }),
  );
  await assert.rejects(loadConfiguration(f.configDir));
  await writeFile(
    join(f.configDir, "auth.json"),
    JSON.stringify({ ...auth, sessionDir: "../../ambient" }),
  );
  await assert.rejects(loadConfiguration(f.configDir), /inside secretsDir/);
  await writeFile(join(f.configDir, "auth.json"), JSON.stringify(auth));
  await writeFile(
    join(f.configDir, "auth-two.json"),
    JSON.stringify({ ...auth, id: "another" }),
  );
  await writeFile(
    join(f.configDir, "config.json"),
    JSON.stringify({
      ...f.settings,
      files: { ...f.settings.files, auth: ["auth.json", "auth-two.json"] },
    }),
  );
  await assert.rejects(loadConfiguration(f.configDir), /share/);
});

test("enabled isolated project rejects missing verification image during validation", async (t) => {
  const f = await fixture(t);
  const config = await loadConfiguration(f.configDir);
  config.projects[0].enabled = true;
  config.projects[0].executionMode = "isolated";
  config.settings.authority.allowedExecutionModes = ["isolated"];
  assert.throws(
    () => effectiveGoal(config, config.projects[0].id, "Inspect"),
    /verification image/,
  );
});
