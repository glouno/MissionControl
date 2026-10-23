import { z } from "zod";
import { backendSchema } from "./schema.js";
import { secretReferenceSchema } from "../credentials.js";
import { vertexAuthSchema } from "./vertexAuth.js";
export const isolatedRuntimeSchema = z
  .object({
    environmentImagesRoot: z.string().startsWith("/").optional(),
    // Shared images require a complete operator-declared inventory of every
    // retained sandbox registry before destructive maintenance can be enabled.
    environmentExecutionRoots: z.array(z.string().startsWith("/")).optional(),
    projects: z.record(
      z.string(),
      z
        .object({ imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
        .strict(),
    ),
    providers: z.record(
      z.string(),
      z.discriminatedUnion("protocol", [
        z
          .object({
            protocol: z.literal("subscription"),
            harness: z.enum(["codex", "claude-code"]),
            model: z.string().min(1),
            authentication: z
              .object({
                kind: z.literal("session"),
                reference: z.string().min(1),
              })
              .strict(),
          })
          .strict(),
        z
          .object({
            protocol: z.enum(["responses", "messages"]),
            endpoint: z.string().url(),
            model: z.string().min(1),
            authentication: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("azure-cli") }).strict(),
              z
                .object({
                  kind: z.literal("secret"),
                  reference: secretReferenceSchema,
                  header: z.enum(["api-key", "x-api-key", "Authorization"]),
                  bearer: z.boolean().default(false),
                })
                .strict(),
            ]),
            allowedBetaHeaders: z.array(z.string()).default([]),
            maxOutputTokens: z
              .number()
              .int()
              .min(64)
              .max(131072)
              .default(32768),
            pricing: z
              .object({
                inputUsdPerMillion: z.number().positive(),
                cachedInputUsdPerMillion: z.number().nonnegative(),
                outputUsdPerMillion: z.number().positive(),
                evidenceUrl: z.string().url(),
              })
              .strict()
              .optional(),
          })
          .strict(),
        z
          .object({
            protocol: z.literal("tool-loop"),
            backend: backendSchema.refine(
              (b) =>
                b.kind === "azure" ||
                b.kind === "bedrock" ||
                b.kind === "vertex",
              "Tool loop requires Azure, Bedrock or Vertex",
            ),
            authentication: z.discriminatedUnion("kind", [
              vertexAuthSchema,
              z.object({ kind: z.literal("azure-cli") }).strict(),
              z
                .object({
                  kind: z.literal("secret"),
                  reference: secretReferenceSchema,
                })
                .strict(),
              z
                .object({
                  kind: z.literal("aws-session"),
                  accessKey: secretReferenceSchema,
                  secretKey: secretReferenceSchema,
                  sessionToken: secretReferenceSchema,
                })
                .strict(),
            ]),
          })
          .strict(),
      ]),
    ),
  })
  .strict();
export type IsolatedRuntimeConfig = z.output<typeof isolatedRuntimeSchema>;
