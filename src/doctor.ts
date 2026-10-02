import { spawnSync } from "node:child_process";
import { statfs } from "node:fs/promises";
import type { LoadedConfiguration } from "./config.js";
import { effectiveGoal } from "./config.js";
import { inspectState } from "./instance.js";
import { inspectAuthEnvironment } from "./control/authEnvironment.js";
import { matrixLaunch } from "./control/matrixLifecycle.js";
export async function diagnose(
  config: LoadedConfiguration,
  options: {
    command?: (
      name: string,
      args: string[],
    ) => { status: number | null; stdout: string };
  } = {},
) {
  const command =
    options.command ??
    ((name: string, args: string[]) =>
      spawnSync(name, args, {
        timeout: 5000,
        maxBuffer: 65536,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
      }));
  const tools = ["git", "docker", "age"].map((name) => {
    const result = command(name, ["--version"]);
    return {
      name,
      available: result.status === 0,
      version: result.status === 0 ? result.stdout.trim() : undefined,
    };
  });
  const docker = tools.find((t) => t.name === "docker")!.available;
  const daemon =
    docker &&
    command("docker", ["info", "--format", "{{.ServerVersion}}"]).status === 0;
  let state: unknown;
  try {
    state = await inspectState(config.settings.stateDir);
  } catch {
    state = {
      valid: false,
      action: "Initialize or inspect the configured private state directory",
    };
  }
  let storage: unknown;
  try {
    const fs = await statfs(config.settings.stateDir);
    const availableBytes = fs.bavail * fs.bsize;
    storage = {
      availableBytes,
      reserveBytes: config.settings.storage.freeReserveBytes,
      admissible: availableBytes >= config.settings.storage.freeReserveBytes,
    };
  } catch {
    storage = {
      admissible: false,
      action: "Configured state filesystem is unavailable",
    };
  }
  const auth: {
    id: string;
    prepared: boolean;
    writerActive?: boolean;
    policyMatches: boolean;
    nativeLoginInspected: boolean;
    liveQualified: boolean;
    action: string;
  }[] = [];
  for (const a of config.auth) {
    try {
      const info = await inspectAuthEnvironment(a, config.settings.secretsDir);
      auth.push({
        id: a.id,
        prepared: true,
        writerActive: !!info.writer,
        policyMatches: true,
        nativeLoginInspected: false,
        liveQualified: false,
        action: info.writer
          ? "Inspect/recover the dedicated writer before admission"
          : "Use private auth status/login and qualification workflows",
      });
    } catch {
      auth.push({
        id: a.id,
        prepared: false,
        policyMatches: false,
        nativeLoginInspected: false,
        liveQualified: false,
        action: "Run auth prepare with the configured dedicated environment",
      });
    }
  }
  const runtime = config.hosts.find((h) => h.isolatedRuntime)?.isolatedRuntime;
  const projects = config.projects.map((p) => {
    const faults: { code: string; action: string }[] = [];
    const fail = (code: string, action: string) =>
      faults.push({ code, action });
    if (!p.enabled)
      fail("project_disabled", "Enable the reviewed project explicitly");
    const provider = config.providers.find((v) => v.id === p.provider);
    if (provider && !provider.enabled)
      fail(
        "provider_disabled",
        "Enable the reviewed provider explicitly after qualification",
      );
    let goal;
    try {
      goal = effectiveGoal(config, p.id, "Readiness inspection");
    } catch (error) {
      fail(
        "configuration",
        error instanceof Error ? error.message : "Run config validate",
      );
    }
    const contract = provider?.executionContract;
    const kind =
      contract?.usagePolicy.kind ??
      (goal?.backend.kind === "fake" ? "synthetic" : "unknown");
    const image = runtime?.projects[p.id]?.imageDigest;
    if (p.executionMode === "isolated") {
      if (!daemon)
        fail(
          "docker_unavailable",
          "Install/start a qualified Docker daemon explicitly",
        );
      if (!image)
        fail(
          "image_unconfigured",
          "Configure a pinned isolated runtime image for this project",
        );
      else if (daemon) {
        const inspected = command("docker", [
          "image",
          "inspect",
          image,
          "--format",
          "{{.Id}}",
        ]);
        if (inspected.status !== 0 || inspected.stdout.trim() !== image)
          fail(
            "image_unavailable",
            "Prepare the approved image explicitly; doctor does not build or pull images",
          );
      }
    }
    if (kind === "subscription") {
      const environment = config.auth.find(
        (a) =>
          a.id ===
          (contract?.authentication.kind === "session"
            ? contract.authentication.reference
            : ""),
      );
      const inspection = auth.find((a) => a.id === environment?.id);
      if (!environment)
        fail(
          "auth_unconfigured",
          "Configure a matching dedicated authentication environment",
        );
      else {
        if (image !== environment.imageDigest)
          fail(
            "auth_image_mismatch",
            "Align the project and dedicated authentication image before admission",
          );
        if (!inspection?.prepared)
          fail(
            "auth_unprepared",
            "Prepare or repair the private authentication environment; policy changes require explicit recovery",
          );
        if (inspection?.writerActive)
          fail(
            "auth_writer_active",
            "Wait for or recover the dedicated authentication writer",
          );
      }
      fail(
        "subscription_unqualified",
        "Complete private login/refresh/restart/expiry and coding qualification; production admission is closed",
      );
    }
    return {
      id: p.id,
      enabled: p.enabled,
      executionMode: p.executionMode,
      providerId: p.provider,
      harness: contract?.harness ?? goal?.backend.kind,
      usageKind: kind,
      imageDigest: image,
      authId:
        contract?.authentication.kind === "session"
          ? contract.authentication.reference
          : undefined,
      ready: faults.length === 0,
      reason: faults[0]?.action,
      faults,
      nativeLoginInspected: false,
      liveQualified: false,
    };
  });
  const connectors = [];
  for (const c of config.connectors) {
    if (!c.enabled) {
      connectors.push({
        id: c.id,
        kind: c.kind,
        ready: false,
        reason: "Connector disabled",
      });
      continue;
    }
    if (c.kind === "matrix") {
      try {
        await matrixLaunch(config, c.id);
        connectors.push({
          id: c.id,
          kind: c.kind,
          ready: false,
          reason:
            "Launch configuration valid; use private SDK trust/session inspection and live qualification",
        });
      } catch {
        connectors.push({
          id: c.id,
          kind: c.kind,
          ready: false,
          reason:
            "Check companion binary, private configuration, binding and scoped credential paths",
        });
      }
    } else
      connectors.push({
        id: c.id,
        kind: c.kind,
        ready: !!c.credential,
        reason: c.credential
          ? "Transport health requires explicit connector execution"
          : "Configure a private credential reference",
      });
  }
  return {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    configValid: true,
    configHash: config.hash,
    state,
    tools,
    dockerDaemonAvailable: daemon,
    storage,
    auth,
    projects,
    connectors,
    backup: {
      enabled: config.settings.backup.enabled,
      configured: !!(
        config.settings.backup.destinationDir &&
        config.settings.backup.recipientFile
      ),
      restoreVerified: false,
    },
    qualification: "alpha_unqualified",
    inspectionOnly: true,
  };
}
