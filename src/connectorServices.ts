import {
  mkdir,
  writeFile,
  lstat,
  realpath,
  readFile,
  unlink,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { LoadedConfiguration } from "./config.js";
import { serviceToolPath } from "./service.js";
import { matrixLaunch } from "./control/matrixLifecycle.js";
const exec = promisify(execFile);
function unit(value: string) {
  if (/[\r\n\0]/.test(value))
    throw Error("Connector service paths contain control characters");
  return (
    '"' +
    value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%")
      .replaceAll("$", () => "$$") +
    '"'
  );
}
function xml(value: string) {
  if (/[\r\n\0]/.test(value))
    throw Error("Connector service paths contain control characters");
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
export function connectorServiceDefinition(
  configDir: string,
  id: string,
  platform: string,
  node: string,
  cli: string,
  toolPath?: string,
) {
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(id))
    throw Error("Connector service requires a safe configured ID");
  const args = [
    node,
    cli,
    "--config-dir",
    resolve(configDir),
    "connector",
    "run",
    id,
  ];
  if (platform === "linux")
    return {
      name: `mission-control-v1-connector-${id}.service`,
      content: `[Unit]\nDescription=MissionControl v1 connector ${id}\nAfter=mission-control-v1.service\n\n[Service]\nType=simple\nExecStart=${args.map(unit).join(" ")}\nUMask=0077\nRestart=on-failure\nRestartSec=30\nTimeoutStopSec=30\nStandardOutput=null\nStandardError=null\n\n[Install]\nWantedBy=default.target\n`,
    };
  if (platform === "darwin")
    return {
      name: `org.missioncontrol.v1.connector.${id}.plist`,
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>org.missioncontrol.v1.connector.${id}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(serviceToolPath(toolPath))}</string></dict><key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n`,
    };
  throw Error("Connector services support Linux/WSL and macOS");
}
export async function prepareConnectorService(
  config: LoadedConfiguration,
  id: string,
  destination: string,
  platform: string,
  node: string,
  cli: string,
) {
  const connector = config.connectors.find((c) => c.id === id && c.enabled);
  if (!connector) throw Error("Select an enabled configured connector");
  if (connector.kind === "matrix") await matrixLaunch(config, id);
  else if (!connector.credential || !connector.bindings.some((b) => b.enabled))
    throw Error(
      "Telegram requires a credential reference and enabled operator binding",
    );
  const definition = connectorServiceDefinition(
      config.root,
      id,
      platform,
      node,
      cli,
    ),
    root = resolve(destination);
  await mkdir(root, { mode: 0o700 });
  const info = await lstat(root);
  if (
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (await realpath(root)) !== root
  )
    throw Error(
      "Service destination must be a new private canonical directory",
    );
  await writeFile(join(root, definition.name), definition.content, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    prepared: true,
    enabled: false,
    started: false,
    file: definition.name,
    qualification:
      "Prepared only; installed lifecycle and live transport acceptance remain separate",
  };
}

/** Acts only on a v1 definition matching this exact configuration and executable. */
export async function connectorServiceCommand(
  config: LoadedConfiguration,
  id: string,
  action: "install" | "status" | "start" | "stop" | "restart" | "uninstall",
  options: {
    platform?: string;
    home?: string;
    xdgConfig?: string;
    node?: string;
    cli?: string;
    toolPath?: string;
    execute?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  } = {},
) {
  const platform = options.platform ?? process.platform,
    node = options.node ?? process.execPath,
    cli = options.cli ?? fileURLToPath(new URL("./cli.js", import.meta.url)),
    home = options.home ?? homedir(),
    execute =
      options.execute ??
      ((file, args) => exec(file, args, { timeout: 35000, maxBuffer: 64000 }));
  if (!config.connectors.some((c) => c.id === id))
    throw Error("Select a configured connector ID");
  const definition = connectorServiceDefinition(
    config.root,
    id,
    platform,
    node,
    cli,
    options.toolPath,
  );
  const parent =
    platform === "darwin"
      ? join(home, "Library/LaunchAgents")
      : join(
          options.xdgConfig ??
            process.env.XDG_CONFIG_HOME ??
            join(home, ".config"),
          "systemd/user",
        );
  const path = join(parent, definition.name),
    label = `gui/${process.getuid?.()}/org.missioncontrol.v1.connector.${id}`;
  async function macManager() {
    try {
      const { stdout } = await execute("launchctl", ["print", label]);
      const args = stdout
        .match(/(?:^|\n)\s*arguments = \{\n([\s\S]*?)\n\s*\}/)?.[1]
        ?.split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (
        !stdout.split("\n").some((line) => line.trim() === `path = ${path}`) ||
        JSON.stringify(args) !==
          JSON.stringify([
            node,
            cli,
            "--config-dir",
            resolve(config.root),
            "connector",
            "run",
            id,
          ])
      )
        throw Error(
          "Loaded connector definition or arguments differ; inspect launchd ownership",
        );
      return { loaded: true, stdout };
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      if (
        failure.code === 113 &&
        /Could not find service/.test(failure.stderr ?? "")
      )
        return { loaded: false, stdout: "not_loaded" };
      throw error;
    }
  }
  if (action === "install") {
    if (platform === "darwin" && (await macManager()).loaded)
      throw Error(
        "A v1 connector is already loaded; inspect before installation",
      );
    if (!config.connectors.some((c) => c.id === id && c.enabled))
      throw Error("Install only an enabled reviewed connector");
    const connector = config.connectors.find((c) => c.id === id)!;
    if (connector.kind === "matrix") await matrixLaunch(config, id);
    else if (
      !connector.credential ||
      !connector.bindings.some((b) => b.enabled)
    )
      throw Error(
        "Telegram requires credential reference and enabled operator binding",
      );
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await lstat(parent);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid?.() ||
      directory.mode & 0o022 ||
      (await realpath(parent)) !== resolve(parent)
    )
      throw Error(
        "Connector service directory is redirected or writable by others",
      );
    await writeFile(path, definition.content, { flag: "wx", mode: 0o600 });
    if (platform === "linux")
      await execute("systemctl", ["--user", "daemon-reload"]);
    return { installed: true, started: false, path };
  }
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      action === "status"
    ) {
      if (platform === "darwin" && (await macManager()).loaded)
        throw Error("A connector remains loaded without its owned definition");
      return { installed: false };
    }
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (await realpath(path)) !== resolve(path) ||
    (await readFile(path, "utf8")) !== definition.content
  )
    throw Error(
      "Installed connector definition differs from this configuration/release; review ownership before service changes",
    );
  const current = platform === "darwin" ? await macManager() : undefined;
  if (action === "status") {
    const result =
      platform === "darwin"
        ? current!
        : await execute("systemctl", [
            "--user",
            "show",
            definition.name,
            "--property=ActiveState,SubState,UnitFileState",
          ]);
    return { installed: true, path, status: result.stdout };
  }
  if (action === "uninstall") {
    const status = await connectorServiceCommand(config, id, "status", options);
    if (
      platform === "darwin"
        ? status.status !== "not_loaded"
        : !status.status?.includes("ActiveState=inactive")
    )
      throw Error(
        "Stop and unload this v1 connector before uninstalling its definition",
      );
    await unlink(path);
    if (platform === "linux")
      await execute("systemctl", ["--user", "daemon-reload"]);
    return { uninstalled: true, path };
  }
  if (
    ["start", "restart"].includes(action) &&
    !config.connectors.some((c) => c.id === id && c.enabled)
  )
    throw Error("Disabled connectors cannot restart");
  if (platform === "darwin") {
    if (action === "stop") {
      if (current!.loaded) {
        await execute("launchctl", ["bootout", label]);
        // bootout returns before termination/unload has necessarily completed.
        const deadline = Date.now() + 30000;
        while ((await macManager()).loaded) {
          if (Date.now() >= deadline)
            throw Error("launchd job did not unload; retain its definition");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    } else if (action === "start") {
      if (current!.loaded)
        throw Error("Connector is loaded; use restart explicitly");
      await execute("launchctl", [
        "bootstrap",
        `gui/${process.getuid?.()}`,
        path,
      ]);
      await execute("launchctl", ["kickstart", label]);
    } else {
      if (!current!.loaded)
        throw Error("Connector is not loaded; use start explicitly");
      await execute("launchctl", ["kickstart", "-k", label]);
    }
  } else await execute("systemctl", ["--user", action, definition.name]);
  return { requested: action, path };
}
