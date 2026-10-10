import {
  mkdir,
  writeFile,
  readFile,
  unlink,
  lstat,
  realpath,
} from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const name = "mission-control-v1.service",
  macName = "org.missioncontrol.v1";
function validPath(value: string) {
  if (/[\r\n\0]/.test(value))
    throw Error("Service paths cannot contain control characters");
  return value;
}
function xml(value: string) {
  return validPath(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function unitArg(value: string) {
  // systemd expands specifiers and environment variables even in quoted arguments.
  return (
    '"' +
    validPath(value)
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%")
      .replaceAll("$", () => "$$") +
    '"'
  );
}
export function serviceToolPath(
  value = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
) {
  validPath(value);
  if (value.split(":").some((entry) => !isAbsolute(entry)))
    throw Error(
      "Service tool PATH must contain only explicit absolute directories",
    );
  return value;
}
export function serviceDefinition(
  configDir: string,
  platform: string = process.platform,
  node = process.execPath,
  cli = fileURLToPath(new URL("./cli.js", import.meta.url)),
  toolPath?: string,
) {
  const args = [node, cli, "--config-dir", resolve(configDir), "serve"];
  if (platform === "darwin")
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${macName}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(serviceToolPath(toolPath))}</string></dict><key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n`;
  if (platform !== "linux")
    throw Error("User services require Linux/WSL or macOS");
  return `[Unit]\nDescription=MissionControl v1 private controller\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${args.map(unitArg).join(" ")}\nUMask=0077\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=120\nStandardOutput=null\nStandardError=null\n\n[Install]\nWantedBy=default.target\n`;
}
export type ServiceOptions = {
  platform?: string;
  home?: string;
  xdgConfig?: string;
  node?: string;
  cli?: string;
  toolPath?: string;
  execute?: (file: string, args: string[]) => Promise<{ stdout: string }>;
};
/** No activation on install. All lifecycle operations require exact local and loaded ownership. */
export async function serviceCommand(
  action: string,
  configDir: string,
  options: ServiceOptions = {},
) {
  if (
    !["install", "status", "start", "stop", "restart", "uninstall"].includes(
      action,
    )
  )
    throw Error(
      "Use service install, status, start, stop, restart or uninstall",
    );
  const platform = options.platform ?? process.platform,
    home = options.home ?? homedir(),
    node = options.node ?? process.execPath,
    cli = options.cli ?? fileURLToPath(new URL("./cli.js", import.meta.url)),
    content = serviceDefinition(
      configDir,
      platform,
      node,
      cli,
      options.toolPath,
    ),
    parent = resolve(
      platform === "darwin"
        ? join(home, "Library/LaunchAgents")
        : join(
            options.xdgConfig ??
              process.env.XDG_CONFIG_HOME ??
              join(home, ".config"),
            "systemd/user",
          ),
    ),
    path = join(parent, platform === "darwin" ? `${macName}.plist` : name),
    label = `gui/${process.getuid?.()}/${macName}`,
    execute =
      options.execute ??
      ((file, args) => exec(file, args, { timeout: 130000, maxBuffer: 64000 }));
  async function directory() {
    const info = await lstat(parent);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o022 ||
      (await realpath(parent)) !== parent
    )
      throw Error(
        "Service directory is redirected, foreign-owned or writable by others",
      );
  }
  async function definition() {
    await directory();
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      (await realpath(path)) !== path ||
      (await readFile(path, "utf8")) !== content
    )
      throw Error(
        "Installed controller definition differs from this configuration/release; review ownership before service changes",
      );
  }
  async function manager() {
    if (platform === "linux") {
      const { stdout } = await execute("systemctl", [
        "--user",
        "show",
        name,
        "--property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,DropInPaths,NeedDaemonReload",
      ]);
      const fields = Object.fromEntries(
        stdout
          .trim()
          .split("\n")
          .map((line) => {
            const index = line.indexOf("=");
            return [line.slice(0, index), line.slice(index + 1)];
          }),
      );
      if (!fields.LoadState || !fields.ActiveState)
        throw Error("Service manager returned incomplete controller status");
      if (fields.NeedDaemonReload !== "no")
        throw Error(
          "Loaded controller definition is stale; review and reload before service changes",
        );
      if (fields.DropInPaths !== "")
        throw Error(
          "Loaded controller has overrides; inspect service ownership",
        );
      if (
        fields.LoadState !== "not-found" &&
        (fields.LoadState !== "loaded" ||
          fields.FragmentPath !== path ||
          fields.DropInPaths !== "")
      )
        throw Error(
          "Loaded controller has a different definition or overrides; inspect service ownership",
        );
      return {
        loaded: fields.LoadState === "loaded",
        inactive: fields.ActiveState === "inactive",
        status: stdout,
      };
    }
    try {
      const { stdout } = await execute("launchctl", ["print", label]);
      // launchctl records the loaded plist path. Refuse a different job under the reserved v1 label.
      if (!stdout.split("\n").some((line) => line.trim() === `path = ${path}`))
        throw Error(
          "Loaded controller has a different launchd definition; inspect service ownership",
        );
      const argumentsBlock = stdout.match(
        /(?:^|\n)\s*arguments = \{\n([\s\S]*?)\n\s*\}/,
      )?.[1];
      const args = argumentsBlock
        ?.split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (
        JSON.stringify(args) !==
        JSON.stringify([node, cli, "--config-dir", resolve(configDir), "serve"])
      )
        throw Error(
          "Loaded controller arguments differ from this configuration/release; inspect launchd ownership",
        );
      return { loaded: true, inactive: false, status: stdout };
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      if (
        failure.code === 113 &&
        /Could not find service/.test(failure.stderr ?? "")
      )
        return { loaded: false, inactive: true, status: "not_loaded" };
      throw error;
    }
  }
  if (action === "install") {
    // Reject a loaded job even when its original definition has disappeared.
    const before = await manager();
    if (before.loaded && !before.inactive)
      throw Error(
        "A v1 controller is already loaded; inspect before installation",
      );
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await directory();
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
    if (platform === "linux")
      await execute("systemctl", ["--user", "daemon-reload"]);
    return {
      installed: true,
      started: false,
      path,
      nextAction:
        "Use service start explicitly after doctor and configuration review",
    };
  }
  try {
    await definition();
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      action === "status"
    ) {
      const current = await manager();
      if (current.loaded)
        throw Error(
          "A controller remains loaded without its owned definition; inspect service ownership",
        );
      return { installed: false };
    }
    throw error;
  }
  const current = await manager();
  if (action === "status")
    return { installed: true, path, status: current.status };
  if (action === "uninstall") {
    if (!current.inactive || (platform === "darwin" && current.loaded))
      throw Error(
        "Stop and unload the v1 controller explicitly before uninstalling its definition",
      );
    await definition();
    await unlink(path);
    if (platform === "linux")
      await execute("systemctl", ["--user", "daemon-reload"]);
    return { uninstalled: true, path };
  }
  if (platform === "linux") {
    if (!current.loaded)
      throw Error(
        "Controller definition is not loaded; inspect or reload the reviewed installation",
      );
    await execute("systemctl", ["--user", action, name]);
  } else if (action === "stop") {
    if (current.loaded) {
      await execute("launchctl", ["bootout", label]);
      // bootout returns before termination/unload has necessarily completed.
      const deadline = Date.now() + 30000;
      while ((await manager()).loaded) {
        if (Date.now() >= deadline)
          throw Error("launchd job did not unload; retain its definition");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  } else if (action === "start") {
    if (current.loaded)
      throw Error("Controller is loaded; use restart explicitly");
    await execute("launchctl", [
      "bootstrap",
      `gui/${process.getuid?.()}`,
      path,
    ]);
    // Bootstrap loads an inactive RunAtLoad=false definition; explicit start runs it.
    await execute("launchctl", ["kickstart", label]);
  } else {
    if (!current.loaded)
      throw Error("Controller is not loaded; use start explicitly");
    await execute("launchctl", ["kickstart", "-k", label]);
  }
  return { requested: action, path };
}
