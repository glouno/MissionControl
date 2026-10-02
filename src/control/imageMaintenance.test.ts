import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvironmentImageBuilder,
  type EnvironmentBuildRecord,
} from "./environmentBuild.js";
import { ImageMaintenance } from "./imageMaintenance.js";
import { sql } from "../sqlite.js";
import { createHash } from "node:crypto";

test("image LRU evicts only owned unpinned unused provenance and reconciles partial eviction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-image-maintenance-"));
  const calls: string[][] = [],
    images = new Map<string, any>(),
    pins = new Set<string>();
  let busy = false,
    down = false;
  const docker = async (args: string[]) => {
    calls.push(args);
    if (down) throw new Error("Docker unavailable");
    if (args[0] === "container")
      return { stdout: busy ? "container" : "", stderr: "" };
    if (args[1] === "ls") {
      const tag = args.at(-1)!.slice("reference=".length);
      return {
        stdout:
          [...images.values()].find((i) => i.RepoTags.includes(tag))?.Id ?? "",
        stderr: "",
      };
    }
    if (args[1] === "inspect")
      return { stdout: JSON.stringify([images.get(args[2])]), stderr: "" };
    if (args[1] === "rm") {
      images.delete(args[2]);
      return { stdout: "removed", stderr: "" };
    }
    throw new Error("Unexpected Docker action");
  };
  const builder = new EnvironmentImageBuilder(root, docker, async () => {});
  t.after(async () => {
    builder.db.close();
    await rm(root, { recursive: true, force: true });
  });
  const records: EnvironmentBuildRecord[] = [];
  for (const [index, project] of ["old", "pinned", "new"].entries()) {
    const digest = `sha256:${String(index + 1).repeat(64)}`;
    const record: EnvironmentBuildRecord = {
      id: project + "_version",
      projectId: project,
      version: "version",
      revision: "a".repeat(40),
      baseImageDigest: "sha256:" + "b".repeat(64),
      imageTag: `missioncontrol/project-${project}:version`,
      imageDigest: digest,
      context: join(root, "builds", project + "_version_owned"),
      cachePath: join(root, "caches", project + "_version_owned"),
      status: "built",
      createdAt: index + 1,
      updatedAt: index + 1,
      inputs: {},
    };
    await mkdir(record.context, { recursive: true });
    await writeFile(join(record.context, "lock"), "frozen dependency");
    const manifest = Buffer.from("{}"),
      hash = createHash("sha256").update(manifest).digest("hex");
    await mkdir(join(record.cachePath!, "blobs", "sha256"), {
      recursive: true,
    });
    await writeFile(join(record.cachePath!, "blobs", "sha256", hash), manifest);
    await writeFile(
      join(record.cachePath!, "oci-layout"),
      '{"imageLayoutVersion":"1.0.0"}',
    );
    await writeFile(
      join(record.cachePath!, "index.json"),
      JSON.stringify({
        schemaVersion: 2,
        manifests: [{ digest: `sha256:${hash}`, size: manifest.length }],
      }),
    );
    builder.db.exec(
      `INSERT INTO environment_images VALUES(${sql(record.id)},${sql(JSON.stringify(record))})`,
    );
    images.set(digest, {
      Id: digest,
      Size: 100,
      RepoTags: [record.imageTag],
      Config: {
        Labels: {
          "missioncontrol.environment.version": record.version,
          "missioncontrol.environment.project": record.projectId,
          "missioncontrol.environment.base": record.baseImageDigest,
        },
      },
    });
    records.push(record);
  }
  pins.add(records[1].imageDigest!);
  const maintenance = new ImageMaintenance(builder, async () => pins);
  const beforeCorrupt = (await maintenance.preview()).accountedUpperBoundBytes;
  const oldIndex = await readFile(join(records[0].cachePath!, "index.json"));
  await writeFile(
    join(records[0].cachePath!, "index.json"),
    "x".repeat(oldIndex.length),
  );
  const corrupt = await maintenance.preview();
  assert.equal(corrupt.accountedUpperBoundBytes, beforeCorrupt);
  assert.equal(corrupt.actions[0].eligible, false);
  await writeFile(join(records[0].cachePath!, "index.json"), oldIndex);
  assert.equal((await maintenance.preview()).actions[1].eligible, false);
  assert.deepEqual((await maintenance.maintain()).removed, []);
  assert((await maintenance.preview()).actions[0].cacheBytes > 0);
  const building = { ...records[2], status: "building" };
  builder.db.exec(
    `UPDATE environment_images SET record=${sql(JSON.stringify(building))} WHERE id=${sql(building.id)}`,
  );
  assert.deepEqual((await maintenance.maintain(true, 0)).removed, []);
  builder.db.exec(
    `UPDATE environment_images SET record=${sql(JSON.stringify(records[2]))} WHERE id=${sql(building.id)}`,
  );
  busy = true;
  assert.deepEqual((await maintenance.maintain(true, 0)).removed, []);
  busy = false;
  down = true;
  assert.deepEqual((await maintenance.maintain(true, 0)).removed, []);
  down = false;
  images.get(records[0].imageDigest!)!.RepoTags.push("unrelated/service:keep");
  assert.equal((await maintenance.preview()).actions[0].eligible, false);
  images.get(records[0].imageDigest!)!.RepoTags.pop();
  images.get(records[0].imageDigest!)!.Config.Labels[
    "missioncontrol.environment.version"
  ] = "tampered";
  assert.equal((await maintenance.preview()).actions[0].eligible, false);
  images.get(records[0].imageDigest!)!.Config.Labels[
    "missioncontrol.environment.version"
  ] = "version";
  const total = (await maintenance.preview()).accountedUpperBoundBytes;
  const evicted = await maintenance.maintain(true, total - 1);
  assert.deepEqual(evicted.removed, [records[0].id]);
  await assert.rejects(
    readFile(join(records[0].cachePath!, "index.json")),
    /ENOENT/,
  );
  assert.equal(
    await readFile(join(records[1].context, "lock"), "utf8"),
    "frozen dependency",
  );
  assert.ok(!calls.some((a) => a.includes("prune") || a.includes("--force")));
  // Crash after image deletion still reclaims just the recorded dependency context.
  const record = records[2];
  images.delete(record.imageDigest!);
  await rm(join(record.cachePath!, "index.json"));
  builder.db.exec(
    `UPDATE environment_images SET record=${sql(JSON.stringify({ ...record, status: "evicting", cacheRemovalVerified: true }))} WHERE id=${sql(record.id)}`,
  );
  const reconciled = await maintenance.maintain(true, 10000);
  assert.deepEqual(reconciled.removed, [record.id]);
  assert.equal(
    builder.records().find((r) => r.id === record.id)?.status,
    "evicted",
  );
});
