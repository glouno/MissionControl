import { createHash } from "node:crypto";
import { z } from "zod";
import type { BackendConfig } from "./schema.js";
export const executionContractSchema = z
  .object({
    harness: z.enum(["fake", "tool-loop", "codex", "claude-code"]),
    provider: z.enum([
      "fake",
      "azure",
      "bedrock",
      "vertex",
      "codex-subscription",
      "claude-subscription",
    ]),
    authentication: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z
        .object({ kind: z.literal("local"), reference: z.string().min(1) })
        .strict(),
      z
        .object({ kind: z.literal("controller"), reference: z.string().min(1) })
        .strict(),
      z
        .object({ kind: z.literal("session"), reference: z.string().min(1) })
        .strict(),
    ]),
    execution: z.enum(["fake", "isolated", "native"]),
    usagePolicy: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("synthetic") }).strict(),
      z.object({ kind: z.literal("observed") }).strict(),
      z
        .object({
          kind: z.literal("metered"),
          maxCostUsd: z.number().positive(),
          estimatePerRunUsd: z.number().positive(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("subscription"),
          maxAttempts: z.number().int().min(1).max(10),
          timeoutMs: z.number().int().min(1000).max(3600000),
          maxConcurrency: z.literal(1),
          maxReportedTokens: z.number().int().positive().optional(),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (c.execution === "native") {
      if (
        c.harness !== "codex" ||
        c.provider !== "codex-subscription" ||
        c.authentication.kind !== "local" ||
        c.usagePolicy.kind !== "observed"
      )
        issue(
          "Native execution requires Codex, local subscription authentication and observed usage",
        );
      return;
    }
    if (c.usagePolicy.kind === "observed" || c.authentication.kind === "local")
      issue("Local authentication and observed usage require native execution");
    if (c.provider === "fake") {
      if (
        c.harness !== "fake" ||
        c.execution !== "fake" ||
        c.authentication.kind !== "none" ||
        c.usagePolicy.kind !== "synthetic"
      )
        issue(
          "Synthetic provider requires synthetic harness, execution and usage without authentication",
        );
    } else {
      if (c.execution !== "isolated")
        issue("Real providers require isolated execution");
      if (c.provider.endsWith("subscription")) {
        const harness =
          c.provider === "codex-subscription" ? "codex" : "claude-code";
        if (
          c.harness !== harness ||
          c.authentication.kind !== "session" ||
          c.usagePolicy.kind !== "subscription"
        )
          issue(
            "Subscription requires matching native harness, dedicated session and subscription limits",
          );
      } else if (
        c.authentication.kind !== "controller" ||
        c.usagePolicy.kind !== "metered" ||
        !(["tool-loop", "codex", "claude-code"] as string[]).includes(c.harness)
      )
        issue(
          "Metered provider requires controller authentication, approved harness and dollar limits",
        );
      if (
        ["bedrock", "vertex"].includes(c.provider) &&
        c.harness !== "tool-loop"
      )
        issue(
          c.provider === "bedrock"
            ? "Native Bedrock execution is unsupported; select the Bedrock tool-loop harness"
            : "Vertex requires the controller tool-loop harness",
        );
    }
  });
export type ExecutionContract = z.output<typeof executionContractSchema>;
export function validateBackendContract(
  backend: BackendConfig,
  contract: ExecutionContract,
) {
  const c = executionContractSchema.parse(contract);
  const harness =
    backend.kind === "azure" ||
    backend.kind === "bedrock" ||
    backend.kind === "vertex"
      ? "tool-loop"
      : backend.kind;
  if (c.harness !== harness)
    throw Error("Configured backend and execution harness differ");
  if (harness === "tool-loop" && c.provider !== backend.kind)
    throw Error("Tool-loop provider differs from backend");
  if (backend.kind === "claude-code" && backend.foundry)
    throw Error(
      "Native provider settings belong to the controller runtime; remove backend.foundry",
    );
  return c;
}
export function validateExecutionLimits(input: {
  backend: BackendConfig;
  executionContract?: ExecutionContract;
  maxCostUsd: number;
  estimatePerRunUsd: number;
  maxAttempts: number;
  timeoutMs: number;
  maxWorkers: number;
}) {
  if (!input.executionContract) {
    if (input.backend.kind !== "fake")
      throw Error("Real execution requires an explicit executionContract");
    return;
  }
  const contract = validateBackendContract(
    input.backend,
    input.executionContract,
  );
  const policy = contract.usagePolicy;
  if (
    policy.kind === "metered" &&
    (input.maxCostUsd <= 0 ||
      input.estimatePerRunUsd <= 0 ||
      input.maxCostUsd > policy.maxCostUsd ||
      input.estimatePerRunUsd > policy.estimatePerRunUsd)
  )
    throw Error(
      "Goal dollar limits exceed provider usage policy or lack a positive reservation",
    );
  if (
    policy.kind === "observed" &&
    (input.maxCostUsd !== 0 || input.estimatePerRunUsd !== 0)
  )
    throw Error("Observed subscription execution cannot reserve dollars");
  if (policy.kind === "subscription") {
    if (input.maxCostUsd !== 0 || input.estimatePerRunUsd !== 0)
      throw Error(
        "Subscription limits cannot contain dollar budgets or reservations",
      );
    if (
      input.maxAttempts > policy.maxAttempts ||
      input.timeoutMs > policy.timeoutMs ||
      input.maxWorkers > policy.maxConcurrency
    )
      throw Error(
        "Goal attempt, time or concurrency limits exceed subscription usage policy",
      );
  }
}
export function contractHash(contract: ExecutionContract) {
  return createHash("sha256")
    .update(JSON.stringify(executionContractSchema.parse(contract)))
    .digest("hex");
}
