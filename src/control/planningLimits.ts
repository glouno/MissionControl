import type { GoalConfig } from "./schema.js";

// Planning inherits the admitted runtime and provider output allowance unless
// the operator configures a shorter planning deadline or request allowance.
export function planningLimits(
  config: Pick<GoalConfig, "timeoutMs" | "planning">,
) {
  return {
    timeoutMs: Math.min(
      config.timeoutMs,
      config.planning?.timeoutMs ?? config.timeoutMs,
    ),
    maxRequests: config.planning?.maxRequests ?? 40,
  };
}

export const planningRecovery =
  "Planning did not produce a complete validated plan within its admitted bounds. Inspect retained usage and source evidence, then submit a reviewed fixed plan through goal reviewed or authorize a revised admission; do not replay failed requests or release unknown usage.";
