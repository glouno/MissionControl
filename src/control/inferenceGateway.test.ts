import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, sql } from "../sqlite.js";
import { InferenceGateway } from "./inferenceGateway.js";
import { ReliabilityStore } from "./reliability.js";
async function fixture(
  t: any,
  protocol: "responses" | "messages" = "responses",
  stream?: string,
  rejection?: number,
) {
  const root = await mkdtemp(join(tmpdir(), "mc-gateway-"));
  const db = new SqliteStore(join(root, "state.db"));
  const calls: any[] = [];
  const upstream =
    stream ??
    (protocol === "responses"
      ? 'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":4}}}\n\n'
      : 'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\ndata: {"type":"message_stop"}\n\n');
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
      return new Response(
        rejection
          ? JSON.stringify({
              error: {
                code:
                  rejection === 429
                    ? "rate_limit_exceeded"
                    : "ResponsibleAIPolicyViolation",
              },
            })
          : upstream,
        {
          status: rejection ?? 200,
          headers: rejection
            ? { "content-type": "application/json", "retry-after": "120" }
            : { "content-type": "text/event-stream" },
        },
      );
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
test("native gateway persists three-retry authority and Retry-After across restart", async (t) => {
  const f = await fixture(t, "responses", undefined, 429);
  f.db.exec(
    "CREATE TABLE control_goals(id TEXT PRIMARY KEY); INSERT INTO control_goals VALUES('goal'); CREATE TABLE control_attempts(id TEXT PRIMARY KEY, execution_session_id TEXT,outcome TEXT); INSERT INTO control_attempts VALUES('attempt','session','active');",
  );
  const reliability = new ReliabilityStore(f.db);
  reliability.start("attempt", 1000000, "implement");
  const send = async (url = f.url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.token}` },
      body: JSON.stringify({ model: f.cap.model }),
    });
    await response.text();
    return response.status;
  };
  assert.equal(await send(), 429);
  const first = reliability.runtime("attempt")!;
  assert.equal(first.retryCount, 0);
  assert.equal(first.failure?.retryAfterMs, 120000);
  assert.ok(first.nextRetryAt! >= Date.now() + 119000);
  // Recreate the gateway over persisted state; advancing the saved admission
  // instant avoids real backoff delays while exercising the authoritative gate.
  const restarted = new InferenceGateway(
    f.db,
    f.gateway.upstreams,
    () => {},
    f.gateway.fetcher,
  );
  const server = restarted.server();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1/responses`;
  for (let i = 0; i < 3; i++) {
    const runtime = reliability.runtime("attempt")!;
    runtime.nextRetryAt = Date.now() - 1;
    reliability.saveRuntime(runtime);
    assert.equal(await send(url), 429);
  }
  assert.equal(await send(url), 400);
  assert.equal(f.calls.length, 4);
  assert.equal(reliability.runtime("attempt")!.retryCount, 3);
});
for (const refusal of [403, 200]) {
  test(`native gateway blocks repeated policy refusal (${refusal})`, async (t) => {
    const f = await fixture(
      t,
      "responses",
      'data: {"type":"response.refusal.delta","delta":"Synthetic refusal"}\n\n',
      refusal === 403 ? 403 : undefined,
    );
    for (let i = 0; i < 2; i++)
      await fetch(f.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.token}` },
        body: JSON.stringify({ model: f.cap.model }),
      })
        .then((r) => r.text())
        .catch(() => {});
    assert.equal(f.calls.length, 1);
  });
}
test("native gateway serializes concurrent requests while provider headers stall", async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const gateway = new InferenceGateway(
    f.db,
    f.gateway.upstreams,
    () => {},
    async () => {
      entered();
      return new Promise(() => {});
    },
  );
  const server = gateway.server();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1/responses`;
  const request = () =>
    fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.token}` },
      body: JSON.stringify({ model: f.cap.model }),
    });
  const first = request()
    .then((r) => r.text())
    .catch(() => {});
  await ready;
  const busy = await request();
  assert.equal(busy.status, 409);
  await busy.text();
  gateway.revoke("session");
  await first;
});
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
      reasoning: { effort: "low" },
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
  const diagnostic = JSON.parse(
    f.db.one<any>("SELECT record FROM inference_diagnostics")!.record,
  );
  assert.equal(diagnostic.maxOutputTokens, 32768);
  assert.equal(diagnostic.reasoningEffort, "low");
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

test("gateway accepts valid SSE data without a space and multiline JSON", async (t) => {
  const f = await fixture(
    t,
    "responses",
    'data:{"type":"response.completed",\ndata:"response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
  );
  const response = await fetch(f.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.token}` },
    body: JSON.stringify({ model: f.cap.model }),
  });
  assert.equal(await response.text(), f.upstream);
  const record = JSON.parse(
    f.db.one<any>("SELECT record FROM inference_usage")!.record,
  );
  assert.equal(record.complete, true);
});

for (const [stream, code] of [
  [
    'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
    "max_output_tokens",
  ],
  [
    'data: {malformed}\n\ndata: {"type":"response.completed","response":{}}\n\n',
    "protocol",
  ],
] as const) {
  test(`gateway preserves incomplete or malformed stream failure (${code})`, async (t) => {
    const f = await fixture(t, "responses", stream);
    await fetch(f.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.token}` },
      body: JSON.stringify({ model: f.cap.model }),
    })
      .then((r) => r.text())
      .catch(() => {});
    const diagnostic = JSON.parse(
      f.db.one<any>("SELECT record FROM inference_diagnostics")!.record,
    );
    assert.equal(diagnostic.status, "failed");
    assert.equal(diagnostic.failure.kind, "incomplete_stream");
    assert.equal(diagnostic.failure.providerCode, code);
    assert.equal(diagnostic.usageStatus, "unknown");
  });
}
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

test("native gateway never replays an uncertain stream or unresolved request after restart", async (t) => {
  const f = await fixture(
    t,
    "responses",
    'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
  );
  const request = () =>
    fetch(f.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.token}` },
      body: JSON.stringify({ model: f.cap.model }),
    })
      .then((r) => r.text())
      .catch(() => {});
  await request();
  await request();
  assert.equal(f.calls.length, 1);
  // An active durable boundary left by a vanished gateway is uncertain even
  // without a runtime failure. New gateway ownership cannot replay that POST.
  const f2 = await fixture(t);
  const reliability = new ReliabilityStore(f2.db);
  reliability.diagnostic({
    version: 1,
    id: "prior-active",
    sessionId: "session",
    provider: "synthetic",
    model: "synthetic",
    endpoint: "https://example.invalid",
    startedAt: Date.now(),
    phase: "headers",
    status: "active",
  });
  const response = await fetch(f2.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${f2.token}` },
    body: JSON.stringify({ model: f2.cap.model }),
  });
  await response.text();
  assert.equal(response.status, 400);
  assert.equal(f2.calls.length, 0);
});

for (const stream of [
  "data: {malformed}\n\n",
  ": keepalive\n\n",
  'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
]) {
  test("native runtime fences uncertain malformed/incomplete POST before another request", async (t) => {
    const f = await fixture(t, "responses", stream);
    f.db.exec(
      "CREATE TABLE control_goals(id TEXT PRIMARY KEY); INSERT INTO control_goals VALUES('goal'); CREATE TABLE control_attempts(id TEXT PRIMARY KEY,execution_session_id TEXT,outcome TEXT); INSERT INTO control_attempts VALUES('attempt','session','active');",
    );
    const reliability = new ReliabilityStore(f.db);
    reliability.start("attempt", 60000, "implement");
    for (let i = 0; i < 2; i++)
      await fetch(f.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.token}` },
        body: JSON.stringify({ model: f.cap.model }),
      })
        .then((r) => r.text())
        .catch(() => {});
    assert.equal(f.calls.length, 1);
    assert.equal(
      reliability.runtime("attempt")!.failure!.kind,
      "incomplete_stream",
    );
  });
}

test("larger output allowances require both deployment and session authority", async (t) => {
  const f = await fixture(t);
  f.gateway.upstreams.azure.maxOutputTokens = 65536;
  const token = f.gateway.issue({ ...f.cap, maxOutputTokens: 65536 });
  const response = await fetch(f.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: f.cap.model }),
  });
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(f.calls[0].options.body).max_output_tokens, 65536);
  const denied = await fetch(f.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: f.cap.model, max_output_tokens: 65537 }),
  });
  assert.equal(denied.status, 400);
  await denied.text();
  assert.equal(f.calls.length, 1);
});

test("incomplete responses preserve provider usage without inventing a dollar cost", async (t) => {
  const f = await fixture(
    t,
    "responses",
    'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":12,"output_tokens":32768}}}\n\n',
  );
  try {
    const response = await fetch(f.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.token}` },
      body: JSON.stringify({ model: f.cap.model }),
    });
    await response.text();
  } catch {}
  const record = JSON.parse(
    f.db.one<{ record: string }>("SELECT record FROM inference_usage")!.record,
  );
  assert.equal(record.complete, false);
  assert.deepEqual(record.usage, { input_tokens: 12, output_tokens: 32768 });
  assert.equal(record.costUsd, null);
  assert.deepEqual(f.gateway.sessionUsage(f.cap.sessionId), {
    kind: "metered",
    status: "unknown",
    inputTokens: 12,
    outputTokens: 32768,
  });
});

test("session estimates use provider counters and cached rates, retaining unknown requests", async (t) => {
  const f = await fixture(
    t,
    "responses",
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},"output_tokens":10}}}\n\n',
  );
  f.gateway.upstreams.azure.pricing = {
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 10,
    evidenceUrl: "https://example.invalid/pricing",
  };
  const response = await fetch(f.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.token}` },
    body: JSON.stringify({ model: f.cap.model }),
  });
  await response.text();
  const usage = f.gateway.sessionUsage(f.cap.sessionId);
  assert.equal(usage.status, "estimated");
  if (usage.status === "estimated") assert.equal(usage.costUsd, 0.000148);
  assert.equal(f.gateway.sessionUsage("unreported").status, "unknown");
  f.db.exec(
    `INSERT INTO inference_diagnostics(id,attempt_id,record) VALUES('unfinished',NULL,${sql(JSON.stringify({ id: "unfinished", sessionId: f.cap.sessionId, phase: "body", status: "active", providerRequestStarted: true }))})`,
  );
  assert.deepEqual(f.gateway.sessionUsage(f.cap.sessionId), {
    kind: "metered",
    status: "unknown",
  });
});

test("local retry denial retains billed provider counters and uncertain provider calls remain unknown", async (t) => {
  const f = await fixture(
    t,
    "responses",
    'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":100,"output_tokens":10}}}\n\n',
  );
  f.gateway.upstreams.azure.pricing = {
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 10,
    evidenceUrl: "https://example.invalid/pricing",
  };
  const request = () =>
    fetch(f.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.token}` },
      body: JSON.stringify({ model: f.cap.model }),
    });
  try {
    await (await request()).text();
  } catch {}
  const before = f.gateway.sessionUsage(f.cap.sessionId);
  assert.equal(before.status, "estimated");
  const denied = await request();
  assert.equal(denied.status, 400);
  await denied.text();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.gateway.sessionUsage(f.cap.sessionId), before);
  const records = f.db
    .query<{ record: string }>("SELECT record FROM inference_usage")
    .map((row) => JSON.parse(row.record));
  assert.equal(records[0].providerRequestStarted, true);
  assert.equal(records.at(-1).providerRequestStarted, false);
  f.db.exec(
    `INSERT INTO inference_usage(capability_hash,record,created_at) VALUES('uncertain',${sql(JSON.stringify({ sessionId: f.cap.sessionId, providerRequestStarted: true, usage: null, costUsd: null }))},1)`,
  );
  assert.equal(f.gateway.sessionUsage(f.cap.sessionId).status, "unknown");
});
