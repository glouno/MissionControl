import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

export function slug(input: string): string {
  const normalized = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized.slice(0, 48) || "mission";
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function runCommandSync(command: string, args: string[], options: { cwd?: string } = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function runShell(command: string, options: {
  cwd: string;
  timeoutMs?: number;
  logPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn("/bin/sh", ["-lc", command], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  let killed = false;
  let killTimer: NodeJS.Timeout | undefined;
  const timer = options.timeoutMs
    ? setTimeout(() => {
        killed = true;
        terminateProcessTree(child.pid, "SIGTERM");
        killTimer = setTimeout(() => terminateProcessTree(child.pid, "SIGKILL"), 5_000);
        killTimer.unref?.();
      }, options.timeoutMs)
    : undefined;

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(killed ? 124 : code ?? 1));
  });
  if (timer) clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);

  if (options.logPath) {
    await mkdir(dirname(options.logPath), { recursive: true });
    await writeFile(options.logPath, [
      `$ ${command}`,
      "",
      "## stdout",
      stdout,
      "",
      "## stderr",
      stderr,
      "",
      `exit_code=${exitCode}`,
    ].join("\n"));
  }

  return { exitCode, stdout, stderr };
}

export function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
