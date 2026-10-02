import { lstat, realpath, readdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { ControlError } from "./schema.js";
import type { EnvironmentBuildRecord } from "./environmentBuild.js";

// Only exports created by the trusted dependency-image builder are disposable.
// Docker's global BuildKit records remain outside this ownership boundary.
export async function ownedBuildCache(
  root: string,
  record: EnvironmentBuildRecord,
  verify = true,
) {
  if (!record.cachePath) return { bytes: 0, present: false };
  const parent = join(resolve(root), "caches");
  const path = record.cachePath;
  if (
    dirname(path) !== parent ||
    !path.startsWith(join(parent, record.id + "_"))
  )
    throw new ControlError(
      "cache_owner",
      "Build cache ownership mismatch",
      409,
    );
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return { bytes: 0, present: false };
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path
  )
    throw new ControlError("cache_path", "Redirected build cache", 409);
  if ((await realpath(parent)) !== parent)
    throw new ControlError("cache_path", "Redirected build cache root", 409);
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const entry = join(directory, name),
        stat = await lstat(entry);
      if (stat.isSymbolicLink())
        throw new ControlError(
          "cache_path",
          "Redirected build cache artifact",
          409,
        );
      const local = relative(path, entry);
      if (
        ![
          "index.json",
          "oci-layout",
          "blobs",
          "blobs/sha256",
          "ingest",
        ].includes(local) &&
        !/^blobs\/sha256\/[a-f0-9]{64}$/.test(local)
      )
        throw new ControlError(
          "cache_format",
          "Unclassified build cache artifact",
          409,
        );
      if (
        local === "ingest" &&
        (!stat.isDirectory() || (await readdir(entry)).length)
      )
        throw new ControlError(
          "cache_format",
          "Incomplete build cache ingest retained",
          409,
        );
      if (stat.isDirectory()) await walk(entry);
      else if (stat.isFile()) bytes += stat.size;
      else
        throw new ControlError(
          "cache_path",
          "Nonordinary build cache artifact",
          409,
        );
    }
  };
  await walk(path);
  if (!verify) return { bytes, present: true };
  try {
    for (const hash of await readdir(join(path, "blobs", "sha256"))) {
      if (!/^[a-f0-9]{64}$/.test(hash))
        throw new ControlError(
          "cache_format",
          "Invalid build cache blob name",
          409,
        );
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(
        join(path, "blobs", "sha256", hash),
      ))
        digest.update(chunk);
      if (digest.digest("hex") !== hash)
        throw new ControlError("cache_format", "Build cache blob differs", 409);
    }
    const layout = JSON.parse(await readFile(join(path, "oci-layout"), "utf8"));
    if (layout.imageLayoutVersion !== "1.0.0")
      throw new ControlError("cache_format", "Unknown build cache layout", 409);
    const index = JSON.parse(await readFile(join(path, "index.json"), "utf8"));
    if (
      index.schemaVersion !== 2 ||
      !Array.isArray(index.manifests) ||
      !index.manifests.length
    )
      throw new ControlError(
        "cache_format",
        "Missing build cache manifest",
        409,
      );
    // Verify the exported root manifests before trusting a cache for another build.
    for (const manifest of index.manifests) {
      if (!/^sha256:[a-f0-9]{64}$/.test(manifest.digest))
        throw new ControlError(
          "cache_format",
          "Invalid build cache digest",
          409,
        );
      const content = await readFile(
        join(path, "blobs", "sha256", manifest.digest.slice(7)),
      );
      if (
        content.length !== manifest.size ||
        createHash("sha256").update(content).digest("hex") !==
          manifest.digest.slice(7)
      )
        throw new ControlError(
          "cache_format",
          "Build cache manifest differs",
          409,
        );
    }
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      { cacheBytes: bytes },
    );
  }
  return { bytes, present: true };
}

export async function removeOwnedBuildCache(
  root: string,
  record: EnvironmentBuildRecord,
) {
  const cache = await ownedBuildCache(
    root,
    record,
    !(record.status === "evicting" && record.cacheRemovalVerified),
  );
  if (cache.present) await rm(record.cachePath!, { recursive: true });
  return cache.bytes;
}
