import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EnvironmentImageBuilder,
  processIdentity,
} from "./environmentBuild.js";
import { environmentManifestSchema } from "./environmentManifest.js";
import { git } from "./git.js";
const digest = `sha256:${"a".repeat(64)}`,
  base = `sha256:${"b".repeat(64)}`;
const recipe =
  "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY lock /opt/lock\nUSER 1000:1000\n";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-image-build-"));
  await git(root, ["init", "-b", "main"]);
  await writeFile(join(root, "lock"), Buffer.from([0, 1, 2, 10, 10]));
  await git(root, ["add", "lock"]);
  await git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "base",
  ]);
  const revision = await git(root, ["rev-parse", "HEAD"]);
  const calls: string[][] = [];
  let image: any,
    down = false;
  const docker = async (args: string[]) => {
    calls.push(args);
    if (down) throw new Error("Docker unavailable");
    if (args[1] === "tag") return { stdout: "", stderr: "" };
    if (
      args[1] === "inspect" &&
      args[2].startsWith("missioncontrol/build-base:")
    )
      return { stdout: JSON.stringify([{ Id: base }]), stderr: "" };
    if (args[0] === "build") {
      const cache = args[args.indexOf("--cache-to") + 1]
        .split("dest=")[1]
        .split(",")[0];
      const content = Buffer.from('{"schemaVersion":2}');
      const hash = createHash("sha256").update(content).digest("hex");
      await mkdir(join(cache, "blobs", "sha256"), { recursive: true });
      await writeFile(join(cache, "blobs", "sha256", hash), content);
      await writeFile(
        join(cache, "oci-layout"),
        JSON.stringify({ imageLayoutVersion: "1.0.0" }),
      );
      await writeFile(
        join(cache, "index.json"),
        JSON.stringify({
          schemaVersion: 2,
          manifests: [{ digest: `sha256:${hash}`, size: content.length }],
        }),
      );
      const labels = Object.fromEntries(
        args
          .map((x, i) => (x === "--label" ? args[i + 1].split("=") : []))
          .filter((x) => x.length),
      );
      image = { Id: digest, Config: { Labels: labels } };
      return { stdout: "built", stderr: "" };
    }
    if (args[1] === "inspect")
      return { stdout: JSON.stringify([image]), stderr: "" };
    if (args[1] === "ls")
      return {
        stdout: image ? JSON.stringify({ ID: digest }) : "",
        stderr: "",
      };
    throw new Error("Unexpected Docker operation");
  };
  const builder = new EnvironmentImageBuilder(
    join(root, "images"),
    docker,
    async () => {},
  );
  t.after(async () => {
    builder.db.close();
    await rm(root, { recursive: true });
  });
  const manifest = environmentManifestSchema.parse({
    projectId: "fixture",
    recipeVersion: "1",
    toolchains: { python: "3.11" },
    dependencyFiles: ["lock"],
    instructions: ["README.md"],
    checks: ["test"],
  });
  return {
    root,
    revision,
    builder,
    manifest,
    calls,
    setDown: (v: boolean) => {
      down = v;
    },
    tamper: () => {
      image.Config.Labels = {};
    },
  };
}
test("controlled image build uses exact pinned blobs and verifies reuse provenance", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "lock"), "dirty dependency");
  await writeFile(join(f.root, "private.env"), "must not enter image");
  const r = await f.builder.build(f.manifest, f.root, f.revision, recipe, base);
  assert.equal(r.status, "built");
  assert.equal(r.imageDigest, digest);
  assert.deepEqual(
    await readFile(join(r.context, "lock")),
    Buffer.from([0, 1, 2, 10, 10]),
  );
  await assert.rejects(readFile(join(r.context, "private.env")));
  assert.ok(
    f.calls
      .find((c) => c[0] === "build")!
      .includes(`BASE_IMAGE=missioncontrol/build-base:${base.slice(7)}`),
  );
  await f.builder.build(f.manifest, f.root, f.revision, recipe, base);
  assert.equal(f.calls.filter((c) => c[0] === "build").length, 1);
  f.tamper();
  await assert.rejects(
    f.builder.build(f.manifest, f.root, f.revision, recipe, base),
    /provenance/,
  );
  await assert.rejects(
    f.builder.build(f.manifest, f.root, f.revision, "FROM latest", base),
    /pinned base/,
  );
});
test("image build reconciliation preserves pending intent on daemon error and verifies resulting image", async (t) => {
  const f = await fixture(t);
  const r = await f.builder.build(f.manifest, f.root, f.revision, recipe, base);
  const interrupted = { ...r, status: "building" };
  delete interrupted.ownerPid;
  delete interrupted.ownerIdentity;
  delete interrupted.imageDigest;
  f.builder.db.exec(
    `UPDATE environment_images SET record='${JSON.stringify(interrupted)}'`,
  );
  f.setDown(true);
  await assert.rejects(f.builder.reconcile(), /unavailable/);
  assert.equal(f.builder.records()[0].status, "building");
  await assert.rejects(
    f.builder.build(f.manifest, f.root, f.revision, recipe, base),
    /Reconcile/,
  );
  f.setDown(false);
  await f.builder.reconcile();
  assert.equal(f.builder.records()[0].status, "built");
  assert.equal(f.builder.records()[0].imageDigest, digest);
});
test("image build pauses before filesystem or Docker actions under storage pressure", async (t) => {
  const f = await fixture(t);
  const builder = new EnvironmentImageBuilder(
    join(f.root, "pressure"),
    async () => {
      throw new Error("Docker must not run");
    },
    async () => {
      throw new Error("storage pressure");
    },
  );
  t.after(() => builder.db.close());
  await assert.rejects(
    builder.build(f.manifest, f.root, f.revision, recipe, base),
    /storage pressure/,
  );
  assert.equal(builder.records().length, 0);
});
test("reconciliation skips a live build owner without blocking other projects", async (t) => {
  const f = await fixture(t);
  const record = await f.builder.build(
    f.manifest,
    f.root,
    f.revision,
    recipe,
    base,
  );
  const active = { ...record, status: "building", ownerPid: process.pid };
  f.builder.db.exec(
    `UPDATE environment_images SET record='${JSON.stringify(active)}'`,
  );
  const calls = f.calls.length;
  await f.builder.reconcile();
  assert.equal(f.calls.length, calls);
  assert.equal(f.builder.records()[0].status, "building");
});
test("reconciliation fences reused PIDs and records invalid provenance as retryable failure", async (t) => {
  const f = await fixture(t);
  const record = await f.builder.build(
    f.manifest,
    f.root,
    f.revision,
    recipe,
    base,
  );
  const stale = {
    ...record,
    status: "building",
    ownerPid: process.pid,
    ownerIdentity: { bootId: "old-boot", startTicks: "0" },
  };
  f.builder.db.exec(
    `UPDATE environment_images SET record='${JSON.stringify(stale)}'`,
  );
  f.tamper();
  await f.builder.reconcile();
  assert.equal(f.builder.records()[0].status, "failed");
  assert.match(f.builder.records()[0].error!, /provenance/);
  const rebuilt = await f.builder.build(
    f.manifest,
    f.root,
    f.revision,
    recipe,
    base,
  );
  assert.equal(rebuilt.status, "built");
});

// This probes the real host API, including Darwin libproc, without Docker mocks.
test("process identity is stable for a live child and absent after it exits", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await once(child, "spawn");
  try {
    const first = await processIdentity(child.pid!);
    assert.ok(first?.bootId);
    assert.ok(first.startTicks);
    assert.deepEqual(await processIdentity(child.pid!), first);
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  assert.equal(await processIdentity(child.pid!), undefined);
  assert.equal(await processIdentity(-1), undefined);
  assert.equal(await processIdentity(0x100000001), undefined);
});
