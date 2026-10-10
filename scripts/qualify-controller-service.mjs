import "./canonical-temp.mjs";
// Real disposable controller lifecycle. Never replaces an installed v1 definition.
import { mkdtemp, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { serviceCommand } from "../dist/service.js";
process.umask(0o077);
if (process.platform !== "linux")
  throw Error("Actual Linux user systemd required; macOS is a separate proof");
const evidence = process.argv[2];
if (!evidence) throw Error("Supply a new private evidence file");
const source = fileURLToPath(new URL("../", import.meta.url)),
  exec = promisify(execFile);
const run = (file, args) =>
  exec(file, args, { cwd: source, timeout: 130000, maxBuffer: 1024 * 1024 });
const commit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
if ((await run("git", ["status", "--porcelain"])).stdout.trim())
  throw Error("Commit reviewed source before proof");
const service = "mission-control-v1.service",
  definition = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "systemd/user",
    service,
  );
await lstat(definition).then(
  () => {
    throw Error("Existing v1 service definition; do not replace it");
  },
  (error) => {
    if (error.code !== "ENOENT") throw error;
  },
);
const initialManager = (
  await run("systemctl", [
    "--user",
    "show",
    service,
    "--property=LoadState,ActiveState,DropInPaths",
  ])
).stdout;
if (
  !initialManager.includes("LoadState=not-found") ||
  !initialManager.includes("ActiveState=inactive") ||
  !initialManager.includes("DropInPaths=\n")
)
  throw Error("Existing v1 service or override; proof refuses activation");
const legacy = async () =>
  (
    await run("systemctl", [
      "--user",
      "show",
      "mission-control-dashboard.service",
      "mission-control-orchestrator.service",
      "--property=ActiveState,MainPID",
    ])
  ).stdout;
const legacyBefore = await legacy(),
  routesBefore = (await run("tailscale", ["serve", "status", "--json"])).stdout;
const root = await mkdtemp(join(tmpdir(), "mc-controller-proof-")),
  config = join(root, "config"),
  state = join(root, "state"),
  secrets = join(root, "secrets"),
  cli = join(source, "dist/cli.js");
const command = (...args) =>
  run(process.execPath, [cli, "--config-dir", config, ...args]);
let installed = false,
  passed = false;
try {
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
  if ([43190, 17443].includes(port))
    throw Error("Reserved legacy port selected");
  const settings = JSON.parse(
    await readFile(join(config, "config.json"), "utf8"),
  );
  settings.server.port = port;
  await writeFile(join(config, "config.json"), JSON.stringify(settings));
  await command("config", "validate");
  await command("doctor");
  const definitionResult = await serviceCommand("install", config);
  installed = true;
  if (
    definitionResult.started !== false ||
    !(await serviceCommand("status", config)).status.includes(
      "ActiveState=inactive",
    )
  )
    throw Error("Install activated service");
  const pid = async () =>
    Number(
      (
        await run("systemctl", [
          "--user",
          "show",
          service,
          "--property=MainPID",
          "--value",
        ])
      ).stdout.trim(),
    );
  async function ready(previous = 0) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const id = await pid();
      if (id && id !== previous) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`);
          if (response.ok) return id;
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("Controller did not become ready");
  }
  await serviceCommand("start", config);
  const first = await ready();
  const unauth = await fetch(`http://127.0.0.1:${port}/api/v1/goals`);
  if (unauth.status !== 401)
    throw Error("Sensitive API read is not authenticated");
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
        "service-proof",
      )
    ).stdout,
  );
  const deadline = Date.now() + 30000;
  let current;
  while (Date.now() < deadline) {
    current = JSON.parse((await command("goal", "inspect", goal.id)).stdout);
    if (current.goal.status === "completed") break;
    if (["failed", "cancelled"].includes(current.goal.status))
      throw Error("Synthetic goal failed");
    await new Promise((r) => setTimeout(r, 150));
  }
  if (
    current?.goal.status !== "completed" ||
    current.tasks.some((task) => task.status !== "accepted")
  )
    throw Error("Synthetic goal lacks verification/review");
  await serviceCommand("restart", config);
  const second = await ready(first);
  const retained = JSON.parse(
    (await command("goal", "inspect", goal.id)).stdout,
  );
  if (retained.goal.status !== "completed")
    throw Error("Restart lost authoritative state");
  await serviceCommand("stop", config);
  if (
    !(await serviceCommand("status", config)).status.includes(
      "ActiveState=inactive",
    )
  )
    throw Error("Stop failed");
  await command("state", "inspect");
  await serviceCommand("uninstall", config);
  installed = false;
  if ((await serviceCommand("status", config)).installed)
    throw Error("Definition persists");
  if (
    (await legacy()) !== legacyBefore ||
    (await run("tailscale", ["serve", "status", "--json"])).stdout !==
      routesBefore
  )
    throw Error("Legacy service or routes changed during proof");
  const receipt = {
    schemaVersion: 1,
    passed: true,
    candidate: commit,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    systemd: (await run("systemctl", ["--version"])).stdout.split("\n")[0],
    implementationSha256: createHash("sha256")
      .update(await readFile(join(source, "dist/service.js")))
      .digest("hex"),
    installationDidNotStart: true,
    authenticatedApi: true,
    syntheticGoalVerified: true,
    restartReplacedProcess: first !== second,
    restartPreservedState: true,
    stopAndUninstall: true,
    legacyServicePidsAndRoutesUnchanged: true,
    macOSQualified: false,
    inferenceSpendUsd: 0,
  };
  await writeFile(resolve(evidence), JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  passed = true;
  process.stdout.write(
    JSON.stringify({ passed: true, legacyServicesAndRoutesUnchanged: true }) +
      "\n",
  );
} finally {
  if (installed) {
    await serviceCommand("stop", config);
    await serviceCommand("uninstall", config);
  }
  if (passed) await rm(root, { recursive: true, force: true });
  else
    process.stderr.write(
      `Failed synthetic proof retained privately at ${root}\n`,
    );
}
