import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { authPolicyHash, type AuthEnvironment } from "./authEnvironment.js";
import { ControlError, type GoalInput } from "./schema.js";

export const SUBSCRIPTION_GATES = [
  "login-restart",
  "refresh-expiry",
  "network-denial",
  "native-policy",
  "bounded-coding",
  "independent-check-review",
  "controller-lifecycle",
] as const;
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
/** A changed installed implementation invalidates its private acceptance receipt. */
export function subscriptionImplementationHash() {
  return hash(
    JSON.stringify(
      [
        "subscriptionQualification",
        "subscriptionBackend",
        "subscriptionNative",
        "authRuntime",
        "authEnvironment",
        "egressPolicy",
        "environments",
        "isolatedRuntime",
        "scheduler",
        "store",
        "api",
        "configuration",
        "../config",
        "../cli",
      ].map((name) => [
        name,
        hash(readFileSync(new URL(name + ".js", import.meta.url))),
      ]),
    ),
  );
}
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    authId: z.string(),
    providerId: z.string(),
    model: z.string(),
    imageDigest: z.string(),
    authenticationPolicyHash: z.string(),
    implementationHash: z.string(),
    platform: z.enum(["linux", "darwin"]),
    architecture: z.string(),
    expiresAt: z.string().datetime(),
    gates: z.array(
      z
        .object({
          id: z.enum(SUBSCRIPTION_GATES),
          passed: z.literal(true),
          evidenceFile: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}$/),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
  })
  .strict();
function privateRead(path: string, limit: number) {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    info.uid !== process.getuid?.() ||
    realpathSync(path) !== path ||
    info.size > limit
  )
    throw Error(
      "Qualification evidence must be bounded, private and canonical",
    );
  return readFileSync(path);
}
/** Local operator-reviewed proof; never a public config boolean or persisted authority flag. */
export function assertSubscriptionQualification(
  stateRoot: string,
  config: GoalInput,
  auth: AuthEnvironment,
  now = Date.now(),
) {
  try {
    const directory = join(
      stateRoot,
      "qualification",
      "subscriptions",
      auth.id,
    );
    const info = lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.() ||
      realpathSync(directory) !== directory
    )
      throw Error("Qualification directory must be private and canonical");
    const receipt = receiptSchema.parse(
      JSON.parse(
        privateRead(join(directory, "receipt.json"), 65536).toString("utf8"),
      ),
    );
    if (
      receipt.authId !== auth.id ||
      receipt.providerId !== config.admission?.providerId ||
      receipt.model !== config.backend?.model ||
      receipt.imageDigest !== auth.imageDigest ||
      config.admission?.executionImageDigest !== auth.imageDigest ||
      receipt.authenticationPolicyHash !== authPolicyHash(auth) ||
      config.admission?.authenticationPolicyHash !==
        receipt.authenticationPolicyHash ||
      receipt.implementationHash !== subscriptionImplementationHash() ||
      receipt.platform !== process.platform ||
      receipt.architecture !== process.arch ||
      Date.parse(receipt.expiresAt) <= now ||
      Date.parse(receipt.expiresAt) > now + 30 * 24 * 60 * 60 * 1000
    )
      throw Error("Qualification binding changed or expired");
    if (
      receipt.gates.length !== SUBSCRIPTION_GATES.length ||
      SUBSCRIPTION_GATES.some(
        (id) => receipt.gates.filter((g) => g.id === id).length !== 1,
      )
    )
      throw Error("Acceptance gates missing or duplicated");
    for (const gate of receipt.gates)
      if (
        hash(
          privateRead(join(directory, gate.evidenceFile), 4 * 1024 * 1024),
        ) !== gate.sha256
      )
        throw Error("Acceptance evidence changed");
  } catch {
    throw new ControlError(
      "subscription_unqualified",
      "Dedicated subscription acceptance is missing, expired or mismatched; complete private qualification before enabling admission",
      409,
    );
  }
}
