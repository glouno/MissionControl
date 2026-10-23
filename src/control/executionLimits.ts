import type { GoalConfig } from "./schema.js";
import { planningLimits } from "./planningLimits.js";

/** Read-only projection of configured limits; it never grants execution authority. */
export function executionLimits(config: GoalConfig, snapshot?: any) {
  const kind = config.backend.kind;
  const nativePaid =
    config.executionContract?.execution !== "native" &&
    ["codex", "claude-code"].includes(kind) &&
    config.executionContract?.usagePolicy.kind !== "subscription";
  const provider = snapshot?.hosts?.find(
    (h: any) =>
      h.isolatedRuntime?.providers?.[config.admission?.providerId ?? ""],
  )?.isolatedRuntime?.providers?.[config.admission?.providerId ?? ""];
  const configuredOutput =
    "maxOutputTokens" in config.backend
      ? (config.backend.maxOutputTokens ?? 65536)
      : kind === "claude-code"
        ? 32768
        : kind === "bedrock"
          ? 8192
          : null;
  const output = nativePaid
    ? provider?.maxOutputTokens === undefined
      ? null
      : Math.min(configuredOutput ?? 32768, provider.maxOutputTokens)
    : config.executionContract?.execution === "native" ||
        kind === "fake" ||
        config.executionContract?.usagePolicy.kind === "subscription"
      ? null
      : configuredOutput;
  return {
    environment:
      config.executionContract?.execution === "isolated"
        ? "container sandbox"
        : (config.executionContract?.execution ?? "fake"),
    resourceEnforcement:
      config.executionContract?.execution === "native"
        ? "scheduler accounting only"
        : "container limits",
    harness:
      config.executionContract?.execution === "native"
        ? "Codex exec (native devbox)"
        : kind === "fake"
          ? "Synthetic"
          : kind === "codex"
            ? "Codex app-server"
            : kind === "claude-code"
              ? "Claude Code"
              : "MissionControl portable tool loop",
    usagePolicy:
      config.executionContract?.usagePolicy.kind ??
      (kind === "fake" ? "synthetic" : "metered"),
    goalCostCeilingUsd: config.maxCostUsd,
    runReservationUsd: config.estimatePerRunUsd,
    timeoutMs: config.timeoutMs,
    planning:
      config.executionContract?.execution === "native"
        ? { timeoutMs: planningLimits(config).timeoutMs, maxRequests: null }
        : planningLimits(config),
    outputTokensPerRequest: output,
    outputLimitMeaning:
      output === null
        ? "Not established by this projection; inspect native policy or provider readiness"
        : "Includes reasoning where the provider counts it; reaching the cap may truncate output. Native gateway uses the currently applied deployment limit",
    planningRequestMeaning:
      config.executionContract?.execution === "native"
        ? "Underlying requests are not fenced or counted by this adapter; inspect observed invocation metrics"
        : kind === "fake"
          ? "No inference"
          : config.executionContract?.usagePolicy.kind === "subscription"
            ? "Vendor runtime controls requests; controller planning request fence unavailable"
            : nativePaid
              ? "Gateway attempts including retries and locally refused attempts"
              : "Portable model turns; provider retries are bounded separately",
    maxWorkers: config.maxWorkers,
    executionResources: config.executionResources ?? null,
    maxAttempts: config.maxAttempts,
    maxReplans: config.maxReplans,
    noProgressWarningMs: config.noProgressWarningMs,
    noProgressTimeoutMs: config.noProgressTimeoutMs,
    nativeMaxTurns: kind === "claude-code" ? config.backend.maxTurns : null,
    subscriptionInvocationLimit:
      config.executionContract?.usagePolicy.kind === "subscription"
        ? config.executionContract.usagePolicy.maxAttempts
        : null,
    subscriptionReportedTokenLimit:
      config.executionContract?.usagePolicy.kind === "subscription"
        ? (config.executionContract.usagePolicy.maxReportedTokens ?? null)
        : null,
    accountingMeaning: ["azure", "bedrock"].includes(kind)
      ? "Portable provider estimates do not fully model cache read/write pricing"
      : "Provider usage and configured rates produce estimates; cache-write pricing may require separate reconciliation",
    deploymentLimitSource:
      "Native gateway limit uses the currently applied installation snapshot",
    publication: config.policy.publish,
    autoMerge: config.policy.autoMerge,
  };
}
