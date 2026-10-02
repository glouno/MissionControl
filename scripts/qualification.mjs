import { readFile, lstat, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

export const PREVIEW_GATES = [
  "core-state",
  "task-ownership-recovery",
  "external-configuration",
  "agent-api-cli",
  "azure-responses",
  "azure-messages",
  "dashboard",
  "linux-install",
  "local-encrypted-restore",
  "publication-privacy",
  "dependency-notices",
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const validHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function qualificationFingerprints(commit, files, npmLock, rustLock) {
  return {
    sourceCommit: commit,
    sourceInventorySha256: sha(JSON.stringify(files)),
    npmLockSha256: sha(npmLock),
    rustLockSha256: sha(rustLock),
    runtimeInventorySha256: sha(
      JSON.stringify(
        files.filter((f) =>
          /^(?:src\/|profiles\/|environments\/worker\/|package(?:-lock)?\.json$|tsconfig\.json$)/.test(
            f.path,
          ),
        ),
      ),
    ),
  };
}
export async function loadQualification(
  file,
  fingerprints,
  applicationSchemaVersion = 6,
) {
  if (!file)
    return {
      schemaVersion: 1,
      scope: "linux-wsl-preview",
      qualified: false,
      mandatoryGates: PREVIEW_GATES,
      passedGates: [],
      pendingGates: PREVIEW_GATES,
      optionalFeaturesQualified: false,
    };
  const path = resolve(file),
    info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    info.size > 1024 * 1024
  )
    throw Error("Qualification receipt is not a bounded canonical file");
  const bytes = await readFile(path),
    receipt = JSON.parse(bytes.toString("utf8"));
  if (
    receipt.schemaVersion !== 1 ||
    receipt.scope !== "linux-wsl-preview" ||
    !Array.isArray(receipt.gates) ||
    receipt.gates.length !== PREVIEW_GATES.length ||
    receipt.applicationSchemaVersion !== applicationSchemaVersion ||
    receipt.configSchemaVersion !== 1
  )
    throw Error("Unsupported preview qualification receipt");
  for (const [key, value] of Object.entries(fingerprints))
    if (receipt[key] !== value)
      throw Error("Qualification source fingerprints differ");
  const passed = [],
    evidence = [];
  for (const id of PREVIEW_GATES) {
    const matches = receipt.gates.filter((g) => g.id === id);
    if (matches.length !== 1)
      throw Error("Qualification gates are missing or duplicated");
    const gate = matches[0];
    if (
      !["passed", "pending", "failed"].includes(gate.status) ||
      !Array.isArray(gate.evidence)
    )
      throw Error("Invalid qualification gate");
    if (gate.status !== "passed") continue;
    if (gate.sourceCommit !== receipt.sourceCommit) {
      const equivalence = gate.sourceEquivalence;
      if (
        !/^[a-f0-9]{40}$/.test(gate.sourceCommit ?? "") ||
        !equivalence ||
        equivalence.reviewed !== true ||
        !validHash(equivalence.reviewSha256) ||
        !gate.evidence.some((item) => item.sha256 === equivalence.reviewSha256) ||
        equivalence.fromSourceCommit !== gate.sourceCommit ||
        equivalence.toSourceCommit !== receipt.sourceCommit ||
        equivalence.runtimeInventorySha256 !== receipt.runtimeInventorySha256 ||
        !validHash(equivalence.runtimeInventorySha256) ||
        !Array.isArray(equivalence.changes) ||
        equivalence.changes.some(
          (path) =>
            typeof path !== "string" ||
            /^(?:src\/|profiles\/|environments\/worker\/|package(?:-lock)?\.json$|tsconfig\.json$)/.test(
              path,
            ),
        )
      )
        throw Error(
          "Qualification proof source revision differs without reviewed runtime equivalence",
        );
    }
    if (
      !gate.evidence.length ||
      !validHash(gate.configurationSha256) ||
      !gate.platform ||
      !validHash(gate.platform.fingerprintSha256) ||
      gate.platform.os !== "linux" ||
      typeof gate.procedure !== "string" ||
      !gate.procedure.trim()
    )
      throw Error("Passed qualification gate lacks exact proof fingerprints");
    if (
      ["azure-responses", "azure-messages", "task-ownership-recovery"].includes(
        id,
      ) &&
      !/^sha256:[a-f0-9]{64}$/.test(gate.imageDigest ?? "")
    )
      throw Error("Execution qualification lacks an immutable image");
    for (const item of gate.evidence) {
      if (
        typeof item.file !== "string" ||
        !validHash(item.sha256) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 1 ||
        item.bytes > 16 * 1024 * 1024
      )
        throw Error("Invalid qualification evidence");
      const target = resolve(dirname(path), item.file),
        meta = await lstat(target);
      if (
        !meta.isFile() ||
        meta.isSymbolicLink() ||
        (await realpath(target)) !== target ||
        meta.size !== item.bytes
      )
        throw Error("Qualification evidence is missing or redirected");
      const data = await readFile(target);
      if (sha(data) !== item.sha256)
        throw Error("Qualification evidence changed");
      evidence.push({ gate: id, sha256: item.sha256 });
    }
    passed.push(id);
  }
  const pending = PREVIEW_GATES.filter((id) => !passed.includes(id));
  return {
    schemaVersion: 1,
    scope: receipt.scope,
    qualified: pending.length === 0,
    mandatoryGates: PREVIEW_GATES,
    passedGates: passed,
    pendingGates: pending,
    receiptSha256: sha(bytes),
    evidence,
    optionalFeaturesQualified: false,
  };
}
