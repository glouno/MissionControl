import { z } from "zod";
import { resolve, relative, isAbsolute, join } from "node:path";
import { lstat, realpath, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ControlClient } from "./control/client.js";
export const backupPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    destinationDir: z.string().min(1).optional(),
    recipientFile: z.string().min(1).optional(),
    hourUtc: z.number().int().min(0).max(23).default(3),
  })
  .strict()
  .refine(
    (p) => !p.enabled || !!(p.destinationDir && p.recipientFile),
    "Enabled daily backup requires destinationDir and recipientFile",
  );
export type BackupPolicy = z.output<typeof backupPolicySchema>;
function overlap(a: string, b: string) {
  const r = relative(a, b);
  return r === "" || (r !== ".." && !r.startsWith("../") && !isAbsolute(r));
}
export function resolveBackupPolicy(
  input: BackupPolicy,
  configRoot: string,
  stateRoot: string,
  secretsRoot: string,
) {
  const policy = backupPolicySchema.parse(input),
    destinationDir =
      policy.destinationDir && resolve(configRoot, policy.destinationDir),
    recipientFile =
      policy.recipientFile && resolve(configRoot, policy.recipientFile);
  if (
    destinationDir &&
    [configRoot, stateRoot, secretsRoot].some(
      (r) =>
        overlap(resolve(r), destinationDir) ||
        overlap(destinationDir, resolve(r)),
    )
  )
    throw Error(
      "Backup destination must be separate from configuration, state and secrets",
    );
  return { ...policy, destinationDir, recipientFile };
}
async function directory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    info.uid !== process.getuid?.() ||
    (await realpath(path)) !== path
  )
    throw Error(
      "Backup destination must be an owned, private canonical directory",
    );
}
export async function validateBackupDestination(policy: BackupPolicy) {
  if (!policy.destinationDir || !policy.recipientFile)
    throw Error("Configure backup destinationDir and recipientFile first");
  await directory(policy.destinationDir);
  const info = await lstat(policy.recipientFile);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (await realpath(policy.recipientFile)) !== policy.recipientFile
  )
    throw Error("Backup recipient must be a canonical regular file");
  const { readFile } = await import("node:fs/promises");
  if (
    !/^age1[0-9a-z]{58}$/.test(
      (await readFile(policy.recipientFile, "utf8")).trim(),
    )
  )
    throw Error("Backup recipient file must contain one age public recipient");
}
export async function runScheduledBackup(
  client: ControlClient,
  policy: BackupPolicy,
) {
  if (!policy.enabled)
    throw Error(
      "Daily backup is disabled; configure recipient/destination and explicitly enable it",
    );
  await validateBackupDestination(policy);
  const id = new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID(),
    destination = join(policy.destinationDir!, `application-${id}.age`);
  const manifest: any = await client.request("/backups", "POST", {
    destination,
    recipientFile: policy.recipientFile,
    complete: true,
  });
  if (manifest.complete !== true)
    throw Error(
      "Scheduled backup did not return a complete application snapshot",
    );
  const { readFile } = await import("node:fs/promises");
  const bundleSha256 = (await readFile(destination + ".sha256", "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(bundleSha256))
    throw Error("Scheduled backup checksum receipt is invalid");
  // A successful encrypted write is not a restore drill. Retention never prunes
  // on this receipt alone, and separate-store recovery stays explicit.
  await writeFile(
    join(policy.destinationDir!, `application-${id}.receipt.json`),
    JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        bundle: `application-${id}.age`,
        bundleSha256,
        instanceId: manifest.instanceId,
        schema: manifest.schemaVersion,
        complete: true,
        restoreVerified: false,
        pinned: true,
        separateStores: manifest.separateStores,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return {
    created: true,
    complete: true,
    restoreVerified: false,
    separateStoresRequired: true,
  };
}
function unitArg(value: string) {
  if (/[\r\n\0]/.test(value))
    throw Error("Backup service path has control characters");
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
function xml(v: string) {
  if (/[\r\n\0]/.test(v))
    throw Error("Backup service path has control characters");
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
export function backupServiceDefinitions(
  configDir: string,
  policy: BackupPolicy,
  platform: string,
  node: string,
  cli: string,
) {
  const args = [node, cli, "--config-dir", resolve(configDir), "backup", "run"];
  if (platform === "linux")
    return {
      "mission-control-v1-backup.service": `[Unit]\nDescription=MissionControl v1 encrypted application backup\n\n[Service]\nType=oneshot\nUMask=0077\nExecStart=${args.map(unitArg).join(" ")}\nTimeoutStartSec=1800\nStandardOutput=null\nStandardError=null\n`,
      "mission-control-v1-backup.timer": `[Unit]\nDescription=MissionControl v1 daily backup timer\n\n[Timer]\nOnCalendar=*-*-* ${String(policy.hourUtc).padStart(2, "0")}:00:00 UTC\nPersistent=true\nRandomizedDelaySec=300\nUnit=mission-control-v1-backup.service\n\n[Install]\nWantedBy=timers.target\n`,
    };
  // launchd calendar is local time. Use UTC-configured helper invocation every
  // hour only when its hour matches UTC; this keeps the public policy consistent.
  if (platform === "darwin")
    return {
      "org.missioncontrol.v1.backup.plist": `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>org.missioncontrol.v1.backup</string><key>ProgramArguments</key><array>${[...args, "--scheduled"].map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>StartCalendarInterval</key><dict><key>Minute</key><integer>0</integer></dict><key>RunAtLoad</key><false/><key>Umask</key><integer>63</integer></dict></plist>\n`,
    };
  throw Error("Backup services support Linux/WSL or macOS");
}
export async function prepareBackupServices(
  configDir: string,
  policy: BackupPolicy,
  destination: string,
  platform: string,
  node: string,
  cli: string,
) {
  const root = resolve(destination);
  await mkdir(root, { mode: 0o700, recursive: false });
  await directory(root);
  const definitions = backupServiceDefinitions(
    configDir,
    policy,
    platform,
    node,
    cli,
  );
  for (const [name, text] of Object.entries(definitions))
    await writeFile(join(root, name), text, { flag: "wx", mode: 0o600 });
  return {
    prepared: true,
    enabled: false,
    files: Object.keys(definitions),
    qualification:
      "Generated only; actual macOS and off-host restore acceptance remain required",
  };
}
