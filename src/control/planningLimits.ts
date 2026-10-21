// Controller-owned ceilings apply to planning and replanning, independently of
// the larger coding allowance. Native subscriptions can enforce the deadline,
// but their vendor runtime does not expose a controller request/output fence.
export const planningLimits = {
  timeoutMs: 120000,
  maxRequests: 4,
  maxOutputTokens: 8192,
} as const;

export const planningRecovery =
  "Planning did not produce a complete validated plan within its bounds. Inspect retained usage and source evidence, then submit a reviewed fixed plan through goal reviewed; do not replay or increase the failed request allowance.";
