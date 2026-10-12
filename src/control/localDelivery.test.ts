import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createLocalDeliveryGate } from "./localDelivery.js";

test("host delivery bridge rejects stale proofs, failed checks and altered executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "mc-delivery-bridge-"));
  const script = join(root, "bridge.mjs");
  const input = {
    goalId: "synthetic",
    repoPath: root,
    workspace: root,
    candidateSha: "a".repeat(40),
    targetSha: "b".repeat(40),
    requiredChecks: ["local"],
  };
  const config = {
    command: process.execPath,
    script,
    scriptSha256: "",
    config: join(root, "config.json"),
    state: root,
    timeoutMs: 1000,
  };
  async function prepare(proof: object) {
    const source = `process.stdout.write(${JSON.stringify(JSON.stringify(proof))});`;
    await writeFile(script, source, { mode: 0o600 });
    config.scriptSha256 = createHash("sha256").update(source).digest("hex");
    return createLocalDeliveryGate({ ...config });
  }
  const proof = {
    status: "passed",
    commit: input.candidateSha,
    base: input.targetSha,
    signedReceipt: "synthetic-receipt",
  };
  await (
    await prepare(proof)
  )(input);
  await assert.rejects(
    () => prepare({ ...proof, base: "c".repeat(40) }).then((g) => g(input)),
    { code: "checks_pending" },
  );
  await assert.rejects(
    () => prepare({ ...proof, status: "failed" }).then((g) => g(input)),
    { code: "checks_failed" },
  );
  const gate = await prepare(proof);
  await writeFile(script, "process.stdout.write('forged')");
  await assert.rejects(() => gate(input), { code: "checks_failed" });
  await prepare(proof);
  await chmod(script, 0o666);
  await assert.rejects(() => createLocalDeliveryGate(config)(input), {
    code: "checks_failed",
  });
});
