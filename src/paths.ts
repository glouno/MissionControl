import { homedir } from "node:os";
import { resolve, join } from "node:path";

export function userPaths(platform = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env) {
  if (platform === "darwin") {
    const base = join(home, "Library", "Application Support", "MissionControl");
    return { config: join(base, "config"), state: join(base, "state"), data: join(base, "releases"), cache: join(home, "Library", "Caches", "MissionControl"), secrets: join(base, "secrets") };
  }
  return {
    config: join(env.XDG_CONFIG_HOME || join(home, ".config"), "mission-control"),
    state: join(env.XDG_STATE_HOME || join(home, ".local", "state"), "mission-control"),
    data: join(env.XDG_DATA_HOME || join(home, ".local", "share"), "mission-control"),
    cache: join(env.XDG_CACHE_HOME || join(home, ".cache"), "mission-control"),
    secrets: join(env.XDG_CONFIG_HOME || join(home, ".config"), "mission-control-secrets"),
  };
}
export function stateRoot(_cwd?: string): string { return resolve(process.env.MISSIONCONTROL_STATE_DIR || userPaths().state); }
export function configRoot(): string { return resolve(process.env.MISSIONCONTROL_CONFIG_DIR || userPaths().config); }
