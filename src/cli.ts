#!/usr/bin/env node
import { assertSubscriptionQualification } from "./control/subscriptionQualification.js";
import { mkdir, readFile, writeFile, realpath, lstat } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { configRoot } from "./paths.js";
import {
  loadConfiguration,
  initializeConfiguration,
  effectiveGoal,
  readSecret,
  type LoadedConfiguration,
} from "./config.js";
import {
  initializeState,
  inspectState,
  lockInstance,
  recoverInstanceLock,
} from "./instance.js";
import { SqliteStore } from "./sqlite.js";
import { ControlStore } from "./control/store.js";
import { ControlClient } from "./control/client.js";
import { createControlServer } from "./control/api.js";
import { Scheduler } from "./control/scheduler.js";
import {
  createIsolatedRuntime,
  isolatedRuntimeSchema,
} from "./control/isolatedRuntime.js";
import { runMcp } from "./control/mcp.js";
import { isEntrypoint } from "./entrypoint.js";
import { createBackup, restoreBackup } from "./backup.js";
import { HumanCommandService } from "./control/human.js";
import {
  verifyBackupReceipt,
  pinBackupReceipt,
  pruneBackups,
} from "./backupRetention.js";
import { diagnose } from "./doctor.js";
import {
  prepareConnectorService,
  connectorServiceCommand,
} from "./connectorServices.js";
import { runMatrix } from "./control/matrixLifecycle.js";
import { serviceCommand } from "./service.js";
import { TelegramConnector } from "./control/telegramConnector.js";
import {
  applyConfiguration,
  assertOnlineConfigurationChange,
  startupConfiguration,
} from "./control/configuration.js";
import { createSyntheticProject } from "./setup.js";
import {
  initializeAuthEnvironment,
  inspectAuthEnvironment,
} from "./control/authEnvironment.js";
import { AuthRuntime } from "./control/authRuntime.js";
import { backupAuthStore, restoreAuthStore } from "./control/authBackup.js";
import { prepareBackupServices, runScheduledBackup } from "./backupPolicy.js";
import { fileURLToPath } from "node:url";
import { backupMatrixStore, restoreMatrixStore } from "./matrixRecovery.js";
import { createRecoverySet, restoreRecoverySet } from "./recoverySet.js";

const HELP = `mission-control — MissionControl v1
  --config-dir PATH init [--state-dir PATH] [--secrets-dir PATH] [--example]
  config validate|apply
  doctor | state inspect | state recover-lock --nonce NONCE
  backup create --destination PATH --recipient-file PATH [--offline|--complete]
  backup coordinated --destination FILE --recipient-file FILE
  restore coordinated --input FILE --identity-file FILE --destination PATH
  backup prepare --destination PATH | backup run
  backup verify --receipt PATH --identity-file PATH
  backup pin|unpin --receipt PATH | backup prune [--apply]
  restore --input PATH --identity-file PATH --destination PATH
  service install|status|start|stop|restart|uninstall
  connector list|health|provision|run ID
  connector prepare ID --destination PATH
  connector install|status|stop|restart|uninstall ID
  connector backup|restore --companion-config PATH --binary PATH --destination PATH
  auth list|prepare|inspect|status|login ID
  auth recover ID --nonce NONCE
  auth backup ID --destination PATH --recipient-file PATH
  auth restore ID --input PATH --identity-file PATH
  serve
  project list|readiness
  access list|create ID --project ID --permissions goals:read,goals:create --token-file PATH
  access revoke ID
  --token-file PATH selects a scoped API credential
  task inspect ID | goal attempts|evidence ID
  events --goal ID [--after CURSOR]
  backlog list --project ID [--status backlog|archived|launched]
  backlog add --project ID --input JSON_FILE
  backlog show ID --project ID
  backlog update ID --project ID --revision N --input JSON_FILE
  backlog archive|launch ID --project ID --revision N
  goal create --project ID --input FILE
  goal list|inspect|pause|resume|cancel ID
  schedule list
  question list|answer ID --option ID [--explanation TEXT]
  state usage | state reconcile-usage ATTEMPT_ID --input FILE
  mcp
Configuration, credentials and state live outside the source checkout.
Real execution requires a qualified isolated runtime. No host fallback is available.`;
function argumentsOf(args: string[]) {
  const flags: Record<string, string> = {},
    positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) {
      positional.push(args[i]);
      continue;
    }
    const [key, ...parts] = args[i].slice(2).split("=");
    const value = parts.length
      ? parts.join("=")
      : args[i + 1] && !args[i + 1].startsWith("--")
        ? args[++i]
        : "true";
    flags[key] = value;
  }
  return { flags, positional };
}
async function token(config: LoadedConfiguration) {
  return readSecret(
    { kind: "file", path: "operator-token" },
    config.settings.secretsDir,
  );
}
export async function main(args = process.argv.slice(2)) {
  process.umask(0o077);
  const {
      flags,
      positional: [command, action, id],
    } = argumentsOf(args),
    root = resolve(flags["config-dir"] || configRoot());
  if (!command || command === "help" || flags.help) {
    console.log(HELP);
    return;
  }
  if (command === "init") {
    const config = await initializeConfiguration(
      root,
      flags["state-dir"] && resolve(flags["state-dir"]),
      flags["secrets-dir"] && resolve(flags["secrets-dir"]),
    );
    await initializeState(config.settings.stateDir);
    await mkdir(config.settings.secretsDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(config.settings.secretsDir, "operator-token"),
      randomBytes(32).toString("hex") + "\n",
      { flag: "wx", mode: 0o600 },
    );
    const example = flags.example
      ? await createSyntheticProject(config)
      : undefined;
    output({
      initialized: true,
      configDir: root,
      stateDir: config.settings.stateDir,
      example,
    });
    return;
  }
  const config = await loadConfiguration(root);
  if (command === "restore" && action === "coordinated") {
    if (!flags.input || !flags["identity-file"] || !flags.destination)
      throw Error(
        "Coordinated restore requires input, age identity and new destination",
      );
    output(
      await restoreRecoverySet(
        config,
        resolve(flags.input),
        resolve(flags["identity-file"]),
        resolve(flags.destination),
      ),
    );
    return;
  }
  if (command === "backup" && action === "coordinated") {
    if (!flags.destination || !flags["recipient-file"])
      throw Error(
        "Coordinated backup requires new destination and recipient file; stop candidate controller/connectors first",
      );
    await inspectState(config.settings.stateDir);
    const unlock = await lockInstance(config.settings.stateDir);
    let db: SqliteStore | undefined;
    try {
      db = new SqliteStore(
        join(config.settings.stateDir, "mission-control.db"),
        { mustExist: true },
      );
      output(
        await createRecoverySet(
          new ControlStore(db),
          config,
          resolve(flags.destination),
          resolve(flags["recipient-file"]),
        ),
      );
    } finally {
      db?.close();
      await unlock();
    }
    return;
  }
  if (
    command === "backup" &&
    ["verify", "pin", "unpin", "prune"].includes(action)
  ) {
    if (action === "prune") {
      if (!config.settings.backup.destinationDir)
        throw Error("Configure backup destinationDir");
      output(
        await pruneBackups(
          config.settings.backup.destinationDir,
          !!flags.apply,
        ),
      );
      return;
    }
    if (!flags.receipt) throw Error("Select --receipt PATH");
    if (action === "verify") {
      if (!flags["identity-file"])
        throw Error("Private --identity-file required");
      output(
        await verifyBackupReceipt(
          resolve(flags.receipt),
          resolve(flags["identity-file"]),
        ),
      );
    } else
      output(await pinBackupReceipt(resolve(flags.receipt), action === "pin"));
    return;
  }
  if (
    command === "connector" &&
    (action === "backup" || action === "restore")
  ) {
    if (!flags["companion-config"] || !flags.binary || !flags.destination)
      throw new Error(
        "Matrix recovery requires --companion-config, --binary and --destination",
      );
    if (action === "backup") {
      if (!flags["recipient-file"])
        throw new Error("Matrix backup requires --recipient-file");
      output(
        await backupMatrixStore(
          resolve(flags["companion-config"]),
          resolve(flags.binary),
          resolve(flags.destination),
          resolve(flags["recipient-file"]),
        ),
      );
    } else {
      if (!flags.input || !flags["identity-file"])
        throw new Error("Matrix restore requires --input and --identity-file");
      output(
        await restoreMatrixStore(
          resolve(flags["companion-config"]),
          resolve(flags.binary),
          resolve(flags.input),
          resolve(flags["identity-file"]),
          resolve(flags.destination),
        ),
      );
    }
    return;
  }
  if (command === "backup" && action === "prepare") {
    if (!flags.destination)
      throw new Error(
        "Supply a new private directory for prepared backup service definitions",
      );
    output(
      await prepareBackupServices(
        root,
        config.settings.backup,
        resolve(flags.destination),
        process.platform,
        process.execPath,
        fileURLToPath(new URL("./cli.js", import.meta.url)),
      ),
    );
    return;
  }
  if (command === "backup" && action === "run") {
    if (
      flags.scheduled &&
      new Date().getUTCHours() !== config.settings.backup.hourUtc
    )
      return;
    output(
      await runScheduledBackup(
        new ControlClient(
          `http://127.0.0.1:${config.settings.server.port}`,
          await token(config),
        ),
        config.settings.backup,
      ),
    );
    return;
  }
  if (command === "auth") {
    if (action === "list") {
      output(
        config.auth.map((a) => ({
          id: a.id,
          harness: a.harness,
          qualified: false,
        })),
      );
      return;
    }
    const environment = config.auth.find((a) => a.id === id);
    if (!environment)
      throw new Error(
        "Select a configured dedicated authentication environment",
      );
    if (action === "inspect") {
      const info = await inspectAuthEnvironment(
        environment,
        config.settings.secretsDir,
      );
      output({ id, initialized: true, writer: info.writer, qualified: false });
      return;
    }
    if (
      !["prepare", "status", "login", "recover", "backup", "restore"].includes(
        action,
      )
    )
      throw new Error("Unsupported authentication command");
    if (action === "login" && (!process.stdin.isTTY || !process.stdout.isTTY))
      throw new Error(
        "Authentication login requires a private interactive terminal; do not run it in captured agent/CI logs",
      );
    await inspectState(config.settings.stateDir);
    const unlock = await lockInstance(config.settings.stateDir),
      db = new SqliteStore(
        join(config.settings.stateDir, "mission-control.db"),
        { mustExist: true },
      );
    const abort = new AbortController(),
      stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      if (action === "backup") {
        if (!flags.destination || !flags["recipient-file"])
          throw new Error(
            "Auth backup requires --destination and --recipient-file",
          );
        output(
          await backupAuthStore(
            new ControlStore(db),
            environment,
            config.settings.secretsDir,
            resolve(flags.destination),
            resolve(flags["recipient-file"]),
          ),
        );
        return;
      }
      if (action === "restore") {
        if (!flags.input || !flags["identity-file"])
          throw new Error(
            "Auth restore requires --input and --identity-file; configured session directory must be new",
          );
        output(
          await restoreAuthStore(
            new ControlStore(db),
            environment,
            config.settings.secretsDir,
            resolve(flags.input),
            resolve(flags["identity-file"]),
          ),
        );
        return;
      }
      if (action === "prepare") {
        output(
          await initializeAuthEnvironment(
            environment,
            config.settings.secretsDir,
          ),
        );
        return;
      }
      const runtime = new AuthRuntime(
        new ControlStore(db),
        config.settings.stateDir,
        config.settings.secretsDir,
        environment,
      );
      if (action === "recover") {
        if (!flags.nonce)
          throw new Error(
            "Authentication recovery requires --nonce from auth inspect",
          );
        output(await runtime.recover(flags.nonce));
        return;
      }
      output(await runtime.run(action as "status" | "login", abort.signal));
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      db.close();
      await unlock();
    }
    return;
  }
  if (command === "connector" && action === "list") {
    output(
      config.connectors.map((c) => ({
        id: c.id,
        kind: c.kind,
        enabled: c.enabled,
        bindings: c.bindings.length,
      })),
    );
    return;
  }
  if (command === "connector" && action === "prepare") {
    if (!id || !flags.destination)
      throw Error("Select connector ID and new --destination PATH");
    output(
      await prepareConnectorService(
        config,
        id,
        flags.destination,
        process.platform,
        process.execPath,
        fileURLToPath(new URL("./cli.js", import.meta.url)),
      ),
    );
    return;
  }
  if (
    command === "connector" &&
    ["install", "status", "stop", "restart", "uninstall"].includes(action)
  ) {
    if (!id) throw Error("Select connector ID");
    output(
      await connectorServiceCommand(
        config,
        id,
        action as "install" | "status" | "stop" | "restart" | "uninstall",
      ),
    );
    return;
  }
  if (command === "connector" && action === "run") {
    const connector = config.connectors.find((c) => c.id === id && c.enabled);
    if (connector?.kind === "matrix") {
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        await runMatrix(config, id, abort.signal);
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
      return;
    }
    if (!connector || connector.kind !== "telegram" || !connector.credential)
      throw new Error("Enabled Telegram connector and credential required");
    const credential = await readSecret(
        { kind: "file", path: `connector-${id}` },
        config.settings.secretsDir,
      ),
      client = new ControlClient(
        `http://127.0.0.1:${config.settings.server.port}`,
        credential,
      );
    const gateway = new TelegramConnector(
      client,
      await readSecret(connector.credential, config.settings.secretsDir),
      connector.bindings
        .filter((b) => b.enabled)
        .map((b) => b.externalIdentity),
      connector.bindings.filter((b) => b.enabled).map((b) => b.destination),
      fetch,
      connector.settings.quietHours,
    );
    const abort = new AbortController();
    process.once("SIGINT", () => abort.abort());
    process.once("SIGTERM", () => abort.abort());
    await gateway.health({ state: "starting" });
    while (!abort.signal.aborted) {
      try {
        await gateway.poll(abort.signal);
      } catch {
        if (abort.signal.aborted) break;
        await gateway.health({ state: "degraded", fault: "transport" });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    await gateway.health({ state: "stopped" });
    return;
  }
  if (command === "service") {
    output(await serviceCommand(action, root));
    return;
  }
  if (command === "config" && action === "apply" && flags.offline) {
    await inspectState(config.settings.stateDir);
    const unlock = await lockInstance(config.settings.stateDir),
      db = new SqliteStore(
        join(config.settings.stateDir, "mission-control.db"),
        { mustExist: true },
      );
    try {
      output(
        applyConfiguration(
          configuredStore(db, () => config),
          config,
          true,
        ),
      );
    } finally {
      db.close();
      await unlock();
    }
    return;
  }
  if (command === "restore") {
    if (!flags.input || !flags["identity-file"] || !flags.destination)
      throw new Error(
        "Restore requires --input, --identity-file and a new --destination",
      );
    output(
      await restoreBackup(
        resolve(flags.input),
        resolve(flags["identity-file"]),
        resolve(flags.destination),
      ),
    );
    return;
  }
  if (command === "backup" && action === "create" && flags.offline) {
    if (!flags.destination || !flags["recipient-file"])
      throw new Error("Backup requires --destination and --recipient-file");
    await inspectState(config.settings.stateDir);
    const unlock = await lockInstance(config.settings.stateDir);
    const db = new SqliteStore(
      join(config.settings.stateDir, "mission-control.db"),
      { mustExist: true },
    );
    try {
      output(
        await createBackup(
          db,
          config.settings.stateDir,
          resolve(flags.destination),
          resolve(flags["recipient-file"]),
          true,
        ),
      );
    } finally {
      db.close();
      await unlock();
    }
    return;
  }
  if (command === "config" && action === "validate") {
    output({
      valid: true,
      hash: config.hash,
      projects: config.projects.length,
      connectors: config.connectors.map((c) => ({
        id: c.id,
        kind: c.kind,
        enabled: c.enabled,
      })),
    });
    return;
  }
  if (command === "state" && action === "recover-lock") {
    if (!flags.nonce)
      throw new Error("Recover-lock requires the inspected lock nonce");
    output(await recoverInstanceLock(config.settings.stateDir, flags.nonce));
    return;
  }
  if (command === "state" && action === "inspect") {
    output(await inspectState(config.settings.stateDir));
    return;
  }
  if (command === "doctor") {
    output(await diagnose(config));
    return;
  }
  if (command === "serve") {
    await serve(config);
    return;
  }
  const client = new ControlClient(
    `http://127.0.0.1:${config.settings.server.port}`,
    flags["token-file"] && !(command === "access" && action === "create")
      ? await readSecret(
          { kind: "file", path: resolve(flags["token-file"]) },
          config.settings.secretsDir,
        )
      : await token(config),
  );
  if (command === "access") {
    if (action === "list") {
      output(await client.request("/automation-identities"));
      return;
    }
    if (!id) throw new Error("Select automation identity ID");
    if (action === "revoke") {
      output(
        await client.request(
          `/automation-identities/${encodeURIComponent(id)}/revoke`,
          "POST",
          {},
        ),
      );
      return;
    }
    if (action !== "create" || !flags.project || !flags["token-file"])
      throw new Error(
        "Access creation requires ID, --project and a new --token-file outside Git repositories",
      );
    const secretsRoot = await realpath(config.settings.secretsDir);
    const destination = resolve(flags["token-file"]);
    const rel = relative(secretsRoot, destination);
    if (
      !rel ||
      rel.startsWith("..") ||
      isAbsolute(rel) ||
      (await realpath(dirname(destination))) !== dirname(destination) ||
      (await lstat(secretsRoot)).isSymbolicLink()
    )
      throw new Error(
        "Automation credential destination must be a new canonical file inside configured secretsDir",
      );
    const file = await import("node:fs/promises").then((fs) =>
      fs.open(destination, "wx", 0o600),
    );
    try {
      const result = await client.request<{ token: string; policy: unknown }>(
        "/automation-identities",
        "POST",
        {
          id,
          projectIds: flags.project.split(","),
          permissions: (flags.permissions ?? "goals:read,goals:create").split(
            ",",
          ),
          expiresInHours: Number(flags.hours ?? 24),
        },
      );
      await file.writeFile(result.token + "\n");
      await file.sync();
      output({
        policy: result.policy,
        credentialFile: resolve(flags["token-file"]),
      });
    } finally {
      await file.close();
    }
    return;
  }
  if (command === "task" && action === "inspect") {
    output(await client.request(`/tasks/${encodeURIComponent(id)}`));
    return;
  }
  if (command === "events") {
    output(
      await client.request(
        `/events?after=${encodeURIComponent(flags.after ?? "0")}${flags.goal ? `&goalId=${encodeURIComponent(flags.goal)}` : ""}`,
      ),
    );
    return;
  }
  if (command === "state" && action === "usage") {
    output(await client.request("/usage/unresolved"));
    return;
  }
  if (command === "state" && action === "reconcile-usage") {
    if (!id || !flags.input)
      throw Error("Select attempt ID and --input reviewed reconciliation JSON");
    output(
      await client.request(
        `/attempts/${encodeURIComponent(id)}/usage-reconciliation`,
        "POST",
        JSON.parse(await readFile(resolve(flags.input), "utf8")),
      ),
    );
    return;
  }
  if (command === "connector" && action === "provision") {
    output(await client.request("/connector-auth", "POST", { id }));
    return;
  }
  if (command === "connector" && action === "health") {
    output(await client.request("/connectors"));
    return;
  }
  if (command === "backup" && action === "create") {
    if (!flags.destination || !flags["recipient-file"])
      throw new Error("Backup requires --destination and --recipient-file");
    output(
      await client.request(
        "/backups",
        "POST",
        {
          destination: resolve(flags.destination),
          recipientFile: resolve(flags["recipient-file"]),
          complete: !!flags.complete,
        },
        undefined,
        3600000,
      ),
    );
    return;
  }
  if (command === "storage") {
    output(await client.request("/storage"));
    return;
  }
  if (command === "mcp") {
    await runMcp(client);
    return;
  }
  if (command === "config" && action === "apply") {
    output(
      await client.request("/configuration", "POST", { hash: config.hash }),
    );
    return;
  }
  if (command === "schedule" && action === "list") {
    output(await client.request("/schedules"));
    return;
  }
  if (command === "project" && ["list", "readiness"].includes(action)) {
    output(await client.request("/projects"));
    return;
  }
  if (command === "backlog") {
    if (!flags.project) throw new Error("Backlog requires --project ID");
    const projectId = flags.project;
    const entry = `/backlog/${encodeURIComponent(id ?? "")}`;
    if (action === "list")
      output(
        await client.request(
          `/backlog?projectId=${encodeURIComponent(projectId)}${flags.status ? `&status=${encodeURIComponent(flags.status)}` : ""}`,
        ),
      );
    else if (action === "show") {
      if (!id) throw new Error("Backlog show requires entry ID");
      output(
        await client.request(
          `${entry}?projectId=${encodeURIComponent(projectId)}`,
        ),
      );
    } else if (["add", "update", "archive", "launch"].includes(action)) {
      if (action !== "add" && (!id || !flags.revision))
        throw new Error("Backlog mutation requires entry ID and --revision N");
      if (["add", "update"].includes(action) && !flags.input)
        throw new Error("Backlog add/update requires --input JSON_FILE");
      const fields =
        flags.input && ["add", "update"].includes(action)
          ? JSON.parse(
              flags.input === "-"
                ? await stdin()
                : await readFile(resolve(flags.input), "utf8"),
            )
          : {};
      output(
        await client.request(
          action === "add"
            ? "/backlog"
            : action === "update"
              ? entry
              : `${entry}/${action}`,
          "POST",
          {
            ...fields,
            projectId,
            ...(action !== "add" ? { revision: Number(flags.revision) } : {}),
          },
          flags["idempotency-key"],
        ),
      );
    } else
      throw new Error(
        "Unknown backlog action; use list/add/show/update/archive/launch",
      );
    return;
  }
  if (command === "goal") {
    if (["create", "draft"].includes(action)) {
      if (!flags.project || !flags.input)
        throw new Error("Goal creation requires --project and --input");
      const description =
        flags.input === "-"
          ? await stdin()
          : await readFile(resolve(flags.input), "utf8");
      const project = config.projects.find((p) => p.id === flags.project);
      if (!project?.enabled) throw new Error("Project is disabled or unknown");
      const admitted = { projectId: flags.project, description };
      output(
        action === "draft"
          ? await client.request("/goal-drafts", "POST", admitted)
          : await client.createGoal(admitted as any, flags["idempotency-key"]),
      );
      return;
    }
    if (["attempts", "evidence"].includes(action)) {
      output(
        await client.request(
          `/goals/${encodeURIComponent(id)}/${action}?limit=${encodeURIComponent(flags.limit ?? "100")}&after=${encodeURIComponent(flags.after ?? "")}`,
        ),
      );
      return;
    }
    if (action === "list") {
      output(
        await client.request(
          `/goals?limit=${encodeURIComponent(flags.limit ?? "50")}&after=${encodeURIComponent(flags.after ?? "")}`,
        ),
      );
      return;
    }
    if (action === "inspect") {
      output({
        goal: await client.goal(id),
        tasks: await client.tasks(id),
        attempts: await client.request(
          `/goals/${encodeURIComponent(id)}/attempts`,
        ),
      });
      return;
    }
    if (["pause", "resume", "cancel"].includes(action)) {
      const goal = await client.goal(id);
      output(
        await client.request(
          `/goals/${id}/state`,
          "POST",
          {
            revision: goal.revision,
            status: { pause: "paused", resume: "running", cancel: "cancelled" }[
              action
            ],
          },
          flags["idempotency-key"],
        ),
      );
      return;
    }
  }
  if (command === "question") {
    const questions = await client.request<any[]>("/questions");
    if (action === "list") {
      output(questions);
      return;
    }
    const q = questions.find((q) => q.id === id);
    if (action !== "answer" || !q || !flags.option)
      throw new Error("Pending question and --option required");
    output(
      await client.request(`/questions/${id}/answer`, "POST", {
        option: flags.option,
        revision: q.revision,
        ...(flags.explanation ? { explanation: flags.explanation } : {}),
      }),
    );
    return;
  }
  throw new Error(`Unsupported v1 command: ${command} ${action ?? ""}`);
}
async function serve(config: LoadedConfiguration) {
  await inspectState(config.settings.stateDir);
  const unlock = await lockInstance(config.settings.stateDir);
  const db = new SqliteStore(
    join(config.settings.stateDir, "mission-control.db"),
    { mustExist: true },
  );
  let runtime: Awaited<ReturnType<typeof createIsolatedRuntime>> | undefined;
  let scheduler: Scheduler | undefined;
  try {
    const store = configuredStore(db, () => config);
    config = startupConfiguration(store, config);
    store.fenceStartup();
    for (const auth of config.auth) {
      try {
        await new AuthRuntime(
          store,
          config.settings.stateDir,
          config.settings.secretsDir,
          auth,
        ).reconcileStartup();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (
      (
        store.setting("subscription-auth-runs") as
          { status: string }[] | undefined
      )?.some((r) => r.status !== "stopped")
    )
      throw Error(
        "Authentication resources lack a matching reviewed configuration; admission remains closed",
      );
    store.setting("instance-maintenance", false);
    const configRoot = config.root;
    store.redactor.register(await token(config));
    for (const c of config.connectors.filter((c) => c.enabled)) {
      if (c.credential)
        store.redactor.register(
          await readSecret(c.credential, config.settings.secretsDir),
        );
    }
    const host = config.hosts.find((h) => h.isolatedRuntime);
    if (host?.isolatedRuntime)
      runtime = await createIsolatedRuntime(
        store,
        config.settings.stateDir,
        isolatedRuntimeSchema.parse(host.isolatedRuntime),
        new URL("../environments/worker/gateway-relay.py", import.meta.url)
          .pathname,
        config.settings.secretsDir,
        config.runtimeHash,
        config.auth,
      );
    if (!runtime) {
      const resources = db.one(
        "SELECT id FROM sessions WHERE json_extract(record,'$.container') IS NOT NULL UNION ALL SELECT id FROM execution_invocations WHERE json_extract(record,'$.container') IS NOT NULL LIMIT 1",
      );
      if (
        resources ||
        db.one(
          "SELECT session_id FROM gateway_networks WHERE json_extract(record,'$.status') != 'stopped' LIMIT 1",
        )
      )
        throw new Error(
          "Retained runtime resources require their configured isolated runtime for recovery",
        );
      store.finishStartupRecovery();
    }
    const apply = (next: LoadedConfiguration) => {
      for (const connector of next.connectors.filter((c) => c.enabled))
        if (
          !config.connectors.some(
            (c) =>
              c.enabled &&
              c.id === connector.id &&
              JSON.stringify(c.credential) ===
                JSON.stringify(connector.credential),
          )
        )
          throw new Error(
            "New connector credentials require stopped-instance activation",
          );
      const result = applyConfiguration(store, next);
      config = next;
      return result;
    };
    if (!store.setting("configuration")) apply(config);
    const isolatedBackend = (g: import("./control/schema.js").Goal) => {
      if (g.config.backend.kind === "fake") return new FakeBackend();
      if (!runtime) throw new Error("Isolated runtime is unavailable");
      return runtime.backend(g);
    };
    scheduler = new Scheduler(
      store,
      config.settings.stateDir,
      `http://127.0.0.1:${config.settings.server.port}`,
      {
        storagePolicy: config.settings.storage,
        claimThroughApi: true,
        backend: (g) => {
          if (g.config.backend.kind !== "fake")
            throw new Error(
              "Real execution requires configured isolated runtime; no host fallback",
            );
          return new FakeBackend();
        },
        isolatedBackend,
        ...(runtime
          ? {
              isolatedVerifier: (claim, path) =>
                claim.goal.config.backend.kind === "fake"
                  ? syntheticVerifier(claim, path)
                  : runtime!.verify(claim, path),
              executionMaintenance: () => runtime!.maintenance(false),
              imageMaintenance: runtime.imageMaintenance,
            }
          : {}),
      },
    );
    const server = createControlServer(store, {
      stateRoot: config.settings.stateDir,
      token: await token(config),
      externalClaimsDisabled: true,
      claimTask: (workerId, goalId) =>
        scheduler!.claimControllerWorker(workerId, goalId),
      humanService: () =>
        new HumanCommandService(
          store,
          config.connectors.filter((c) => c.enabled).flatMap((c) => c.bindings),
          (projectId, description) => {
            if (!config.projects.some((p) => p.id === projectId && p.enabled))
              throw new Error("Project is disabled");
            return effectiveGoal(config, projectId, description);
          },
        ),
      onBackup: async (destination, recipientFile, complete) => {
        if (!complete)
          return createBackup(
            db,
            config.settings.stateDir,
            destination,
            recipientFile,
            false,
          );
        if (store.setting("instance-maintenance"))
          throw new Error("Maintenance is already active");
        store.setting("instance-maintenance", {
          kind: "backup",
          startedAt: store.now(),
        });
        try {
          return await scheduler!.maintenance(() =>
            createBackup(
              db,
              config.settings.stateDir,
              destination,
              recipientFile,
              true,
            ),
          );
        } finally {
          store.setting("instance-maintenance", false);
        }
      },
      provisionConnector: async (id) => {
        if (!config.connectors.some((c) => c.id === id))
          throw new Error("Unknown configured connector");
        const credential = store.createToken(id, "connector");
        store.redactor.register(credential);
        try {
          await writeFile(
            join(config.settings.secretsDir, `connector-${id}`),
            credential + "\n",
            { flag: "wx", mode: 0o600 },
          );
        } catch (error) {
          store.revokeToken(credential);
          throw error;
        }
        return { provisioned: true, id, credentialFile: `connector-${id}` };
      },
      connectors: () =>
        config.connectors.map(({ id, kind, enabled }) => ({
          id,
          kind,
          enabled,
        })),
      validateGoal: (input) => {
        if (!input || typeof input.description !== "string")
          throw new Error("Goal description is required");
        if (!input.projectId) throw new Error("Select a configured project");
        const p = config.projects.find((p) => p.id === input.projectId);
        if (!p?.enabled) throw new Error("Project is disabled");
        const result = effectiveGoal(
          config,
          input.projectId,
          input.description,
          input,
        );
        if (result.backend.kind !== "fake") {
          if (!runtime) throw new Error("Isolated runtime is unavailable");
          runtime.backend({
            config: result,
          } as import("./control/schema.js").Goal);
        }
        return result;
      },
      applyConfiguration: async (hash) => {
        const next = await loadConfiguration(configRoot);
        if (hash !== next.hash)
          throw new Error(
            "Configuration changed since validation; validate again",
          );
        assertOnlineConfigurationChange(config, next);
        return apply(next);
      },
      allowedOrigins: config.settings.server.allowedOrigins,
      onResult: (...a) => scheduler!.result(...a),
      replayResult: (...a) => scheduler!.replayResult(...a),
    });
    server.listen(config.settings.server.port, "127.0.0.1");
    await once(server, "listening");
    const timer = setInterval(
      () =>
        scheduler!.tick().catch(() =>
          store.event("SCHEDULER_ERROR", "scheduler", {
            code: "tick_failed",
          }),
        ),
      1000,
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      await scheduler!.close();
      await runtime?.close();
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
      await unlock();
    };
    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
    console.log(
      `MissionControl: http://127.0.0.1:${config.settings.server.port}`,
    );
  } catch (error) {
    await scheduler?.close();
    await runtime?.close();
    db.close();
    await unlock();
    throw error;
  }
}
import { FakeBackend } from "./control/backends.js";
import { git } from "./control/git.js";
import { runShell } from "./util.js";
async function syntheticVerifier(
  claim: import("./control/schema.js").Claim,
  path: string,
) {
  const before = await git(path, ["rev-parse", "HEAD"]),
    results = [];
  for (const command of [
    ...new Set([
      ...claim.goal.config.verificationCommands,
      ...claim.task.spec.verificationCommands,
    ]),
  ]) {
    const result = await runShell(command, {
      cwd: path,
      timeoutMs: claim.goal.config.timeoutMs,
      env: { PATH: process.env.PATH },
    });
    results.push({ command, ...result });
  }
  const unchanged =
    before === (await git(path, ["rev-parse", "HEAD"])) &&
    (await git(path, ["status", "--porcelain"])) === "";
  return {
    passed:
      results.length > 0 && unchanged && results.every((r) => r.exitCode === 0),
    results,
    unchanged,
  };
}
async function stdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}
function output(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}
if (isEntrypoint(import.meta.url))
  main().catch(() => {
    console.error(
      "MissionControl command failed. Validate configuration and instance ownership; diagnostic content is not logged.",
    );
    process.exitCode = 1;
  });

function configuredStore(db: SqliteStore, current: () => LoadedConfiguration) {
  return new ControlStore(db, Date.now, (input) => {
    const config = current(),
      reference = input.executionContract?.authentication;
    const auth =
      reference?.kind === "session"
        ? config.auth.find((a) => a.id === reference.reference)
        : undefined;
    if (!auth)
      throw Error("Dedicated subscription authentication is unavailable");
    assertSubscriptionQualification(config.settings.stateDir, input, auth);
  });
}
