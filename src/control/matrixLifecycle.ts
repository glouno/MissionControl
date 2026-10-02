import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { LoadedConfiguration } from "../config.js";
import { terminateProcessTree } from "../util.js";
import { readMatrixConfiguration } from "../matrixRecovery.js";
/** Fixed native companion; never passes session values or control tokens as args. */
export async function matrixLaunch(config: LoadedConfiguration, id: string) {
  const connector = config.connectors.find((c) => c.id === id && c.enabled);
  if (!connector || connector.kind !== "matrix")
    throw Error("Enabled Matrix connector required");
  const { binary, companionConfig } = connector.settings;
  if (!binary || !companionConfig)
    throw Error(
      "Matrix settings require explicit binary and companionConfig paths",
    );
  const path = resolve(binary),
    meta = await lstat(path);
  if (
    !meta.isFile() ||
    meta.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    meta.mode & 0o022 ||
    !(meta.mode & 0o111)
  )
    throw Error(
      "Matrix binary must be a canonical executable without group/world write permission",
    );
  const companion = await readMatrixConfiguration(companionConfig);
  if (
    companion.controller_url !==
    `http://127.0.0.1:${config.settings.server.port}`
  )
    throw Error(
      "Matrix companion controller endpoint differs from configured instance",
    );
  const bindings = connector.bindings.filter((b) => b.enabled);
  if (
    !bindings.length ||
    bindings.some((b) => b.destination !== companion.room_id)
  )
    throw Error("Matrix destination differs from configured operator bindings");
  const users = [...new Set(bindings.map((b) => b.externalIdentity))].sort();
  if (
    JSON.stringify(users) !==
    JSON.stringify([...companion.allowed_users].sort())
  )
    throw Error(
      "Matrix sender allowlist differs from configured operator bindings",
    );
  if (
    companion.controller_token_file !==
    resolve(config.settings.secretsDir, `connector-${id}`)
  )
    throw Error(
      "Matrix companion must use its scoped connector credential file",
    );
  return {
    binary: path,
    args: [resolve(companionConfig)],
    env: { PATH: process.env.PATH },
  };
}
export async function runMatrix(
  config: LoadedConfiguration,
  id: string,
  signal: AbortSignal,
) {
  const launch = await matrixLaunch(config, id);
  const child = spawn(launch.binary, launch.args, {
    env: launch.env,
    stdio: ["ignore", "ignore", "ignore"],
    detached: process.platform !== "win32",
  });
  const stop = () => terminateProcessTree(child.pid, "SIGTERM");
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const timer = setInterval(() => {
    if (signal.aborted) terminateProcessTree(child.pid, "SIGKILL");
  }, 10000);
  timer.unref();
  try {
    await new Promise<void>((yes, no) => {
      child.once("error", () => no(Error("Matrix companion could not start")));
      child.once("close", (code) =>
        signal.aborted || code === 0
          ? yes()
          : no(
              Error(
                "Matrix connector stopped; inspect its private setup and trust state",
              ),
            ),
      );
    });
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", stop);
  }
}
