import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { sharedGatewayUpstream } from "./sharedGateway.js";

test("controller signs exact body and fixed internal actor without worker credentials", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  let refreshed = 0;
  const upstream = sharedGatewayUpstream({
    endpoint: "https://gateway.example/v1/responses",
    issuer: "mission-control",
    signerKid: "controller-v1",
    signerKey: privateKey,
    actorId: "paul-automation",
    workloadToken: async () => {
      refreshed++;
      return "synthetic";
    },
  });
  const capability = {
    sessionId: "session",
    goalId: "goal",
    taskId: "task",
    generation: 1,
    provider: "azure",
    protocol: "responses" as const,
    model: "approved",
    expiresAt: Date.now() + 1000,
  };
  const body = JSON.stringify({
    model: "approved",
    input: "synthetic",
    store: false,
  });
  const headers = await upstream.requestHeaders!({ body, capability });
  const parts = headers["x-ai-usage-context"]!.split(".");
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  assert.equal(
    claims.body_sha256,
    createHash("sha256").update(body).digest("hex"),
  );
  assert.equal(claims.product, "coding-internal");
  assert.equal(claims.actor_kind, "service");
  assert.equal(claims.operation_id, "session");
  assert.equal(claims.exp - claims.iat, 300);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(parts[0] + "." + parts[1]);
  assert.ok(verifier.verify(publicKey, Buffer.from(parts[2]!, "base64url")));
  await upstream.requestHeaders!({ body, capability });
  assert.equal(refreshed, 2);
});
