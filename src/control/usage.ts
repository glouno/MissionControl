import { z } from "zod";

/** Absence of a measurement is never represented as zero. */
export const usageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("metered"),
      status: z.enum(["reported", "estimated", "unknown"]),
      costUsd: z.number().finite().nonnegative().optional(),
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      elapsedMs: z.number().finite().nonnegative().optional(),
    })
    .strict()
    .superRefine((u, context) => {
      if ((u.status === "unknown") !== (u.costUsd === undefined))
        context.addIssue({
          code: "custom",
          message:
            "Unknown billing omits cost; reported/estimated billing requires cost",
        });
    }),
  z
    .object({
      kind: z.literal("subscription"),
      status: z.enum(["reported", "unknown"]),
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      elapsedMs: z.number().finite().nonnegative().optional(),
    })
    .strict()
    .superRefine((u, context) => {
      if (
        u.status === "reported" &&
        u.inputTokens === undefined &&
        u.outputTokens === undefined
      )
        context.addIssue({
          code: "custom",
          message:
            "Reported subscription usage requires at least one reported token count",
        });
    }),
  z
    .object({
      kind: z.literal("synthetic"),
      elapsedMs: z.number().finite().nonnegative().optional(),
    })
    .strict(),
]);
export type Usage = z.output<typeof usageSchema>;
export const usageReconciliationSchema = z
  .object({
    costUsd: z.number().finite().nonnegative(),
    status: z.enum(["reported", "estimated"]),
    evidenceArtifactId: z.string().min(1).max(100),
    explanation: z.string().min(1).max(4000),
  })
  .strict();
export type UsageReconciliation = z.output<typeof usageReconciliationSchema>;
export function knownCost(usage?: Usage): number | undefined {
  if (usage?.kind === "synthetic") return 0;
  return usage?.kind === "metered" ? usage.costUsd : undefined;
}

export function backendUsage(
  result: {
    usage?: Usage;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
  },
  synthetic = false,
): Usage {
  if (result.usage) return usageSchema.parse(result.usage);
  if (synthetic && (!result.costUsd || result.costUsd === 0))
    return { kind: "synthetic" };
  return usageSchema.parse({
    kind: "metered",
    status: result.costUsd === undefined ? "unknown" : "estimated",
    costUsd: result.costUsd,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });
}

/** Settlement follows admitted usage policy; a result cannot change its billing mode. */
export function executionUsage(
  result: {
    usage?: Usage;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
  },
  config: {
    backend: { kind: string };
    executionContract?: { usagePolicy: { kind: string } };
  },
): Usage {
  const policy = config.executionContract?.usagePolicy.kind;
  if (policy === "subscription") {
    if (result.costUsd !== undefined)
      throw Error("Subscription execution cannot report dollar costs");
    if (result.usage) {
      const usage = usageSchema.parse(result.usage);
      if (usage.kind !== "subscription")
        throw Error(
          "Execution usage differs from admitted subscription policy",
        );
      return usage;
    }
    // Legacy native aggregate counters default to zero. Without explicit usage
    // evidence they cannot establish that tokens were measured/reported.
    return { kind: "subscription", status: "unknown" };
  }
  const usage = backendUsage(result, config.backend.kind === "fake");
  if (policy === "metered" && usage.kind !== "metered")
    throw Error("Execution usage differs from admitted metered policy");
  if (policy !== "subscription" && usage.kind === "subscription")
    throw Error("Subscription usage requires admitted subscription policy");
  return usage;
}
