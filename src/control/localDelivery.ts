import { executionSignal, executionDeadline } from "./executionDeadline.js";
import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { ControlError } from "./schema.js";

const absolute = z
  .string()
  .refine(isAbsolute, "An absolute host path is required");
export const localDeliveryVerifierSchema = z
  .object({
    command: absolute,
    script: absolute,
    scriptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    config: absolute,
    state: absolute,
    timeoutMs: z.number().int().min(1000).max(120000).default(60000),
  })
  .strict();

export interface LocalDeliveryInput {
  goalId: string;
  repoPath: string;
  workspace: string;
  candidateSha: string;
  targetSha: string;
  requiredChecks: string[];
}

// Only installation configuration chooses this host bridge. Goals and workers
// cannot supply an executable, shell command, receipt or signing key.
export function createLocalDeliveryGate(
  config: z.output<typeof localDeliveryVerifierSchema>,
) {
  return async (input: LocalDeliveryInput) => {
    const metadata = await lstat(config.script);
    if (
      !metadata.isFile() ||
      metadata.mode & 0o022 ||
      createHash("sha256")
        .update(await readFile(config.script))
        .digest("hex") !== config.scriptSha256
    )
      throw new ControlError(
        "checks_failed",
        "Trusted local verification bridge changed",
        409,
      );
    try {
      const result = await promisify(execFile)(
        config.command,
        [
          config.script,
          "--config",
          config.config,
          "--state",
          config.state,
          "--repo",
          input.repoPath,
          "--workspace",
          input.workspace,
          "--candidate",
          input.candidateSha,
          "--base",
          input.targetSha,
          "--checks-json",
          JSON.stringify(input.requiredChecks),
        ],
        {
          timeout: Math.max(
            1,
            Math.min(
              config.timeoutMs,
              (executionDeadline() ?? Date.now() + config.timeoutMs) -
                Date.now(),
            ),
          ),
          signal: executionSignal(),
          maxBuffer: 65536,
          cwd: "/",
          env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
        },
      );
      const proof = JSON.parse(result.stdout);
      if (
        !["passed", "failed"].includes(proof.status) ||
        proof.commit !== input.candidateSha ||
        proof.base !== input.targetSha ||
        !proof.signedReceipt
      )
        throw new Error("Bridge returned incomplete or stale evidence");
      if (proof.status === "failed")
        throw new ControlError(
          "checks_failed",
          "Owned local verification failed; inspect the signed receipt",
          409,
        );
    } catch (error) {
      if (error instanceof ControlError) throw error;
      throw new ControlError(
        "checks_pending",
        "Exact-source signed local verification is unavailable; inspect the owned verifier journal",
        409,
      );
    }
  };
}
