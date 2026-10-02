import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "./git.js";
import {
  environmentManifestSchema,
  resolveEnvironmentManifest,
} from "./environmentManifest.js";
test("environment version follows pinned dependency blobs, toolchain and recipe, independent of checkout changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-manifest-"));
  t.after(() => rm(root, { recursive: true }));
  await git(root, ["init", "-b", "main"]);
  await writeFile(join(root, "lock"), "version1\n");
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "base",
  ]);
  const revision = await git(root, ["rev-parse", "HEAD"]),
    manifest = environmentManifestSchema.parse({
      projectId: "fixture",
      recipeVersion: "1",
      toolchains: { python: "3.11" },
      dependencyFiles: ["lock"],
      instructions: ["AGENTS.md"],
      checks: ["pytest"],
    });
  const a = await resolveEnvironmentManifest(
    manifest,
    root,
    revision,
    "recipe1",
  );
  await writeFile(join(root, "lock"), "dirty version2\n");
  const b = await resolveEnvironmentManifest(
    manifest,
    root,
    revision,
    "recipe1",
  );
  assert.equal(a.version, b.version);
  assert.equal(a.ready, false);
  assert.equal(a.enabled, false);
  const c = await resolveEnvironmentManifest(
    manifest,
    root,
    revision,
    "recipe2",
  );
  assert.notEqual(a.version, c.version);
  await assert.rejects(
    resolveEnvironmentManifest(
      { ...manifest, dependencyFiles: ["missing"] },
      root,
      revision,
      "recipe",
    ),
    /missing/,
  );
  assert.throws(() =>
    environmentManifestSchema.parse({ ...manifest, enabled: true }),
  );
});
