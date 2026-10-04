import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  lstat,
  readdir,
  readFile,
  writeFile,
  rm,
  mkdtemp,
  realpath,
  open,
  rename,
} from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { z } from "zod";
import { SqliteStore, sql } from "./sqlite.js";
import { inspectState } from "./instance.js";
import { ControlStore } from "./control/store.js";
import { WorkspaceManager } from "./control/workspaces.js";
import { repairWorktreeLinks } from "./control/worktreeLinks.js";

const manifestSchema = z
  .object({
    format: z.literal("missioncontrol-backup-v1"),
    applicationVersion: z.string(),
    schemaVersion: z.number().int().min(1).max(7),
    instanceId: z.string(),
    createdAt: z.string(),
    complete: z.boolean(),
    separateStores: z.array(z.string()),
    files: z
      .array(
        z
          .object({
            path: z.string(),
            bytes: z.number().int().nonnegative(),
            mode: z.union([z.literal(0o600), z.literal(0o700)]),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(100000),
  })
  .strict();
export type BackupManifest = z.infer<typeof manifestSchema>;
/** Filesystem snapshots cannot inherit containers still able to change source. */
export function assertQuiescentBackup(db: SqliteStore) {
  for (const table of ["sessions", "execution_invocations"]) {
    if (
      !db.one(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=" +
          sql(table),
      )
    )
      continue;
    for (const row of db.query<{ record: string }>(
      `SELECT record FROM ${table}`,
    )) {
      const record = JSON.parse(row.record);
      if (
        record.container ||
        ["starting", "active", "stopping", "destroying"].includes(record.status)
      )
        throw new Error(
          "Complete backup requires stopped, reconciled execution resources",
        );
    }
  }
  for (const [table, statuses] of [
    ["gateway_networks", ["stopped"]],
    ["environment_images", ["built", "failed", "evicted"]],
  ] as const) {
    if (
      !db.one(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=" +
          sql(table),
      )
    )
      continue;
    for (const row of db.query<{ record: string }>(
      `SELECT record FROM ${table}`,
    ))
      if (
        !(statuses as readonly string[]).includes(JSON.parse(row.record).status)
      )
        throw new Error(
          "Complete backup requires reconciled gateway and image resources",
        );
  }
  const auth = db.one<{ value: string }>(
    "SELECT value FROM control_settings WHERE key='subscription-auth-runs'",
  );
  if (
    auth &&
    JSON.parse(auth.value).some(
      (r: { status: string }) => r.status !== "stopped",
    )
  )
    throw new Error(
      "Complete backup requires stopped authentication resources",
    );
}
const skip = new Set([
  "controller.lock",
  "mission-control.db",
  "mission-control.db-wal",
  "mission-control.db-shm",
]);
function contained(root: string, path: string) {
  const r = relative(root, path);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
}
function safePath(path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((p) => !p || p === "." || p === "..") ||
    (skip.has(path) && path !== "mission-control.db")
  )
    throw new Error("Unsafe backup inventory path");
}
async function digest(path: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
async function assertNew(path: string) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  throw new Error(
    "Destination must be new; existing data is never overwritten",
  );
}
async function recipientFile(path: string) {
  const value = (await readFile(path, "utf8")).trim();
  if (!/^age1[0-9a-z]{58}$/.test(value))
    throw new Error("Recipient file must contain one age public recipient");
  return value;
}
async function ageProcess(args: string[], input: Readable, outputPath: string) {
  const child = spawn("age", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH },
  });
  let errorBytes = 0;
  child.stderr.on("data", (chunk) => {
    errorBytes += chunk.length;
    if (errorBytes > 64000) child.kill();
  });
  const completed = once(child, "close");
  try {
    await Promise.all([
      pipeline(input, child.stdin),
      pipeline(
        child.stdout,
        createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
      ),
    ]);
    const [code] = await completed;
    if (code !== 0)
      throw new Error(
        "age encryption/decryption failed; diagnostic contents are suppressed",
      );
  } catch (error) {
    child.kill();
    await rm(outputPath, { force: true });
    throw error;
  }
}

/** Caller owns the controller/maintenance lock for a complete filesystem copy. */
export async function createBackup(
  db: SqliteStore,
  stateRoot: string,
  destination: string,
  recipientPath: string,
  complete: boolean,
): Promise<BackupManifest> {
  const root = await realpath(stateRoot),
    output = resolve(destination);
  if (complete) assertQuiescentBackup(db);
  if (output === root || contained(root, output))
    throw new Error("Backups must live outside application state");
  await assertNew(output);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const recipient = await recipientFile(recipientPath),
    stage = await mkdtemp(join(tmpdir(), "mc-backup-"));
  const partial = `${output}.partial-${randomBytes(8).toString("hex")}`;
  try {
    await db.backup(join(stage, "mission-control.db"));
    const files: BackupManifest["files"] = [];
    const snapshotFile = async (source: string, path: string) => {
      safePath(path);
      const target = join(stage, path);
      if (source !== target) {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await pipeline(
          createReadStream(source),
          createWriteStream(target, { flags: "wx", mode: 0o600 }),
        );
      }
      files.push({
        path,
        bytes: (await lstat(target)).size,
        mode: (await lstat(source)).mode & 0o100 ? 0o700 : 0o600,
        sha256: await digest(target),
      });
    };
    await snapshotFile(join(stage, "mission-control.db"), "mission-control.db");
    if (complete) {
      const walk = async (directory: string) => {
        for (const name of (await readdir(directory)).sort()) {
          const source = join(directory, name),
            path = relative(root, source).replaceAll("\\", "/");
          if (skip.has(path)) continue;
          const info = await lstat(source);
          if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
            throw new Error(
              "Complete backup refuses symlinks and non-regular state entries",
            );
          if (info.isDirectory()) await walk(source);
          else await snapshotFile(source, path);
        }
      };
      await walk(root);
    } else await snapshotFile(join(root, "instance.json"), "instance.json");
    const identity = JSON.parse(
      await readFile(join(root, "instance.json"), "utf8"),
    );
    const manifest = manifestSchema.parse({
      format: "missioncontrol-backup-v1",
      applicationVersion: "1.0.0-alpha.0",
      schemaVersion: Number(
        db.one<{ user_version: number }>("PRAGMA user_version")?.user_version,
      ),
      instanceId: identity.id,
      createdAt: new Date().toISOString(),
      complete,
      separateStores: [
        "Matrix SDK crypto/session",
        "native subscription authentication",
        "homeserver PostgreSQL/media/signing keys",
        "external configuration and secrets",
      ],
      files,
    });
    const header = Buffer.from(JSON.stringify(manifest)),
      length = Buffer.alloc(4);
    if (header.length > 4 * 1024 ** 2)
      throw new Error("Backup manifest is too large");
    length.writeUInt32BE(header.length);
    async function* bundle() {
      yield length;
      yield header;
      for (const file of files)
        for await (const chunk of createReadStream(join(stage, file.path)))
          yield chunk;
    }
    await ageProcess(
      ["--encrypt", "--recipient", recipient],
      Readable.from(bundle()),
      partial,
    );
    await assertNew(output);
    await rename(partial, output);
    // Sidecar contains no paths from the instance; authenticated manifest is encrypted.
    await writeFile(`${output}.sha256`, `${await digest(output)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return manifest;
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(partial, { force: true });
  }
}

export async function restoreBackup(
  bundle: string,
  identityFile: string,
  destination: string,
): Promise<BackupManifest> {
  const root = resolve(destination);
  await assertNew(root);
  const identity = await lstat(identityFile);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.mode & 0o077)
    throw new Error("age identity must be a private regular file");
  const staging = await mkdtemp(join(tmpdir(), "mc-restore-")),
    plaintext = join(staging, "bundle");
  let created = false;
  try {
    await ageProcess(
      ["--decrypt", "--identity", identityFile],
      createReadStream(bundle),
      plaintext,
    );
    const input = await open(plaintext, "r");
    try {
      const length = Buffer.alloc(4);
      if ((await input.read(length, 0, 4, 0)).bytesRead !== 4)
        throw new Error("Truncated backup header");
      const size = length.readUInt32BE();
      if (size > 4 * 1024 ** 2) throw new Error("Backup manifest is too large");
      const header = Buffer.alloc(size);
      if ((await input.read(header, 0, size, 4)).bytesRead !== size)
        throw new Error("Truncated backup manifest");
      const manifest = manifestSchema.parse(JSON.parse(header.toString()));
      const paths = new Set<string>();
      let offset = 4 + size;
      for (const file of manifest.files) {
        safePath(file.path);
        if (paths.has(file.path)) throw new Error("Duplicate backup path");
        paths.add(file.path);
        offset += file.bytes;
      }
      if (
        !(paths.has("mission-control.db") && paths.has("instance.json")) ||
        offset !== (await lstat(plaintext)).size
      )
        throw new Error("Incomplete or invalid backup inventory");
      // Validate everything before creating the destination. No archive path is
      // delegated to tar extraction, symlinks or an invocation-directory default.
      await mkdir(root, { recursive: false, mode: 0o700 });
      created = true;
      offset = 4 + size;
      for (const file of manifest.files) {
        const target = join(root, file.path);
        if (!contained(root, target))
          throw new Error("Backup path escapes destination");
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        if (file.bytes)
          await pipeline(
            createReadStream(plaintext, {
              start: offset,
              end: offset + file.bytes - 1,
            }),
            createWriteStream(target, { flags: "wx", mode: file.mode }),
          );
        else await writeFile(target, "", { flag: "wx", mode: file.mode });
        offset += file.bytes;
        if ((await digest(target)) !== file.sha256)
          throw new Error("Restored file hash failed");
      }
      const inspected = await inspectState(root);
      if (inspected.id !== manifest.instanceId)
        throw new Error("Restored instance identity mismatch");
      if (inspected.schemaVersion !== manifest.schemaVersion)
        throw new Error("Restored schema differs from backup manifest");
      if (manifest.complete) {
        const db = new SqliteStore(join(root, "mission-control.db"), {
          mustExist: true,
        });
        try {
          new ControlStore(db);
          assertQuiescentBackup(db);
          await repairWorktreeLinks(
            root,
            new WorkspaceManager(root, db).storage
              .workspaces()
              .map((w) => w.path),
          );
        } finally {
          db.close();
        }
      }
      await writeFile(
        join(root, "restore-manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
        { mode: 0o600 },
      );
      return manifest;
    } finally {
      await input.close();
    }
  } catch (error) {
    if (created) await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
