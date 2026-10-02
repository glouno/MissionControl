import { randomUUID } from "node:crypto";
import { lstat, realpath, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  EnvironmentImageBuilder,
  processIdentity,
  type EnvironmentBuildRecord,
} from "./environmentBuild.js";
import { storageDefaults } from "./storage.js";
import { ControlError } from "./schema.js";
import { sql } from "../sqlite.js";
import { ownedBuildCache, removeOwnedBuildCache } from "./buildCache.js";

async function directoryBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (info.isSymbolicLink())
    throw new ControlError("cache_path", "Redirected cache path", 409);
  if (info.isFile()) return info.size;
  if (!info.isDirectory())
    throw new ControlError("cache_path", "Nonordinary cache artifact", 409);
  let bytes = 0;
  for (const entry of await readdir(path))
    bytes += await directoryBytes(join(path, entry));
  return bytes;
}

// Only provenance-labelled images and dependency-only contexts registered by the
// trusted builder are disposable. No Docker-wide prune or user cache traversal.
export class ImageMaintenance {
  constructor(
    readonly builder: EnvironmentImageBuilder,
    readonly pins: () => Promise<Set<string>>,
    readonly clock = Date.now,
  ) {}
  private save(record: EnvironmentBuildRecord) {
    this.builder.db.exec(
      `UPDATE environment_images SET record=${sql(JSON.stringify(record))} WHERE id=${sql(record.id)}`,
    );
  }
  private async context(record: EnvironmentBuildRecord) {
    const expected = join(resolve(this.builder.root), "builds");
    if (
      dirname(record.context) !== expected ||
      !record.context.startsWith(join(expected, record.id + "_"))
    )
      throw new ControlError(
        "cache_path",
        "Build context ownership mismatch",
        409,
      );
    const info = await lstat(record.context).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return 0;
    if ((await realpath(join(this.builder.root, "builds"))) !== expected)
      throw new ControlError(
        "cache_path",
        "Redirected build context root",
        409,
      );
    if ((await realpath(record.context)) !== resolve(record.context))
      throw new ControlError("cache_path", "Redirected build context", 409);
    return directoryBytes(record.context);
  }
  private async image(record: EnvironmentBuildRecord) {
    if (!record.imageDigest) return undefined;
    const output = await this.builder.docker([
      "image",
      "ls",
      "--no-trunc",
      "--quiet",
      "--filter",
      `reference=${record.imageTag}`,
    ]);
    if (!output.stdout.trim()) return undefined;
    if (output.stdout.trim() !== record.imageDigest)
      throw new ControlError(
        "cache_owner",
        "Image tag moved from its recorded digest",
        409,
      );
    await this.builder.verify(record);
    const image = JSON.parse(
      (await this.builder.docker(["image", "inspect", record.imageDigest]))
        .stdout,
    )[0];
    if ((image.RepoTags ?? []).some((tag: string) => tag !== record.imageTag))
      throw new ControlError(
        "cache_owner",
        "Image has another owning tag",
        409,
      );
    if (image.RepoDigests?.length)
      throw new ControlError(
        "cache_owner",
        "Image has a remote retention identity",
        409,
      );
    return image;
  }
  async preview() {
    const pins = await this.pins();
    const buildsActive = this.builder
      .records()
      .some((r) => ["preparing", "building"].includes(r.status));
    const actions = [];
    for (const record of this.builder.records()) {
      const reasons: string[] = [];
      let imageBytes = 0,
        contextBytes = 0,
        cacheBytes = 0;
      if (buildsActive)
        reasons.push("dependency build may be reading an exported cache");
      if (!["built", "evicting"].includes(record.status))
        reasons.push("build is incomplete or already evicted");
      if (record.imageDigest && pins.has(record.imageDigest))
        reasons.push("pinned project or retained execution image");
      if (
        record.ownerPid &&
        record.ownerIdentity &&
        JSON.stringify(await processIdentity(record.ownerPid)) ===
          JSON.stringify(record.ownerIdentity)
      )
        reasons.push("build owner process remains active");
      try {
        contextBytes = await this.context(record);
      } catch (error) {
        reasons.push((error as Error).message);
      }
      try {
        const image = await this.image(record);
        imageBytes = image?.Size ?? 0;
        if (
          image &&
          (
            await this.builder.docker([
              "container",
              "ls",
              "--all",
              "--quiet",
              "--filter",
              `ancestor=${record.imageDigest}`,
            ])
          ).stdout.trim()
        )
          reasons.push("container still references image");
      } catch (error) {
        reasons.push((error as Error).message);
      }
      try {
        cacheBytes = (
          await ownedBuildCache(
            this.builder.root,
            record,
            !(record.status === "evicting" && record.cacheRemovalVerified),
          )
        ).bytes;
      } catch (error) {
        cacheBytes =
          (error as Error & { cacheBytes?: number }).cacheBytes ?? cacheBytes;
        reasons.push((error as Error).message);
      }
      actions.push({
        id: record.id,
        imageDigest: record.imageDigest,
        imageBytes,
        contextBytes,
        cacheBytes,
        lastUsedAt: record.lastUsedAt ?? record.updatedAt,
        eligible: reasons.length === 0,
        reasons,
      });
    }
    return {
      previewOnly: true,
      budgetBytes: storageDefaults.cacheBudgetBytes,
      // Inspect sizes include shared layers; report as an upper bound rather
      // than claiming these bytes can all be reclaimed independently.
      accountedUpperBoundBytes: actions.reduce(
        (n, a) => n + a.imageBytes + a.contextBytes + a.cacheBytes,
        0,
      ),
      actions,
    };
  }
  async maintain(
    apply = false,
    budgetBytes = storageDefaults.cacheBudgetBytes,
  ) {
    const db = this.builder.db,
      owner = randomUUID();
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0)
      throw new ControlError("cache_policy", "Invalid cache budget");
    const acquired = db.transaction(() => {
      db.exec(
        `DELETE FROM environment_maintenance WHERE expires<${this.clock()}`,
      );
      db.exec(
        `INSERT OR IGNORE INTO environment_maintenance VALUES('images',${sql(owner)},${this.clock() + 60000})`,
      );
      return (
        db.one<{ owner: string }>(
          "SELECT owner FROM environment_maintenance WHERE name='images'",
        )?.owner === owner
      );
    });
    if (!acquired)
      throw new ControlError(
        "active_work",
        "Image maintenance already leased",
        409,
      );
    const renew = setInterval(
      () =>
        db.exec(
          `UPDATE environment_maintenance SET expires=${this.clock() + 60000} WHERE owner=${sql(owner)}`,
        ),
      10000,
    );
    renew.unref();
    try {
      const preview = await this.preview(),
        removed: string[] = [],
        errors: { id: string; reason: string }[] = [];
      let remaining = preview.accountedUpperBoundBytes;
      if (apply)
        for (const action of [...preview.actions].sort(
          (a, b) => a.lastUsedAt - b.lastUsedAt,
        )) {
          const record = this.builder
            .records()
            .find((r) => r.id === action.id)!;
          if (record.status !== "evicting" && remaining <= budgetBytes)
            continue;
          if (!action.eligible) continue;
          try {
            const refreshed = (await this.preview()).actions.find(
              (a) => a.id === action.id,
            )!;
            if (!refreshed.eligible) continue;
            if (
              db.one<{ owner: string }>(
                "SELECT owner FROM environment_maintenance WHERE name='images'",
              )?.owner !== owner
            )
              throw new ControlError(
                "lease_lost",
                "Image maintenance ownership changed",
                409,
              );
            const removing = {
              ...record,
              status: "evicting" as const,
              cacheRemovalVerified: true,
            };
            this.save(removing);
            const image = await this.image(record);
            if (image)
              await this.builder.docker(["image", "rm", record.imageDigest!]);
            await this.context(record);
            await removeOwnedBuildCache(this.builder.root, removing);
            await rm(record.context, { recursive: true, force: true });
            this.save({
              ...record,
              status: "evicted",
              updatedAt: this.clock(),
            });
            removed.push(record.id);
            remaining -=
              action.imageBytes + action.contextBytes + action.cacheBytes;
          } catch (error) {
            errors.push({ id: record.id, reason: (error as Error).message });
          }
        }
      return {
        ...preview,
        previewOnly: !apply,
        budgetBytes,
        removed,
        errors,
        remainingUpperBoundBytes: remaining,
      };
    } finally {
      clearInterval(renew);
      db.exec(`DELETE FROM environment_maintenance WHERE owner=${sql(owner)}`);
    }
  }
}
