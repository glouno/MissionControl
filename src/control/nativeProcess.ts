import { launchFrame } from "./nativeLauncher.js";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { abortable, boundedCleanup } from "./reliability.js";
import type { ProcessIdentity } from "./invocations.js";

export async function processIdentity(
  pid: number,
): Promise<ProcessIdentity | undefined> {
  try {
    const [raw, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const fields = raw
      .slice(raw.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === "Z") return;
    const environment = await readFile(`/proc/${pid}/environ`, "utf8").catch(
      () => "",
    );
    const executionId = environment
      .split("\0")
      .find((entry) => entry.startsWith("MC_NATIVE_EXECUTION_ID="))
      ?.slice("MC_NATIVE_EXECUTION_ID=".length);
    return {
      pid,
      pgid: Number(fields[2]),
      startTime: fields[19],
      bootId: bootId.trim(),
      ...(executionId ? { executionId } : {}),
    };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ESRCH"
    )
      return;
    throw error;
  }
}
export async function ownedGroup(identity: ProcessIdentity) {
  const boot = (
    await readFile("/proc/sys/kernel/random/boot_id", "utf8")
  ).trim();
  if (boot !== identity.bootId) return [];
  const leader = await processIdentity(identity.pid);
  if (
    leader &&
    (leader.startTime !== identity.startTime || leader.pgid !== identity.pgid)
  )
    throw Error(
      "Native process identity changed; refusing to signal a reused PID",
    );
  const members: ProcessIdentity[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const member = await processIdentity(Number(name));
    if (
      !member ||
      (member.pgid !== identity.pgid &&
        (!identity.executionId || member.executionId !== identity.executionId))
    )
      continue;
    if (
      (await stat(`/proc/${name}`).catch(() => undefined))?.uid !==
      process.getuid?.()
    )
      throw Error("Native group ownership is ambiguous");
    if (BigInt(member.startTime) < BigInt(identity.startTime))
      throw Error("Native group identity is ambiguous");
    members.push(member);
  }
  return members;
}
export async function stopOwnedGroup(
  identity: ProcessIdentity,
  signal?: AbortSignal,
) {
  const members = await ownedGroup(identity);
  if (!members.length) return;
  // The launcher always creates its own session/group. Never signal the controller group.
  if (identity.pid !== identity.pgid)
    throw Error("Native execution has no dedicated process group");
  let remaining = members;
  while (remaining.length) {
    signal?.throwIfAborted();
    for (const member of remaining) {
      const current = await processIdentity(member.pid);
      if (!current) continue;
      if (
        current.startTime !== member.startTime ||
        current.bootId !== member.bootId
      )
        throw Error("Native child identity changed during cleanup");
      try {
        process.kill(member.pid, "SIGKILL");
      } catch (error) {
        if ((error as any).code !== "ESRCH") throw error;
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
    remaining = await ownedGroup(identity);
  }
}
export async function cleanupNativeProcess(
  identity: ProcessIdentity,
  closed: Promise<void>,
  cleanupSignal?: () => AbortSignal,
) {
  let done = false;
  closed.then(() => {
    done = true;
  });
  const members = await ownedGroup(identity);
  // Proving absent resources does not spend or replenish an attempt's cleanup allowance.
  if (!members.length && done) return;
  await boundedCleanup(
    async (signal) => {
      await stopOwnedGroup(identity, signal);
      await abortable(closed, signal);
    },
    60000,
    cleanupSignal?.(),
  );
}
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export async function nativeCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    cleanupSignal?: () => AbortSignal;
    onProcess?: (identity: ProcessIdentity) => void;
  },
): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  const child = spawn(
    process.execPath,
    [
      new URL("./nativeLauncher.js", import.meta.url).pathname,
      command,
      ...args,
    ],
    {
      cwd: options.cwd,
      env: { ...options.env, MC_NATIVE_EXECUTION_ID: randomUUID() },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.on("error", () => {});
  let stdout = "",
    stderr = "",
    identity: ProcessIdentity | undefined,
    exitCode = -1;
  child.stdout.on("data", (b) => (stdout = (stdout + b).slice(-20000)));
  child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-20000)));
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? -1));
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  exited.catch(() => {});
  try {
    if (!child.pid) throw Error("Native command has no process identity");
    identity = await processIdentity(child.pid);
    if (!identity) throw Error("Native launcher vanished before admission");
    options.onProcess?.(identity);
    options.signal?.throwIfAborted();
    child.stdin.end(launchFrame);
    exitCode = await (options.signal
      ? abortable(exited, options.signal)
      : exited);
  } finally {
    if (identity)
      await cleanupNativeProcess(identity, closed, options.cleanupSignal);
    else {
      child.kill("SIGKILL");
      await closed;
    }
  }
  return { exitCode, stdout, stderr };
}
