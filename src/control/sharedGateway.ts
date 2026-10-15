import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import type { TrustedUpstream } from "./inferenceGateway.js";

/** Controller-only signer; neither token source nor signing key enters a worker. */
export function sharedGatewayUpstream(config: {
  endpoint: string;
  issuer: string;
  signerKid: string;
  signerKey: KeyObject | string;
  actorId: string;
  workloadToken: () => Promise<string>;
}): TrustedUpstream {
  const url = new URL(config.endpoint);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/v1/responses" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Shared gateway requires a fixed HTTPS Responses endpoint");
  const key =
    typeof config.signerKey === "string"
      ? createPrivateKey(config.signerKey)
      : config.signerKey;
  if (key.asymmetricKeyType !== "rsa")
    throw new Error("Gateway signer must use RSA");
  return {
    protocol: "responses",
    endpoint: config.endpoint,
    headers: async () => ({}),
    requestHeaders: async ({ body, capability }) => {
      const { createHash } = await import("node:crypto");
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        v: 2,
        iss: config.issuer,
        aud: "ai-gateway",
        iat: now,
        exp: now + 300,
        product: "coding-internal",
        actor_kind: "service",
        actor_id: config.actorId,
        tenant_id: null,
        project_id: null,
        operation_id: capability.sessionId,
        purpose: "mission-control",
        membership_role: null,
        all_users: false,
        method: "POST",
        path: "/v1/responses",
        body_sha256: createHash("sha256").update(body).digest("hex"),
      };
      const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned =
        encode({ alg: "RS256", typ: "JWT", kid: config.signerKid }) +
        "." +
        encode(payload);
      const signer = createSign("RSA-SHA256");
      signer.update(unsigned);
      const signed = unsigned + "." + signer.sign(key).toString("base64url");
      return {
        authorization: "Bearer " + (await config.workloadToken()),
        "x-ai-usage-context": signed,
      };
    },
  };
}
