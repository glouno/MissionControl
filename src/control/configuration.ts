import type { LoadedConfiguration } from "../config.js";
import { effectiveGoal } from "../config.js";
import { sql } from "../sqlite.js";
import type { ControlStore } from "./store.js";

/** Online edits can change admitted work, never the installation's authority. */
export function assertOnlineConfigurationChange(
  current: LoadedConfiguration,
  next: LoadedConfiguration,
) {
  const installation = (c: LoadedConfiguration) => {
    const { files, ...settings } = c.settings;
    return {
      root: c.root,
      settings,
      // Referenced work definitions are reviewed by the loader and activated
      // atomically. Their file-list locations do not change runtime authority.
      files: {
        providers: files.providers,
        hosts: files.hosts,
        auth: files.auth,
        connectors: files.connectors,
      },
      hosts: c.hosts,
      providers: c.providers,
      auth: c.auth,
      connectors: c.connectors,
    };
  };
  if (
    JSON.stringify(installation(current)) !== JSON.stringify(installation(next))
  )
    throw new Error(
      "Installation authority, server, provider, authentication, connector and host changes require stopped-instance configuration activation",
    );
}

/** Startup and dispatch must use the same explicitly applied snapshot. */
export function startupConfiguration(
  store: ControlStore,
  requested: LoadedConfiguration,
) {
  const applied = store.setting("configuration-snapshot") as
    LoadedConfiguration | undefined;
  if (
    applied &&
    (applied.settings.stateDir !== requested.settings.stateDir ||
      applied.root !== requested.root ||
      applied.settings.secretsDir !== requested.settings.secretsDir)
  )
    throw Error(
      "Restored or relocated instance requires config apply --offline before starting",
    );
  return applied ?? requested;
}

/** Activate external configuration atomically; admitted goals remain unchanged. */
export function applyConfiguration(
  store: ControlStore,
  next: LoadedConfiguration,
  offline = false,
) {
  return store.db.transaction(() => {
    store.setting("projects", []);
    for (const p of next.projects)
      store.setProject(
        {
          id: p.id,
          name: p.name,
          family: p.family,
          enabled: p.enabled,
          config: effectiveGoal(next, p.id, `Project ${p.name}`),
        },
        "configuration",
      );
    const prior = store.setting("configuration-schedules") as
      string[] | undefined;
    const enabled = next.schedules.filter((s) => s.enabled);
    for (const old of prior ?? [])
      if (!enabled.some((s) => s.id === old))
        store.db.exec(`DELETE FROM control_schedules WHERE id=${sql(old)}`);
    for (const s of enabled) {
      const project = next.projects.find((p) => p.id === s.projectId);
      if (!project?.enabled)
        throw new Error(`Schedule ${s.id} requires an enabled project`);
      const goal = store.validateGoalConfiguration(
        effectiveGoal(next, s.projectId, s.description),
      );
      store.db.exec(
        `INSERT INTO control_schedules(id,config,interval_ms,timezone,next_at,last_goal_id) VALUES(${sql(s.id)},${sql(store.redactor.json(goal))},${s.intervalMs},'UTC',${store.clock() + s.intervalMs},NULL) ON CONFLICT(id) DO UPDATE SET config=excluded.config,interval_ms=excluded.interval_ms`,
      );
    }
    store.setting(
      "configuration-schedules",
      enabled.map((s) => s.id),
    );
    store.setting("configuration-snapshot", next);
    store.setting("configuration", {
      hash: next.hash,
      projects: next.projects.map((p) => p.id),
      appliedAt: store.now(),
    });
    store.event("CONFIGURATION_APPLIED", "operator", {
      hash: next.hash,
      offline,
    });
    return { applied: true, hash: next.hash, offline };
  });
}
