import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
// prettier-ignore
// @ts-expect-error Release evidence validator is JavaScript build tooling.
import { PREVIEW_GATES, loadQualification } from "../scripts/qualification.mjs";

test("preview qualification requires exact mandatory gates and unchanged private evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-qualification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = Buffer.from("synthetic acceptance receipt");
  await writeFile(join(root, "proof.json"), evidence);
  const hash = (b: Buffer | string) =>
    createHash("sha256").update(b).digest("hex");
  const fingerprints = {
    sourceCommit: "a".repeat(40),
    sourceInventorySha256: hash("source"),
    npmLockSha256: hash("npm"),
    rustLockSha256: hash("rust"),
    runtimeInventorySha256: hash("runtime"),
  };
  const receipt = {
    schemaVersion: 1,
    scope: "linux-wsl-preview",
    configSchemaVersion: 1,
    applicationSchemaVersion: 6,
    ...fingerprints,
    gates: PREVIEW_GATES.map((id: string) => ({
      id,
      status: "passed",
      sourceCommit: fingerprints.sourceCommit,
      procedure: "synthetic test",
      configurationSha256: hash("configuration"),
      imageDigest: `sha256:${hash("image")}`,
      platform: { os: "linux", fingerprintSha256: hash("platform") },
      evidence: [
        { file: "proof.json", bytes: evidence.length, sha256: hash(evidence) },
      ],
    })),
  };
  const file = join(root, "qualification.json"),
    save = async (value: unknown) => writeFile(file, JSON.stringify(value));
  assert.equal(
    (await loadQualification(undefined, fingerprints)).qualified,
    false,
  );
  await save(receipt);
  assert.equal((await loadQualification(file, fingerprints)).qualified, true);
  await save({ ...receipt, gates: receipt.gates.map((g: {id: string}) =>
    g.id === "azure-responses" ? { ...g, sourceCommit: "b".repeat(40) } : g) });
  await assert.rejects(loadQualification(file, fingerprints), /runtime equivalence/);
  await save(receipt);
  await assert.rejects(
    loadQualification(file, { ...fingerprints, sourceCommit: "b".repeat(40) }),
    /fingerprints/,
  );
  await save({ ...receipt, gates: receipt.gates.slice(1) });
  await assert.rejects(loadQualification(file, fingerprints), /Unsupported/);
  await save({
    ...receipt,
    gates: receipt.gates.map((g: { id: string }) =>
      g.id === "task-ownership-recovery" ? { ...g, imageDigest: undefined } : g,
    ),
  });
  await assert.rejects(
    loadQualification(file, fingerprints),
    /immutable image/,
  );
  await save(receipt);
  await writeFile(join(root, "proof.json"), "changed");
  await assert.rejects(
    loadQualification(file, fingerprints),
    /missing|changed/,
  );
});
