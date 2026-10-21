import { z } from "zod";
import { readSecret } from "../credentials.js";
import {
  abortable,
  ProviderFailure,
  failureRecord,
  invocationFence,
} from "./reliability.js";
import type { InferenceContext } from "./providers.js";
import { inferenceHttpFetch } from "./inferenceHttp.js";
export const vertexAuthSchema = z
  .object({
    kind: z.literal("google-adc"),
    egressHosts: z
      .array(
        z.enum([
          "oauth2.googleapis.com",
          "aiplatform.googleapis.com",
          "iamcredentials.googleapis.com",
        ]),
      )
      .min(2)
      .max(3),
    reference: z
      .object({ kind: z.literal("file"), path: z.string().min(1) })
      .strict(),
    impersonateServiceAccount: z
      .string()
      .regex(/^[a-zA-Z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/)
      .optional(),
  })
  .strict()
  .refine(
    (c) =>
      new Set(c.egressHosts).size === c.egressHosts.length &&
      c.egressHosts.includes("oauth2.googleapis.com") &&
      c.egressHosts.includes("aiplatform.googleapis.com") &&
      (!c.impersonateServiceAccount ||
        c.egressHosts.includes("iamcredentials.googleapis.com")),
    "Explicit Vertex authentication/inference egress required",
  );
const adcSchema = z
  .object({
    type: z.literal("authorized_user"),
    client_id: z.string().min(1).max(4096),
    client_secret: z.string().min(1).max(4096),
    refresh_token: z.string().min(1).max(16384),
    quota_project_id: z.string().min(1),
  })
  .passthrough();
export async function boundedJson(
  response: Response,
  signal: AbortSignal,
  limit = 65536,
  check: () => void = () => signal.throwIfAborted(),
): Promise<any> {
  if (!response.body) throw Error("Missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      check();
      const next = await abortable(reader.read(), signal);
      check();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw Error("Response exceeded bound");
      chunks.push(next.value);
    }
    check();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Only an explicit private ADC file is read. No SDK/CLI/ambient discovery. */
export function vertexAuthentication(
  config: z.output<typeof vertexAuthSchema>,
  secretsDir: string,
  quotaProject: string,
  register: (secret: string) => void,
  fetcher: typeof fetch = inferenceHttpFetch,
  clock: () => number = Date.now,
) {
  config = vertexAuthSchema.parse(config);
  let cached: { token: string; expiresAt: number } | undefined;
  return async (
    parent: AbortSignal,
    context: InferenceContext = {},
  ): Promise<Record<string, string>> => {
    const { signal, check } = invocationFence(
      parent,
      context.deadlineAt,
      context.assertAuthority,
    );
    check();
    try {
      if (!cached || cached.expiresAt <= clock() + 60000) {
        const raw = await abortable(
          readSecret(config.reference, secretsDir),
          signal,
        );
        if (Buffer.byteLength(raw) > 65536) throw Error("Invalid ADC");
        register(raw);
        const adc = adcSchema.parse(JSON.parse(raw));
        for (const secret of [
          adc.client_id,
          adc.client_secret,
          adc.refresh_token,
        ])
          register(secret);
        if (adc.quota_project_id !== quotaProject)
          throw Error("ADC quota project differs");
        check();
        const response = await abortable(
          fetcher("https://oauth2.googleapis.com/token", {
            method: "POST",
            redirect: "error",
            signal,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: adc.client_id,
              client_secret: adc.client_secret,
              refresh_token: adc.refresh_token,
            }),
          }),
          signal,
        );
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw Error("ADC refresh rejected");
        }
        const token = z
          .object({
            access_token: z.string().regex(/^[a-zA-Z0-9._~-]{1,16384}$/),
            expires_in: z.number().int().min(120).max(3600),
          })
          .parse(await boundedJson(response, signal, 65536, check));
        check();
        register(token.access_token);
        let value = {
          token: token.access_token,
          expiresAt: clock() + token.expires_in * 1000,
        };
        if (config.impersonateServiceAccount) {
          check();
          const result = await abortable(
            fetcher(
              `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.impersonateServiceAccount}:generateAccessToken`,
              {
                method: "POST",
                redirect: "error",
                signal,
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${value.token}`,
                  "x-goog-user-project": quotaProject,
                },
                body: JSON.stringify({
                  scope: ["https://www.googleapis.com/auth/cloud-platform"],
                  lifetime: "3600s",
                }),
              },
            ),
            signal,
          );
          if (!result.ok) {
            void result.body?.cancel().catch(() => {});
            throw Error("Impersonation rejected");
          }
          const impersonated = z
            .object({
              accessToken: z.string().regex(/^[a-zA-Z0-9._~-]{1,16384}$/),
              expireTime: z.string().datetime(),
            })
            .parse(await boundedJson(result, signal, 65536, check));
          check();
          register(impersonated.accessToken);
          value = {
            token: impersonated.accessToken,
            expiresAt: Date.parse(impersonated.expireTime),
          };
          if (
            value.expiresAt <= clock() + 60000 ||
            value.expiresAt > clock() + 3600000
          )
            throw Error("Invalid token lifetime");
        }
        check();
        cached = value;
      }
      check();
      return {
        Authorization: `Bearer ${cached.token}`,
        "x-goog-user-project": quotaProject,
      };
    } catch (error) {
      cached = undefined;
      check();
      if (
        error instanceof ProviderFailure &&
        ["deadline", "interrupted"].includes(error.failure.kind)
      )
        throw error;
      const failure = failureRecord("authentication");
      failure.message =
        "Vertex ADC refresh or impersonation failed; reauthenticate the dedicated controller ADC and verify quota project/IAM";
      throw new ProviderFailure(failure);
    }
  };
}
