import { z } from "zod";
import {
  readFile,
  writeFile,
  lstat,
  realpath,
  readdir,
  mkdtemp,
  rm,
  rename,
  open,
} from "node:fs/promises";
import { join, basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { restoreBackup } from "./backup.js";
import { SqliteStore } from "./sqlite.js";
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    createdAt: z.string().datetime(),
    bundle: z.string().regex(/^application-[a-zA-Z0-9T.:-]+\.age$/),
    bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
    instanceId: z.string(),
    schema: z.number().int().positive(),
    complete: z.literal(true),
    restoreVerified: z.boolean(),
    pinned: z.boolean(),
    separateStores: z.array(z.string()),
    recoveryFiles: z
      .array(
        z
          .object({
            path: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .optional(),
    recoveryRecords: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
    unfinishedGoals: z.boolean().optional(),
    verifiedAt: z.string().datetime().optional(),
    verification: z
      .object({
        bundleSha256: z.string(),
        schema: z.number().int(),
        instanceId: z.string(),
        integrity: z.literal("ok"),
        isolatedRestore: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict();
type Receipt = z.output<typeof receiptSchema>;
async function privateEntry(path: string, directory = false) {
  const meta = await lstat(path);
  if (
    meta.isSymbolicLink() ||
    !(directory ? meta.isDirectory() : meta.isFile()) ||
    meta.mode & 0o077 ||
    meta.uid !== process.getuid?.() ||
    (await realpath(path)) !== path
  )
    throw Error("Backup retention requires private owned canonical entries");
}
async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function withOwner<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const root = resolve(directory);
  await privateEntry(root, true);
  const path = join(root, ".retention.lock"),
    nonce = randomUUID();
  const file = await open(path, "wx", 0o600).catch(() => {
    throw Error(
      "Backup retention has an active or interrupted owner; inspect its private lock before retrying",
    );
  });
  try {
    await file.writeFile(JSON.stringify({ pid: process.pid, nonce }));
    await file.sync();
    return await operation();
  } finally {
    await file.close();
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.nonce === nonce) await rm(path);
  }
}

async function load(path: string) {
  path = resolve(path);
  await privateEntry(dirname(path), true);
  await privateEntry(path);
  const receipt = receiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (basename(path) !== receipt.bundle.replace(/\.age$/, ".receipt.json"))
    throw Error("Receipt filename differs from registered bundle");
  const bundle = join(dirname(path), receipt.bundle);
  await privateEntry(bundle);
  if ((await digest(bundle)) !== receipt.bundleSha256)
    throw Error("Registered backup hash differs");
  return { receipt, bundle, path };
}
async function save(path: string, receipt: Receipt) {
  const temp = path + `.${randomUUID()}.new`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(receipt, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  await syncDirectory(dirname(path));
}
async function syncDirectory(path: string) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
/** A hash receipt alone never proves recoverability. Decrypt and restore elsewhere. */
export async function verifyBackupReceipt(path: string, identityFile: string) {
  return withOwner(dirname(resolve(path)), () =>
    verifyUnlocked(path, identityFile),
  );
}
async function verifyUnlocked(path: string, identityFile: string) {
  const { receipt, bundle, path: canonical } = await load(path);
  const stage = await mkdtemp(join(tmpdir(), "mc-backup-verification-"));
  try {
    const manifest = await restoreBackup(
      bundle,
      identityFile,
      join(stage, "restore"),
    );
    if (
      !manifest.complete ||
      manifest.instanceId !== receipt.instanceId ||
      manifest.schemaVersion !== receipt.schema ||
      JSON.stringify(manifest.separateStores) !==
        JSON.stringify(receipt.separateStores)
    )
      throw Error("Restored instance differs from backup receipt");
    if ((await digest(bundle)) !== receipt.bundleSha256)
      throw Error("Backup changed during verification");
    const db = new SqliteStore(join(stage, "restore", "mission-control.db"), {
      mustExist: true,
      readOnly: true,
    });
    const recoveryRecords: string[] = [];
    let unfinishedGoals = false;
    try {
      for (const table of [
        "control_goals",
        "control_tasks",
        "control_attempts",
        "control_questions",
        "control_evidence",
        "control_budgets",
        "control_artifacts",
      ]) {
        if (
          !db.one(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`,
          )
        )
          continue;
        for (const row of db.query(`SELECT * FROM ${table}`))
          recoveryRecords.push(
            createHash("sha256")
              .update(table + JSON.stringify(row))
              .digest("hex"),
          );
      }
      unfinishedGoals = !!db.one(
        "SELECT id FROM control_goals WHERE status NOT IN ('completed','cancelled','failed') LIMIT 1",
      );
    } finally {
      db.close();
    }
    const verified: Receipt = {
      ...receipt,
      restoreVerified: true,
      verifiedAt: new Date().toISOString(),
      // Only immutable file coverage demonstrates that a later application
      // snapshot retains older recovery material. Changed work stays protected.
      recoveryFiles: manifest.files
        .filter(
          (f) => !["mission-control.db", "instance.json"].includes(f.path),
        )
        .map((f) => ({ path: f.path, sha256: f.sha256 })),
      recoveryRecords,
      unfinishedGoals,
      verification: {
        bundleSha256: receipt.bundleSha256,
        schema: manifest.schemaVersion,
        instanceId: manifest.instanceId,
        integrity: "ok",
        isolatedRestore: true,
      },
    };
    await save(canonical, verified);
    return {
      verified: true,
      pinned: verified.pinned,
      separateStores: verified.separateStores,
      applicationOnly: true,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function pinBackupReceipt(path: string, pinned: boolean) {
  return withOwner(dirname(resolve(path)), () => pinUnlocked(path, pinned));
}
async function pinUnlocked(path: string, pinned: boolean) {
  const loaded = await load(path);
  if (!pinned && !verified(loaded.receipt))
    throw Error("Unverified backup cannot be unpinned");
  if (!pinned && loaded.receipt.unfinishedGoals !== false)
    throw Error("Backup with unfinished or uninspected work remains pinned");
  await save(loaded.path, { ...loaded.receipt, pinned });
  return { pinned };
}
function verified(r: Receipt) {
  return (
    r.restoreVerified &&
    !!r.verifiedAt &&
    r.verification?.bundleSha256 === r.bundleSha256 &&
    r.verification.instanceId === r.instanceId &&
    r.verification.schema === r.schema
  );
}
function supersedes(old: Receipt, next: Receipt) {
  return (
    next.createdAt > old.createdAt &&
    next.instanceId === old.instanceId &&
    next.schema === old.schema &&
    verified(next) &&
    JSON.stringify(next.separateStores) ===
      JSON.stringify(old.separateStores) &&
    old.unfinishedGoals === false &&
    !!old.recoveryRecords &&
    !!next.recoveryRecords &&
    old.recoveryRecords.every((r) => next.recoveryRecords!.includes(r)) &&
    !!old.recoveryFiles &&
    !!next.recoveryFiles &&
    old.recoveryFiles.every((f) =>
      next.recoveryFiles!.some(
        (n) => n.path === f.path && n.sha256 === f.sha256,
      ),
    )
  );
}
export async function pruneBackups(directory: string, apply = false) {
  return withOwner(directory, () => pruneUnlocked(directory, apply));
}
async function pruneUnlocked(directory: string, apply = false) {
  const root = resolve(directory);
  await privateEntry(root, true);
  if (
    (await readdir(root)).some(
      (n) => n.startsWith(".prune-") && n.endsWith(".json"),
    )
  )
    throw Error(
      "Interrupted backup deletion intent requires private inspection; further pruning is closed",
    );
  const records: Awaited<ReturnType<typeof load>>[] = [];
  for (const name of await readdir(root)) {
    if (!name.endsWith(".receipt.json")) continue;
    records.push(await load(join(root, name)));
  }
  records.sort((a, b) =>
    a.receipt.createdAt.localeCompare(b.receipt.createdAt),
  );
  const actions = records.map((r, index) => {
    const superseded = records
      .slice(index + 1)
      .some((n) => supersedes(r.receipt, n.receipt));
    return {
      bundle: r.receipt.bundle,
      eligible: verified(r.receipt) && !r.receipt.pinned && superseded,
      reason: !verified(r.receipt)
        ? "restore not verified"
        : r.receipt.pinned
          ? "pinned"
          : !superseded
            ? "no newer verified copy retaining recovery files and store requirements"
            : "verified and superseded",
    };
  });
  const removed = [];
  if (apply)
    for (const action of actions.filter((a) => a.eligible)) {
      const fresh = await load(
        join(root, action.bundle.replace(/\.age$/, ".receipt.json")),
      );
      if (fresh.receipt.pinned || !verified(fresh.receipt)) continue;
      const newer = records.filter((n) => supersedes(fresh.receipt, n.receipt));
      let recovery: Awaited<ReturnType<typeof load>> | undefined;
      for (const n of newer) {
        try {
          const candidate = await load(n.path);
          if (supersedes(fresh.receipt, candidate.receipt))
            recovery = candidate;
        } catch {}
      }
      if (!recovery) continue;
      const intent = join(root, `.prune-${randomUUID()}.json`);
      const journal = await open(intent, "wx", 0o600);
      try {
        await journal.writeFile(
          JSON.stringify({
            schemaVersion: 1,
            receipt: fresh.receipt,
            replacement: recovery.receipt,
            action: "delete registered superseded application backup",
          }) + "\n",
        );
        await journal.sync();
      } finally {
        await journal.close();
      }
      await syncDirectory(root);
      await rm(fresh.bundle);
      await rm(fresh.path);
      const checksum = fresh.bundle + ".sha256";
      try {
        await privateEntry(checksum);
        if (
          (await readFile(checksum, "utf8")).trim() ===
          fresh.receipt.bundleSha256
        )
          await rm(checksum);
      } catch {}
      await syncDirectory(root);
      await rm(intent);
      await syncDirectory(root);
      removed.push(action.bundle);
    }
  return { previewOnly: !apply, actions, removed };
}
