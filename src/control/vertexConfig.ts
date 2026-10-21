import { z } from "zod";
const project = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
export const vertexPricingSchema = z
  .object({
    version: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/),
    currency: z.literal("USD"),
    effectiveFrom: z.string().datetime(),
    effectiveUntil: z.string().datetime(),
    inputUsdPerMillion: z.number().positive(),
    cachedInputUsdPerMillion: z.number().nonnegative(),
    outputUsdPerMillion: z.number().positive(),
    thinkingUsdPerMillion: z.number().positive(),
    evidenceUrl: z.string().url(),
  })
  .strict()
  .refine(
    (p) => Date.parse(p.effectiveUntil) > Date.parse(p.effectiveFrom),
    "Invalid pricing interval",
  );
export const vertexBackendSchema = z
  .object({
    kind: z.literal("vertex"),
    project,
    quotaProject: project,
    location: z.literal("global"),
    model: z.literal("gemini-4-argon"),
    stream: z.boolean().default(true),
    thinkingLevel: z.enum(["low", "medium", "high"]),
    maxInputTokens: z.number().int().min(4096).max(1000000),
    // Vertex's generation limit includes visible output and thinking.
    maxOutputTokens: z.number().int().min(64).max(65536),
    maxRequestCostUsd: z.number().positive(),
    pricing: z.array(vertexPricingSchema).min(1).max(24),
  })
  .strict()
  .superRefine((c, ctx) => {
    const prices = [...c.pricing].sort(
      (a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom),
    );
    if (
      new Set(prices.map((p) => p.version)).size !== prices.length ||
      prices.some(
        (p, i) =>
          i > 0 &&
          Date.parse(p.effectiveFrom) <
            Date.parse(prices[i - 1]!.effectiveUntil),
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Pricing versions must be unique and intervals must not overlap",
      });
  });
export type VertexConfig = z.output<typeof vertexBackendSchema>;
export function vertexEndpoint(c: VertexConfig) {
  return `https://aiplatform.googleapis.com/v1beta1/projects/${c.project}/locations/${c.location}/publishers/google/models/${c.model}:${c.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
}
