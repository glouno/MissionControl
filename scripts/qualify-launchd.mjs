import "./canonical-temp.mjs";
// Actual macOS lifecycle with disposable synthetic state; no login or inference.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { serviceCommand } from "../dist/service.js";
import { connectorServiceCommand } from "../dist/connectorServices.js";
import { restoreBackup } from "../dist/backup.js";
import { DatabaseSync } from "node:sqlite";

process.umask(0o077);
if (process.platform !== "darwin") throw Error("Run on an actual macOS host");
const source = fileURLToPath(new URL("../", import.meta.url));
const evidence = resolve(process.argv[2] || "");
if (!process.argv[2] || !relative(source, evidence).startsWith(".."))
  throw Error("Supply a new private evidence file outside source");
const parent = await lstat(dirname(evidence));
if (
  !parent.isDirectory() ||
  parent.mode & 0o077 ||
  (await realpath(dirname(evidence))) !== dirname(evidence)
)
  throw Error("Evidence parent must be a canonical private directory");
await lstat(evidence).then(
  () => {
    throw Error("Evidence already exists");
  },
  (e) => {
    if (e.code !== "ENOENT") throw e;
  },
);
const exec = promisify(execFile);
const run = (file, args) =>
  exec(file, args, {
    cwd: source,
    timeout: 45000,
    maxBuffer: 1024 * 1024,
  });
const candidate = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
if ((await run("git", ["status", "--porcelain"])).stdout.trim())
  throw Error("Commit reviewed source before qualification");
if ((await serviceCommand("status", "/unused")).installed)
  throw Error("An installed v1 controller already exists; do not replace it");
const root = await mkdtemp(join(tmpdir(), "mc-launchd-"));
const config = join(root, "config"),
  state = join(root, "state"),
  secrets = join(root, "secrets"),
  cli = join(source, "dist/cli.js");
const command = (...args) =>
  run(process.execPath, [cli, "--config-dir", config, ...args]);
const connectorId = "synthetic-lifecycle";
const connectorCli = join(root, "synthetic-connector.mjs");
const connectorConfig = {
  root: config,
  connectors: [
    {
      id: connectorId,
      kind: "telegram",
      enabled: true,
      credential: { kind: "file", path: "synthetic-unused" },
      bindings: [{ enabled: true }],
    },
  ],
};
const connectorOptions = { cli: connectorCli };
const connector = (action) =>
  connectorServiceCommand(
    connectorConfig,
    connectorId,
    action,
    connectorOptions,
  );
let installed = false,
  connectorInstalled = false,
  passed = false;
const label = `gui/${process.getuid()}/org.missioncontrol.v1`;
const connectorLabel = label + ".connector." + connectorId;
async function pid(name) {
  const { stdout } = await run("launchctl", ["print", name]);
  return Number(stdout.match(/\bpid = (\d+)/)?.[1]);
}
async function wait(check) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Synthetic launchd acceptance timed out");
}
try {
  assert.equal((await connector("status")).installed, false);
  const init = JSON.parse(
    (
      await command(
        "init",
        "--state-dir",
        state,
        "--secrets-dir",
        secrets,
        "--example",
      )
    ).stdout,
  );
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const settings = JSON.parse(
    await readFile(join(config, "config.json"), "utf8"),
  );
  settings.server.port = port;
  await writeFile(join(config, "config.json"), JSON.stringify(settings));
  assert.equal((await serviceCommand("install", config)).started, false);
  installed = true;
  assert.equal((await serviceCommand("status", config)).status, "not_loaded");
  await serviceCommand("start", config);
  await wait(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
    } catch {
      return false;
    }
  });
  const first = await pid(label);
  assert.ok(first);
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/api/v1/goals`)).status,
    401,
  );
  const goal = JSON.parse(
    (
      await command(
        "goal",
        "create",
        "--project",
        "synthetic",
        "--input",
        init.example.goalFile,
        "--idempotency-key",
        "launchd-proof",
      )
    ).stdout,
  );
  await wait(async () => {
    const result = JSON.parse(
      (await command("goal", "inspect", goal.id)).stdout,
    );
    return (
      result.goal.status === "completed" &&
      result.tasks.every((t) => t.status === "accepted")
    );
  });
  await serviceCommand("restart", config);
  await wait(async () => {
    try {
      return (
        (await pid(label)) !== first &&
        JSON.parse((await command("goal", "inspect", goal.id)).stdout).goal
          .status === "completed"
      );
    } catch {
      return false;
    }
  });
  // Invoke backup through the running service to exercise its pinned tool PATH.
  const identity = join(root, "identity"),
    recipient = join(root, "recipient"),
    backup = join(root, "complete.age"),
    restored = join(root, "restored");
  await run("age-keygen", ["-o", identity]);
  await writeFile(
    recipient,
    (await run("age-keygen", ["-y", identity])).stdout,
  );
  await command(
    "backup",
    "create",
    "--destination",
    backup,
    "--recipient-file",
    recipient,
    "--complete",
  );
  await serviceCommand("stop", config);
  assert.equal((await serviceCommand("status", config)).status, "not_loaded");
  await restoreBackup(backup, identity, restored);
  const restoredDb = new DatabaseSync(join(restored, "mission-control.db"), {
    readOnly: true,
  });
  try {
    assert.equal(
      restoredDb
        .prepare("SELECT status FROM control_goals WHERE id=?")
        .get(goal.id).status,
      "completed",
    );
  } finally {
    restoredDb.close();
  }
  await serviceCommand("uninstall", config);
  installed = false;
  // The synthetic connector exercises only process lifecycle, never Telegram.
  await writeFile(connectorCli, "setInterval(() => {}, 1000);\n");
  assert.equal((await connector("install")).started, false);
  connectorInstalled = true;
  assert.equal((await connector("status")).status, "not_loaded");
  await connector("start");
  await wait(async () => {
    try {
      return !!(await pid(connectorLabel));
    } catch {
      return false;
    }
  });
  const firstConnector = await pid(connectorLabel);
  await connector("restart");
  await wait(async () => {
    try {
      const next = await pid(connectorLabel);
      return next && next !== firstConnector;
    } catch {
      return false;
    }
  });
  await connector("stop");
  assert.equal((await connector("status")).status, "not_loaded");
  await connector("uninstall");
  connectorInstalled = false;
  const receipt = {
    schemaVersion: 1,
    candidate,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    passed: true,
    serviceSha256: createHash("sha256")
      .update(await readFile(join(source, "dist/service.js")))
      .digest("hex"),
    connectorSha256: createHash("sha256")
      .update(await readFile(join(source, "dist/connectorServices.js")))
      .digest("hex"),
    installInactive: true,
    authenticatedApi: true,
    syntheticGoalCompleted: true,
    restartPreservedState: true,
    encryptedBackupRestored: true,
    controllerUnloadedAndUninstalled: true,
    syntheticConnectorLifecycle: true,
    connectorUnloadedAndUninstalled: true,
    realConnectorTransport: false,
    realSubscriptionQualified: false,
    inferenceSpendUsd: 0,
  };
  await writeFile(evidence, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  passed = true;
  console.log(JSON.stringify({ passed: true, platform: process.platform }));
} finally {
  if (connectorInstalled) {
    await connector("stop");
    await connector("uninstall");
  }
  if (installed) {
    await serviceCommand("stop", config);
    await serviceCommand("uninstall", config);
  }
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error(`Failed synthetic proof retained privately at ${root}`);
}
