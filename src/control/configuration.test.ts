import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeConfiguration, loadConfiguration } from "../config.js";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import {
  applyConfiguration,
  assertOnlineConfigurationChange,
} from "./configuration.js";
import { startupConfiguration } from "./configuration.js";
test("online configuration admits work references but refuses installation authority changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-online-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await initializeConfiguration(
    join(root, "config"),
    join(root, "state"),
    join(root, "secrets"),
  );
  const next = {
    ...config,
    settings: {
      ...config.settings,
      files: {
        ...config.settings.files,
        projects: ["new-project.json"],
        prompts: ["new-prompt.json"],
        schedules: ["new-schedule.json"],
        profiles: ["new-profile.json"],
      },
    },
  };
  assert.doesNotThrow(() => assertOnlineConfigurationChange(config, next));
  for (const changed of [
    {
      ...next,
      settings: {
        ...next.settings,
        authority: { ...next.settings.authority, publish: true },
      },
    },
    {
      ...next,
      settings: {
        ...next.settings,
        contextRoots: [{ id: "other", path: root }],
      },
    },
    {
      ...next,
      settings: {
        ...next.settings,
        files: { ...next.settings.files, providers: ["new-provider.json"] },
      },
    },
    { ...next, connectors: [{ id: "new" }] },
    { ...next, auth: [{ id: "new" }] },
  ])
    assert.throws(
      () => assertOnlineConfigurationChange(config, changed as typeof config),
      /stopped-instance/,
    );
});
test("startup recovery selects applied auth identity before inspecting resource ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-startup-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await initializeConfiguration(
    join(root, "config"),
    join(root, "state"),
    join(root, "secrets"),
  );
  const db = new SqliteStore(join(root, "app.db")),
    store = new ControlStore(db);
  t.after(() => db.close());
  const applied = {
    ...config,
    hash: "a".repeat(64),
    auth: [{ id: "reviewed-identity" }],
  };
  store.setting("configuration-snapshot", applied);
  const selected = startupConfiguration(store, { ...config, auth: [] });
  assert.equal(selected.auth[0].id, "reviewed-identity");
  assert.equal(selected.hash, applied.hash);
  assert.throws(
    () =>
      startupConfiguration(store, {
        ...config,
        settings: { ...config.settings, secretsDir: join(root, "other") },
      }),
    /offline/,
  );
});
test("applied schedules reconcile templates without losing active goal ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-apply-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await initializeConfiguration(
    join(root, "config"),
    join(root, "state"),
    join(root, "secrets"),
  );
  const files = {
    ...config.settings.files,
    projects: ["project.json"],
    schedules: ["schedule.json"],
  };
  await writeFile(
    join(config.root, "config.json"),
    JSON.stringify({ ...config.settings, files }),
  );
  await writeFile(
    join(config.root, "project.json"),
    JSON.stringify({
      id: "sample",
      name: "Sample",
      enabled: true,
      profile: "builtin.synthetic",
      config: {
        repoPath: root,
        repository: { mode: "local", branch: "main" },
        verificationCommands: ["true"],
      },
    }),
  );
  const schedule = {
    id: "daily",
    projectId: "sample",
    description: "Synthetic schedule",
    intervalMs: 60000,
    enabled: true,
  };
  const path = join(config.root, "schedule.json");
  await writeFile(path, JSON.stringify(schedule));
  const db = new SqliteStore(join(root, "app.db")),
    store = new ControlStore(db);
  t.after(() => db.close());
  const loaded = await loadConfiguration(config.root);
  applyConfiguration(store, loaded);
  assert.equal(store.schedules().length, 1);
  const goal = store.createGoal(store.projects()[0].config);
  store.db.exec(`UPDATE control_schedules SET last_goal_id='${goal.id}'`);
  await writeFile(path, JSON.stringify({ ...schedule, intervalMs: 120000 }));
  applyConfiguration(store, await loadConfiguration(config.root));
  assert.equal(store.schedules()[0].last_goal_id, goal.id);
  assert.equal(store.schedules()[0].interval_ms, 120000);
  await writeFile(path, JSON.stringify({ ...schedule, enabled: false }));
  applyConfiguration(store, await loadConfiguration(config.root));
  assert.equal(store.schedules().length, 0);
  assert.equal(store.getGoal(goal.id).status, "planning");
});

test("cumulative installation admission is neutral across clients and never invents measured spending", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-intake-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new SqliteStore(join(root, "app.db")),
    store = new ControlStore(db);
  t.after(() => db.close());
  store.setting("configuration-snapshot", {
    settings: { authority: { maxTotalAdmittedCostUsd: 10 } },
  });
  const config = {
    title: "Synthetic",
    description: "Synthetic",
    repoPath: root,
    backend: { kind: "fake" as const },
    maxCostUsd: 6,
  };
  store.createGoal(config, "operator");
  assert.throws(() => store.createGoal(config, "schedule"), /Cumulative/);
  assert.equal(store.goals().length, 1);
  assert.equal(store.setting("admitted-cost-usd"), 6);
  const budget = store.canSpend(store.goals()[0].id);
  assert.equal(budget.reservedUsd, 0);
  assert.match(budget.costMeaning, /not measured/);
  store.setting("instance-maintenance", true);
  assert.throws(
    () => store.createGoal({ ...config, maxCostUsd: 0 }, "connector"),
    /Admissions paused/,
  );
  assert.equal(store.goals().length, 1);
});
