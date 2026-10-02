import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { releaseSource } from "./sourceDelivery.js";
test("source download requires exact canonical packaged archive and matching manifest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(releaseSource(root), /unavailable/);
  const assets = join(root, "assets");
  await mkdir(assets);
  const bytes = Buffer.from("Synthetic archive");
  const archive = {
    path: "source.tar.gz",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await writeFile(join(assets, "source.tar.gz"), bytes);
  const manifest = {
    schemaVersion: 1,
    version: "1.0.0-alpha.0",
    sourceCommit: "a".repeat(40),
    archive,
    files: [],
  };
  await writeFile(
    join(assets, "source-manifest.json"),
    JSON.stringify(manifest),
  );
  assert.deepEqual((await releaseSource(root)).bytes, bytes);
  await writeFile(join(assets, "source.tar.gz"), "Modified archive");
  await assert.rejects(releaseSource(root), /unavailable/);
  await rm(join(assets, "source.tar.gz"));
  await writeFile(join(root, "outside"), bytes);
  await symlink(join(root, "outside"), join(assets, "source.tar.gz"));
  await assert.rejects(releaseSource(root), /unavailable/);
});
