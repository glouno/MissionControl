import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../sqlite.js";
import { InferenceGateway } from "./inferenceGateway.js";
async function fixture(
  t: any,
  protocol: "responses" | "messages" = "responses",
) {
  const root = await mkdtemp(join(tmpdir(), "mc-gateway-"));
  const db = new SqliteStore(join(root, "state.db"));
  const calls: any[] = [];
  const upstream =
    protocol === "responses"
      ? 'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":4}}}\n\n'
      : 'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\ndata: {"type":"message_stop"}\n\n';
  const gateway = new InferenceGateway(
    db,
    {
      azure: {
        protocol,
        endpoint: "https://fixed.example/inference",
        headers: async () => ({ Authorization: "Bearer trusted-secret" }),
      },
    },
    (c) => {
      if (c.generation !== 1) throw new Error("stale lease");
    },
    async (url, options) => {
      calls.push({ url, options });
      return new Response(upstream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  const server = gateway.server();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    await rm(root, { recursive: true });
  });
  const cap = {
    sessionId: "session",
    goalId: "goal",
    taskId: "task",
    generation: 1,
    provider: "azure",
    protocol,
    model: protocol === "responses" ? "gpt-6.1-sol" : "claude-opus-5-5",
    expiresAt: Date.now() + 60000,
  };
  const token = gateway.issue(cap),
    url = `http://127.0.0.1:${(server.address() as any).port}/v1/${protocol}`;
  return { db, gateway, calls, token, url, cap, upstream };
}
test("gateway pins upstream/model, strips worker credentials and preserves streamed Responses usage", async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${f.token}`,
      "content-type": "application/json",
      "api-key": "worker-secret",
    },
    body: JSON.stringify({
      model: f.cap.model,
      input: "hello",
      stream: true,
      tools: [
        {
          type: "function",
          name: "local_tool",
          parameters: { type: "object" },
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), f.upstream);
  assert.equal(f.calls[0].url, "https://fixed.example/inference");
  assert.equal(
    f.calls[0].options.headers.Authorization,
    "Bearer trusted-secret",
  );
  assert.equal(f.calls[0].options.headers["api-key"], undefined);
  const record = JSON.parse(
    f.db.one<{ record: string }>("SELECT record FROM inference_usage")!.record,
  );
  assert.equal(record.usage.input_tokens, 12);
  assert.equal(record.costUsd, null);
  assert.equal(record.taskId, "task");
  f.gateway.revoke("session");
  assert.equal(
    (
      await fetch(f.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.token}` },
        body: "{}",
      })
    ).status,
    401,
  );
});
test("unsupported routes, server tools, model changes and expired capabilities never reach provider", async (t) => {
  const f = await fixture(t);
  for (const body of [
    { model: f.cap.model, max_output_tokens: 32769 },
    { model: f.cap.model, max_output_tokens: -1 },
    { model: f.cap.model, max_output_tokens: "1024" },
    { model: "other" },
    { model: f.cap.model, tools: [{ type: "web_search" }] },
    { model: f.cap.model, previous_response_id: "other-session" },
  ]) {
    const response = await fetch(f.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.token}` },
      body: JSON.stringify(body),
    });
    assert.ok(response.status >= 400);
  }
  assert.equal(f.calls.length, 0);
  assert.throws(
    () => f.gateway.issue({ ...f.cap, expiresAt: Date.now() - 1 }),
    /Invalid/,
  );
  assert.throws(
    () => f.gateway.issue({ ...f.cap, generation: 2 }),
    /stale lease/,
  );
});
test("Foundry Messages streaming preserves local tools and records honest usage", async (t) => {
  const f = await fixture(t, "messages");
  const response = await fetch(f.url, {
    method: "POST",
    headers: { "x-api-key": f.token },
    body: JSON.stringify({
      model: f.cap.model,
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "shell", input_schema: { type: "object" } }],
      stream: true,
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), f.upstream);
  const record = JSON.parse(
    f.db.one<{ record: string }>("SELECT record FROM inference_usage")!.record,
  );
  assert.deepEqual(record.usage, { input_tokens: 12, output_tokens: 4 });
  assert.equal(record.complete, true);
  assert.equal(record.costUsd, null);
  assert.equal(f.calls[0].options.headers["anthropic-version"], "2023-06-01");
});
test("Messages beta forwarding requires explicit per-upstream allowlist", async (t) => {
  const f = await fixture(t, "messages");
  f.gateway.upstreams.azure.allowedBetaHeaders = ["claude-code-20250219"];
  const request = (beta: string) =>
    fetch(f.url, {
      method: "POST",
      headers: { "x-api-key": f.token, "anthropic-beta": beta },
      body: JSON.stringify({
        model: f.cap.model,
        max_tokens: 64,
        messages: [],
        stream: true,
      }),
    });
  const accepted = await request("claude-code-20250219");
  assert.equal(accepted.status, 200);
  await accepted.text();
  assert.equal(
    f.calls[0].options.headers["anthropic-beta"],
    "claude-code-20250219",
  );
  assert.equal((await request("unknown-beta")).status, 400);
  assert.equal(f.calls.length, 1);
});
test("revocation aborts an in-flight provider request without waiting for another stream chunk", async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  const pending = new Promise<void>((r) => {
    entered = r;
  });
  let upstreamAborted = false;
  const gateway = new InferenceGateway(
    f.db,
    f.gateway.upstreams,
    () => {},
    async (_url, options) => {
      entered();
      return await new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener(
          "abort",
          () => {
            upstreamAborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    },
  );
  const server = gateway.server();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  const token = gateway.issue({ ...f.cap, sessionId: "inflight" });
  const response = fetch(
    `http://127.0.0.1:${(server.address() as any).port}/v1/responses`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: f.cap.model }),
      signal: AbortSignal.timeout(2000),
    },
  );
  await pending;
  gateway.revoke("inflight");
  assert.equal((await response).status, 502);
  assert.equal(upstreamAborted, true);
});
