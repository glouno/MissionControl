import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ownedBuildCache, removeOwnedBuildCache } from "./buildCache.js";
import type { EnvironmentBuildRecord } from "./environmentBuild.js";

test("owned exported cache verifies manifest identity and refuses redirected or corrupt artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-build-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "caches", "fixture_version_unique");
  const record = {
    id: "fixture_version",
    cachePath: path,
  } as EnvironmentBuildRecord;
  await mkdir(join(path, "blobs", "sha256"), { recursive: true });
  const content = Buffer.from('{"schemaVersion":2}'),
    hash = createHash("sha256").update(content).digest("hex");
  const blob = join(path, "blobs", "sha256", hash);
  await writeFile(blob, content);
  await writeFile(join(path, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
  await writeFile(
    join(path, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [{ digest: `sha256:${hash}`, size: content.length }],
    }),
  );
  assert((await ownedBuildCache(root, record)).bytes > content.length);
  await writeFile(blob, "corrupted");
  await assert.rejects(
    removeOwnedBuildCache(root, record),
    (error: any) => /blob differs/.test(error.message) && error.cacheBytes > 0,
  );
  assert.equal(await readFile(blob, "utf8"), "corrupted");
  await writeFile(blob, content);
  await symlink(blob, join(path, "redirect"));
  await assert.rejects(removeOwnedBuildCache(root, record), /Redirected/);
  await rm(join(path, "redirect"));
  await writeFile(join(path, "private.env"), "retained unclassified content");
  await assert.rejects(removeOwnedBuildCache(root, record), /Unclassified/);
  await rm(join(path, "private.env"));
  await mkdir(join(path, "ingest"));
  await writeFile(join(path, "ingest", "partial"), "unfinished");
  await assert.rejects(removeOwnedBuildCache(root, record), /Incomplete/);
  await rm(join(path, "ingest", "partial"));
  await rm(join(path, "index.json"));
  await assert.rejects(removeOwnedBuildCache(root, record), /ENOENT/);
  assert(
    (await removeOwnedBuildCache(root, {
      ...record,
      status: "evicting",
      cacheRemovalVerified: true,
    })) > 0,
  );
  await assert.rejects(
    removeOwnedBuildCache(root, { ...record, cachePath: root }),
    /ownership/,
  );
  assert.equal(await removeOwnedBuildCache(root, record), 0);
  assert.deepEqual(await ownedBuildCache(root, record), {
    bytes: 0,
    present: false,
  });
});
