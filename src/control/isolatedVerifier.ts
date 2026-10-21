import { deadlineSignal, boundedCleanup } from "./reliability.js";
import { randomUUID } from "node:crypto";
import type { Claim } from "./schema.js";
import { ControlError } from "./schema.js";
import { git } from "./git.js";
import { sanitizeGit, type ExecutionEnvironment } from "./environments.js";
import { prepareContractSnapshot } from "./contractSnapshots.js";
import { join } from "node:path";
export interface VerificationResult {
  passed: boolean;
  results: {
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }[];
  unchanged?: boolean;
  reason?: string;
  commit?: string;
  imageDigest?: string;
  verifierVersion?: string;
  executionSessionId?: string;
}
export class IsolatedVerifier {
  constructor(
    readonly environment: ExecutionEnvironment,
    readonly imageDigest: string,
  ) {}
  async verify(claim: Claim, source: string): Promise<VerificationResult> {
    if (!/^sha256:[a-f0-9]{64}$/.test(this.imageDigest))
      throw new ControlError(
        "environment_image",
        "Verification requires a pinned image digest",
        409,
      );
    const deadlineAt =
      claim.runtime?.deadlineAt ?? Date.now() + claim.goal.config.timeoutMs;
    const signal = deadlineSignal(deadlineAt);
    const inputs = claim.goal.config.siblingContracts ?? [];
    if (inputs.length && !this.environment.registry)
      throw new ControlError(
        "verification_contract",
        "Pinned verification contracts require an owned environment registry",
        409,
      );
    const contracts = inputs.length
      ? await prepareContractSnapshot(
          join(this.environment.registry!.root, "contract-snapshots"),
          inputs,
          signal,
        )
      : undefined;
    const commands = [
      ...new Set([
        ...claim.goal.config.verificationCommands,
        ...claim.task.spec.verificationCommands,
      ]),
    ];
    if (!commands.length)
      return {
        passed: false,
        results: [],
        reason: "At least one explicit verification command is required",
      };
    const commit = await git(source, ["rev-parse", "HEAD"]);
    if (await git(source, ["status", "--porcelain"]))
      throw new ControlError(
        "verification_base",
        "Verification requires checkpointed source",
        409,
      );
    const session = await this.environment.prepare(
      {
        taskId: claim.task.id,
        generation: Math.max(1, claim.generation),
        invocationId: `verify_${randomUUID().replaceAll("-", "")}`,
        source,
        baseSha: commit,
        goalId: claim.goal.id,
        workerId: claim.workerId,
        authorityGeneration: claim.generation,
        contractSnapshot: contracts
          ? { path: contracts.path, digest: contracts.digest }
          : undefined,
        image: this.imageDigest,
        cpu: Math.max(
          claim.task.spec.cpuUnits,
          claim.goal.config.executionResources?.cpuUnits ?? 1,
        ),
        memoryMiB: Math.max(
          claim.task.spec.memoryMiB,
          claim.goal.config.executionResources?.memoryMiB ?? 128,
        ),
        timeoutMs: claim.goal.config.timeoutMs,
      },
      signal,
    );
    const results: VerificationResult["results"] = [];
    try {
      for (const command of commands) {
        // Wrapper records ordinary non-zero check outcomes without accepting broken
        // Docker/session infrastructure as a completed verification result.
        const code = `import subprocess,json\np=subprocess.run(${JSON.stringify(command)},shell=True,executable='/bin/sh',capture_output=True,text=True)\nprint(json.dumps({'exitCode':p.returncode,'stdout':p.stdout[-20000:],'stderr':p.stderr[-20000:]}))`;
        const output = await this.environment.execute(
          session.id,
          ["python3", "-c", code],
          signal,
        );
        const parsed = JSON.parse(output.stdout);
        if (
          !Number.isInteger(parsed.exitCode) ||
          typeof parsed.stdout !== "string" ||
          typeof parsed.stderr !== "string"
        )
          throw new ControlError(
            "verification_protocol",
            "Invalid isolated check output",
            409,
          );
        results.push({ command, ...parsed });
      }
      await this.environment.checkpoint(session.id, signal);
      await sanitizeGit(session.path);
      const unchanged =
        (await git(session.path, ["rev-parse", "HEAD"])) === commit &&
        (await git(session.path, ["status", "--porcelain"])) === "" &&
        (await git(source, ["rev-parse", "HEAD"])) === commit &&
        (await git(source, ["status", "--porcelain"])) === "";
      const result = {
        passed: unchanged && results.every((r) => r.exitCode === 0),
        results,
        unchanged,
        commit,
        imageDigest: this.imageDigest,
        verifierVersion: "private-source-v1",
        executionSessionId: session.id,
      };
      const registry = this.environment.registry;
      if (registry)
        registry.save({
          ...registry.get(session.id),
          completion: {
            outcome: result.passed ? "verified" : "failed",
            commit,
            recordedAt: Date.now(),
            evidence: result,
          },
        });
      return result;
    } finally {
      await boundedCleanup((signal) =>
        this.environment.reset(session.id, signal),
      );
    }
  }
}
