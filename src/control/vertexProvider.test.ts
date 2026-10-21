import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IsolatedPortableTools } from "./isolatedTools.js";
import { VertexProvider } from "./vertexProvider.js";
import { vertexBackendSchema } from "./vertexConfig.js";
import { vertexAuthentication } from "./vertexAuth.js";
import { ProviderFailure, deadlineSignal } from "./reliability.js";
import { PortableBackend, HumanWait } from "./backends.js";
import {
  executionContractSchema,
  validateBackendContract,
} from "./executionContract.js";
import {
  isolatedRuntimeSchema,
  assertSessionAuthority,
} from "./isolatedRuntime.js";
import { SqliteStore, sql } from "../sqlite.js";
import { ControlStore } from "./store.js";
const vertexFixtureConfig = () =>
  vertexBackendSchema.parse({
    kind: "vertex",
    project: "fixture-project",
    quotaProject: "fixture-quota",
    location: "global",
    model: "gemini-4-argon",
    thinkingLevel: "high",
    maxInputTokens: 8192,
    maxOutputTokens: 1024,
    maxRequestCostUsd: 1,
    pricing: [
      {
        version: "fixture-1",
        currency: "USD",
        effectiveFrom: "2026-01-01T00:00:00Z",
        effectiveUntil: "2027-01-01T00:00:00Z",
        inputUsdPerMillion: 2,
        cachedInputUsdPerMillion: 0.5,
        outputUsdPerMillion: 10,
        thinkingUsdPerMillion: 12,
        evidenceUrl: "https://example.invalid/pricing",
      },
    ],
  });
const config = vertexFixtureConfig;
const now = () => Date.parse("2026-10-21T00:00:00Z");
const messages = [{ role: "user" as const, content: "fixture" }];
const tool = {
  name: "read_file",
  description: "Read",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};
const usage = {
  promptTokenCount: 100,
  candidatesTokenCount: 20,
  thoughtsTokenCount: 30,
  cachedContentTokenCount: 40,
  totalTokenCount: 150,
};
const terminal = (parts: unknown[] = [{ text: "answer" }]) => ({
  modelVersion: "gemini-4-argon",
  responseId: "fixture-request",
  candidates: [
    { index: 0, content: { role: "model", parts }, finishReason: "STOP" },
  ],
  usageMetadata: usage,
});
function stream(events: unknown[], trailing = "") {
  return new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + trailing,
    {
      headers: {
        "content-type": "text/event-stream",
        "x-goog-request-id": "fixture-header-id",
      },
    },
  );
}
const provider = (fetcher: typeof fetch, overrides = {}) =>
  new VertexProvider(
    { ...config(), ...overrides },
    fetcher,
    async (signal) => {
      signal.throwIfAborted();
      return { Authorization: "Bearer fixture-token" };
    },
    undefined,
    "fixture",
    now,
  );

test("Vertex text, nonstream and cumulative usage price prompt/cache/thinking exactly once", async () => {
  let request: any;
  const p = provider((async (url, init) => {
    assert.equal(
      String(url),
      "https://aiplatform.googleapis.com/v1beta1/projects/fixture-project/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse",
    );
    request = JSON.parse(String(init?.body));
    assert.equal(
      (init?.headers as any)["x-goog-user-project"],
      "fixture-quota",
    );
    assert.equal(init?.redirect, "error");
    return stream([
      {
        usageMetadata: {
          ...usage,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 0,
          totalTokenCount: 100,
        },
      },
      terminal(),
    ]);
  }) as typeof fetch);
  const result = await p.generate(messages, [], new AbortController().signal);
  assert.equal(result.text, "answer");
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 50);
  assert.equal(p.cost(result), (60 * 2 + 40 * 0.5 + 20 * 10 + 30 * 12) / 1e6);
  assert.equal(result.vertexUsage?.modelVersion, "gemini-4-argon");
  assert.equal(request.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
  assert.equal("candidateCount" in request.generationConfig, false);
  const nonstream = provider(
    (async (url) => {
      assert.match(String(url), /:generateContent$/);
      return Response.json(terminal());
    }) as typeof fetch,
    { stream: false },
  );
  assert.equal(
    (await nonstream.generate(messages, [], new AbortController().signal)).text,
    "answer",
  );
});

test("portable planner stops after four measured calls without refunding usage or executing a fifth tool", async () => {
  let requests = 0,
    tools = 0;
  const backend = new PortableBackend({
    reservation: () => 0.01,
    cost: () => 0.01,
    generate: async () => ({
      text: "",
      calls: [
        {
          id: `call-${++requests}`,
          name: "read_file",
          arguments: { path: "file" },
        },
      ],
      inputTokens: 10,
      outputTokens: 5,
      vertexUsage: {
        prompt: 10,
        candidates: 2,
        thinking: 3,
        cached: 2,
        pricingVersion: "fixture",
        modelVersion: "fixture",
      },
    }),
  });
  backend.tool = async () => {
    tools++;
    return "fixture";
  };
  await assert.rejects(
    backend.run({
      claim: {
        goal: { config: { estimatePerRunUsd: 1, maxCostUsd: 1 } },
        task: { spec: {} },
        generation: 1,
      } as any,
      mode: "plan",
      prompt: "plan",
      workspace: "/fixture",
      signal: new AbortController().signal,
      onCheckpoint: async () => {},
    }),
    (error: any) => {
      assert.match(error.message, /reviewed fixed plan/);
      assert.equal(error.costUsd, 0.04);
      assert.equal(error.usage.inputTokens, 40);
      assert.equal(error.usage.outputTokens, 20);
      assert.equal(error.usage.thinkingTokens, 12);
      assert.equal(error.usage.cachedInputTokens, 8);
      return true;
    },
  );
  assert.equal(requests, 4);
  assert.equal(tools, 4);
});

test("Vertex accepts live metadata-only chunks but requires complete final token evidence", async () => {
  const metadata = { trafficType: "ON_DEMAND" };
  const first = {
    modelVersion: "gemini-4-argon",
    responseId: "live-shape-fixture",
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "read_file",
                args: { path: "file" },
                id: "call-one",
              },
              thoughtSignature: "opaque-fixture",
            },
          ],
        },
      },
    ],
    usageMetadata: metadata,
  };
  const last = {
    modelVersion: "gemini-4-argon",
    responseId: "live-shape-fixture",
    candidates: [
      {
        content: { role: "model", parts: [{ text: "" }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { ...usage, ...metadata },
  };
  const p = provider((async () => stream([first, last])) as typeof fetch);
  const r = await p.generate(messages, [tool], new AbortController().signal);
  assert.equal(r.calls[0]?.id, "call-one");
  assert.equal(r.nativeParts?.[0]?.thoughtSignature, "opaque-fixture");
  assert.equal(r.inputTokens, usage.promptTokenCount);
  assert.equal(
    r.outputTokens,
    usage.candidatesTokenCount + usage.thoughtsTokenCount,
  );
  for (const finalMetadata of [
    metadata,
    { ...metadata, promptTokenCount: 100 },
  ]) {
    const bad = provider((async () =>
      stream([
        first,
        { ...last, usageMetadata: finalMetadata },
      ])) as typeof fetch);
    await assert.rejects(
      bad.generate(messages, [tool], new AbortController().signal),
    );
  }
});

test("Vertex existing tool loop preserves native thought signatures and function responses", async () => {
  let dispatches = 0,
    executed = 0;
  const signature = "fixture-thought-signature";
  const p = provider((async (_url, init) => {
    dispatches++;
    const body = JSON.parse(String(init?.body));
    if (dispatches === 1)
      return stream([
        terminal([
          {
            text: "private reasoning",
            thought: true,
            thoughtSignature: signature,
          },
          {
            functionCall: {
              name: "read_file",
              args: { path: "file" },
              id: "call-one",
            },
            thoughtSignature: signature,
          },
        ]),
      ]);
    assert.equal(body.contents[1].parts[0].thoughtSignature, signature);
    assert.equal(body.contents[1].parts[1].thoughtSignature, signature);
    assert.deepEqual(body.contents[2].parts[0], {
      functionResponse: {
        name: "read_file",
        id: "call-one",
        response: { result: "fixture file" },
      },
    });
    assert.ok(body.tools[0].functionDeclarations[0].parametersJsonSchema);
    return stream([terminal()]);
  }) as typeof fetch);
  class Loop extends PortableBackend {
    override async tool(c: any) {
      c.signal.throwIfAborted();
      executed++;
      return "fixture file";
    }
  }
  const r = await new Loop(p).run({
    mode: "implement",
    prompt: "fixture",
    signal: new AbortController().signal,
    claim: {
      goal: { id: "goal", config: { estimatePerRunUsd: 1, maxCostUsd: 2 } },
      task: { id: "task" },
      generation: 1,
    },
    onCheckpoint: async () => {},
  } as any);
  assert.equal(dispatches, 2);
  assert.equal(executed, 1);
  assert.equal(r.text, "answer");
  assert.equal(r.usage?.kind, "metered");
  assert.equal((r.usage as any).thinkingTokens, 60);
  assert.equal((r.usage as any).cachedInputTokens, 80);
});

test("Vertex human handoff retains signed calls, completed/deferred responses and measured cost on resume", async () => {
  const question = {
    question: "Choose behavior",
    reason: "fixture decision",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  };
  const nativeParts = [
    {
      functionCall: {
        name: "read_file",
        args: { path: "before" },
        id: "before",
      },
    },
    {
      functionCall: {
        name: "request_human_input",
        args: question,
        id: "human",
      },
      thoughtSignature: "signed-human-fixture",
    },
    {
      functionCall: { name: "read_file", args: { path: "after" }, id: "after" },
      thoughtSignature: "signed-deferred-fixture",
    },
  ];
  let dispatches = 0,
    executed = 0;
  const p = provider((async (_url, init) => {
    dispatches++;
    if (dispatches === 1) return stream([terminal(nativeParts)]);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.contents[1].parts, nativeParts);
    assert.deepEqual(body.contents[2].parts[0], {
      functionResponse: {
        name: "read_file",
        id: "before",
        response: { result: "file contents" },
      },
    });
    assert.equal(body.contents[2].parts[1].functionResponse.id, "human");
    assert.match(
      body.contents[2].parts[1].functionResponse.response.result,
      /controller-recorded answer/,
    );
    assert.equal(body.contents[2].parts[2].functionResponse.id, "after");
    assert.match(
      body.contents[2].parts[2].functionResponse.response.result,
      /Not executed/,
    );
    assert.match(body.contents[2].parts[3].text, /Human answer: A/);
    return stream([terminal()]);
  }) as typeof fetch);
  class Loop extends PortableBackend {
    override async tool(_c: any, call: any) {
      executed++;
      assert.equal(call.id, "before");
      return "file contents";
    }
  }
  let checkpoint: any;
  const context: any = {
    mode: "implement",
    prompt: "fixture",
    signal: new AbortController().signal,
    claim: {
      goal: { id: "goal", config: { estimatePerRunUsd: 1, maxCostUsd: 2 } },
      task: { id: "task" },
      generation: 1,
    },
    onCheckpoint: async (
      summary: string,
      messages: any,
      pendingTool: any,
      costUsd: number,
    ) => {
      checkpoint = structuredClone({ summary, messages, pendingTool, costUsd });
    },
  };
  await assert.rejects(new Loop(p).run(context), (error: any) => {
    assert.ok(error instanceof HumanWait);
    assert.equal(
      (error as HumanWait & { costUsd: number }).costUsd,
      checkpoint.costUsd,
    );
    assert.ok((error as HumanWait & { costUsd: number }).costUsd > 0);
    return true;
  });
  assert.equal(checkpoint.pendingTool, undefined);
  assert.equal(dispatches, 1);
  assert.equal(executed, 1);
  context.claim.task.checkpoint = checkpoint;
  context.prompt = "Human answer: A";
  assert.equal((await new Loop(p).run(context)).text, "answer");
  assert.equal(dispatches, 2);
  assert.equal(executed, 1);
});

test("Vertex accepts final cumulative usage after STOP without summing interim usage", async () => {
  const p = provider((async () =>
    stream([
      { usageMetadata: usage },
      { ...terminal(), usageMetadata: undefined },
      { usageMetadata: usage },
    ])) as typeof fetch);
  const result = await p.generate(messages, [], new AbortController().signal);
  assert.equal(result.outputTokens, 50);
  assert.equal(p.cost(result), (60 * 2 + 40 * 0.5 + 20 * 10 + 30 * 12) / 1e6);
});

for (const [name, events, trailing] of [
  ["missing usage", [{ ...terminal(), usageMetadata: undefined }], ""],
  [
    "interim usage without final usage",
    [
      {
        usageMetadata: {
          ...usage,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 0,
          totalTokenCount: 100,
        },
      },
      { ...terminal(), usageMetadata: undefined },
    ],
    "",
  ],
  [
    "stale final output usage",
    [
      {
        ...terminal(),
        usageMetadata: {
          ...usage,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 0,
          totalTokenCount: 100,
        },
      },
    ],
    "",
  ],
  [
    "stale final thinking usage",
    [
      {
        ...terminal([{ text: "reasoning", thought: true }]),
        usageMetadata: {
          ...usage,
          thoughtsTokenCount: 0,
          totalTokenCount: 120,
        },
      },
    ],
    "",
  ],
  [
    "decreasing cache snapshot",
    [
      { usageMetadata: usage },
      {
        ...terminal(),
        usageMetadata: { ...usage, cachedContentTokenCount: 0 },
      },
    ],
    "",
  ],
  [
    "partial stream",
    [{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }],
    "",
  ],
  ["truncated event", [], "data: {"],
  ["malformed event", [], "data: nope\n\n"],
  [
    "malformed function args",
    [terminal([{ functionCall: { name: "read_file", args: "bad" } }])],
    "",
  ],
  ["duplicate completion", [terminal(), terminal()], ""],
  [
    "double-counted usage",
    [{ ...terminal(), usageMetadata: { ...usage, totalTokenCount: 190 } }],
    "",
  ],
  [
    "cache exceeds prompt",
    [
      {
        ...terminal(),
        usageMetadata: { ...usage, cachedContentTokenCount: 101 },
      },
    ],
    "",
  ],
  [
    "thinking exceeds generation bound",
    [
      {
        ...terminal(),
        usageMetadata: {
          ...usage,
          thoughtsTokenCount: 2000,
          totalTokenCount: 2120,
        },
      },
    ],
    "",
  ],
  [
    "max tokens",
    [{ ...terminal(), candidates: [{ finishReason: "MAX_TOKENS" }] }],
    "",
  ],
  [
    "unknown tool",
    [terminal([{ functionCall: { name: "unexpected", args: {} } }])],
    "",
  ],
  ["missing model version", [{ ...terminal(), modelVersion: undefined }], ""],
] as [string, unknown[], string][])
  test(`Vertex ${name} fails conservatively without retries`, async () => {
    let dispatched = 0;
    const p = provider((async () => {
      dispatched++;
      return stream(events, trailing);
    }) as typeof fetch);
    await assert.rejects(
      p.generate(messages, [tool], new AbortController().signal),
      ProviderFailure,
    );
    assert.equal(dispatched, 1);
  });
for (const [status, kind] of [
  [401, "authentication"],
  [403, "authentication"],
  [429, "rate_limit"],
  [500, "service"],
  [503, "service"],
] as const)
  test(`Vertex HTTP ${status} strips provider prose and bounds retries to zero`, async () => {
    let dispatched = 0;
    const p = provider((async () => {
      dispatched++;
      return new Response("secret fixture-token and prompt excerpt", {
        status,
      });
    }) as typeof fetch);
    await assert.rejects(
      p.generate(messages, [], new AbortController().signal),
      (e: any) =>
        e.failure.kind === kind && !e.message.includes("fixture-token"),
    );
    assert.equal(dispatched, 1);
  });

test("Vertex pricing effective dates, request budgets and input bounds fail before auth/HTTP", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return stream([terminal()]);
  }) as typeof fetch;
  const expired = new VertexProvider(
    config(),
    fetcher,
    async () => {
      calls++;
      return {};
    },
    undefined,
    "fixture",
    () => Date.parse("2027-01-01T00:00:00Z"),
  );
  await assert.rejects(
    expired.generate(messages, [], new AbortController().signal),
  );
  const over = provider(fetcher, { maxRequestCostUsd: 0.001 });
  await assert.rejects(
    over.generate(messages, [], new AbortController().signal),
  );
  await assert.rejects(
    provider(fetcher).generate(
      [{ role: "user", content: "x".repeat(9000) }],
      [],
      new AbortController().signal,
    ),
  );
  assert.equal(calls, 0);
  const c = config();
  c.pricing.push({
    ...c.pricing[0]!,
    version: "fixture-2",
    effectiveFrom: "2027-01-01T00:00:00Z",
    effectiveUntil: "2028-01-01T00:00:00Z",
    inputUsdPerMillion: 4,
  });
  const p = new VertexProvider(
    c,
    fetcher,
    async () => ({}),
    undefined,
    "fixture",
    () => Date.parse("2027-01-01T00:00:00Z"),
  );
  const r = await p.generate(messages, [], new AbortController().signal);
  assert.equal(r.vertexUsage?.pricingVersion, "fixture-2");
  assert.equal(p.cost(r), (60 * 4 + 40 * 0.5 + 20 * 10 + 30 * 12) / 1e6);
  assert.throws(() =>
    vertexBackendSchema.parse({ ...config(), location: "us-central1" }),
  );
  assert.throws(() =>
    vertexBackendSchema.parse({ ...config(), project: "../escape" }),
  );
  assert.throws(() =>
    vertexBackendSchema.parse({
      ...config(),
      pricing: [{ ...config().pricing[0], currency: "EUR" }],
    }),
  );
  assert.throws(() =>
    vertexBackendSchema.parse({
      ...config(),
      pricing: [
        config().pricing[0],
        { ...config().pricing[0], version: "overlap" },
      ],
    }),
  );
});

test("Vertex cancellation/deadlines cancel streams, auth and subsequent tools/dispatch", async () => {
  let cancel = false,
    calls = 0;
  const controller = new AbortController();
  const p = provider((async (_url, init) => {
    calls++;
    assert.equal(init?.signal?.aborted, false);
    controller.signal.addEventListener(
      "abort",
      () => {
        assert.equal(init?.signal?.aborted, true);
      },
      { once: true },
    );
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
            ),
          );
        },
        cancel() {
          cancel = true;
        },
      }),
    );
  }) as typeof fetch);
  const pending = p.generate(messages, [], controller.signal, {
    progress: () => controller.abort(new Error("cancelled")),
  });
  await assert.rejects(pending);
  assert.equal(cancel, true);
  assert.equal(calls, 1);
  await assert.rejects(p.generate(messages, [], controller.signal));
  assert.equal(calls, 1);
  const signal = deadlineSignal(Date.now() + 20, new AbortController().signal);
  const authPending = new VertexProvider(
    config(),
    (async () => {
      calls++;
      return stream([terminal()]);
    }) as typeof fetch,
    async () => new Promise(() => {}),
    undefined,
    "fixture",
    now,
  );
  const keepAlive = setTimeout(() => {}, 100);
  await assert.rejects(authPending.generate(messages, [], signal));
  clearTimeout(keepAlive);
  assert.equal(calls, 1);
  const stopped = new AbortController();
  let tools = 0;
  const loop = new PortableBackend(
    provider((async () =>
      stream([
        terminal([
          { functionCall: { name: "read_file", args: { path: "fixture" } } },
        ]),
      ])) as typeof fetch),
  );
  loop.tool = async () => {
    tools++;
    return "bad";
  };
  await assert.rejects(
    loop.run({
      mode: "implement",
      prompt: "fixture",
      signal: stopped.signal,
      claim: {
        goal: { config: { estimatePerRunUsd: 1 } },
        task: { id: "task" },
        generation: 1,
      },
      onCheckpoint: async () => {
        stopped.abort(new Error("cancelled"));
      },
    } as any),
  );
  assert.equal(tools, 0);
});

test("Vertex dedicated ADC refresh, cache, reauth failures, impersonation and quota pinning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-vertex-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adc = {
    type: "authorized_user",
    client_id: "fixture-client",
    client_secret: "fixture-secret",
    refresh_token: "fixture-refresh",
    quota_project_id: "fixture-quota",
  };
  await writeFile(join(root, "adc.json"), JSON.stringify(adc), { mode: 0o600 });
  const authConfig = {
    kind: "google-adc" as const,
    egressHosts: ["oauth2.googleapis.com", "aiplatform.googleapis.com"] as (
      | "oauth2.googleapis.com"
      | "aiplatform.googleapis.com"
      | "iamcredentials.googleapis.com"
    )[],
    reference: { kind: "file" as const, path: "adc.json" },
  };
  let authNow = Date.now();
  let calls = 0;
  const registered: string[] = [];
  const auth = vertexAuthentication(
    authConfig,
    root,
    "fixture-quota",
    (s) => registered.push(s),
    (async (url, init) => {
      calls++;
      assert.equal(String(url), "https://oauth2.googleapis.com/token");
      assert.equal(init?.signal?.aborted, false);
      return Response.json({
        access_token: "fixture-access",
        expires_in: 3600,
      });
    }) as typeof fetch,
    () => authNow,
  );
  const signal = new AbortController().signal;
  assert.equal((await auth(signal)).Authorization, "Bearer fixture-access");
  await auth(signal);
  assert.equal(calls, 1);
  authNow += 3550000;
  await auth(signal);
  assert.equal(calls, 2);
  assert.ok(registered.includes("fixture-refresh"));
  assert.ok(registered.includes("fixture-access"));
  const bad = vertexAuthentication(
    authConfig,
    root,
    "other-quota",
    () => {},
    (async () => {
      throw Error("should not dispatch");
    }) as typeof fetch,
  );
  await assert.rejects(bad(signal), /reauthenticate/);
  for (const response of [
    new Response("fixture-secret", { status: 401 }),
    Response.json({ access_token: "fixture-access", expires_in: 1 }),
    Response.json({ error: "invalid_grant" }),
  ]) {
    const failure = vertexAuthentication(
      authConfig,
      root,
      "fixture-quota",
      () => {},
      (async () => response) as typeof fetch,
    );
    await assert.rejects(
      failure(signal),
      (e: any) =>
        e.failure.kind === "authentication" &&
        !e.message.includes("fixture-secret"),
    );
  }
  let impersonationCalls = 0;
  const impersonate = vertexAuthentication(
    {
      ...authConfig,
      egressHosts: [...authConfig.egressHosts, "iamcredentials.googleapis.com"],
      impersonateServiceAccount:
        "fixture@fixture-project.iam.gserviceaccount.com",
    },
    root,
    "fixture-quota",
    () => {},
    (async (url, init) => {
      impersonationCalls++;
      if (String(url).includes("oauth2"))
        return Response.json({
          access_token: "fixture-access",
          expires_in: 3600,
        });
      assert.equal(
        (init?.headers as any)["x-goog-user-project"],
        "fixture-quota",
      );
      return Response.json({
        accessToken: "fixture-impersonated",
        expireTime: new Date(Date.now() + 3500000).toISOString(),
      });
    }) as typeof fetch,
  );
  assert.equal(
    (await impersonate(signal)).Authorization,
    "Bearer fixture-impersonated",
  );
  assert.equal(impersonationCalls, 2);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(auth(stopped.signal));
  assert.equal(calls, 2);
});

test("Vertex contracts stay in isolated controller tool-loop and reject alternate harnesses", () => {
  const contract = executionContractSchema.parse({
    provider: "vertex",
    harness: "tool-loop",
    execution: "isolated",
    authentication: { kind: "controller", reference: "vertex-test" },
    usagePolicy: { kind: "metered", maxCostUsd: 5, estimatePerRunUsd: 1 },
  });
  validateBackendContract(config(), contract);
  assert.throws(() =>
    executionContractSchema.parse({ ...contract, harness: "codex" }),
  );
  assert.throws(() =>
    executionContractSchema.parse({
      ...contract,
      authentication: { kind: "session", reference: "ambient" },
    }),
  );
  const runtime = {
    projects: {},
    providers: {
      "vertex-test": {
        protocol: "tool-loop",
        backend: config(),
        authentication: {
          kind: "google-adc",
          egressHosts: ["oauth2.googleapis.com", "aiplatform.googleapis.com"],
          reference: { kind: "file", path: "adc.json" },
        },
      },
    },
  };
  isolatedRuntimeSchema.parse(runtime);
  assert.throws(() =>
    isolatedRuntimeSchema.parse({
      ...runtime,
      providers: {
        "vertex-test": {
          ...runtime.providers["vertex-test"],
          authentication: {
            kind: "google-adc",
            reference: { kind: "env", name: "GOOGLE_APPLICATION_CREDENTIALS" },
          },
        },
      },
    }),
  );
});

test("Vertex ledger retains uncertain billing, reconciles once, and atomically fences goal/installation capacity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-vertex-ledger-"));
  const db = new SqliteStore(join(root, "db"));
  const store = new ControlStore(db);
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  store.setting("configuration-snapshot", {
    settings: {
      authority: { maxConcurrentMeteredRuns: 1, maxTotalAdmittedCostUsd: 10 },
    },
  });
  // Exact Vertex configuration uses the ordinary atomic reservation ledger.
  const g = store.createGoal({
    title: "fixture",
    description: "fixture",
    repoPath: root,
    backend: config(),
    executionContract: {
      provider: "vertex",
      harness: "tool-loop",
      execution: "isolated",
      authentication: { kind: "controller", reference: "vertex-test" },
      usagePolicy: { kind: "metered", maxCostUsd: 1, estimatePerRunUsd: 1 },
    },
    maxCostUsd: 1,
    estimatePerRunUsd: 1,
  });
  const other = store.createGoal({ ...g.config, title: "second fixture" });
  const reservations = await Promise.allSettled([
    Promise.resolve().then(() => store.reserveOperation(g.id, "one")),
    Promise.resolve().then(() => store.reserveOperation(g.id, "two")),
  ]);
  assert.equal(reservations.filter((r) => r.status === "fulfilled").length, 1);
  assert.throws(
    () => store.reserveOperation(other.id, "concurrent review"),
    /concurrency/,
  );
  const id = (
    reservations.find(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<string>
  ).value;
  // A prompt-only interim snapshot followed by STOP without final usage must
  // propagate unknown billing through the actual controller tool-loop boundary.
  const incomplete = provider((async () =>
    stream([
      {
        usageMetadata: {
          ...usage,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 0,
          totalTokenCount: 100,
        },
      },
      { ...terminal(), usageMetadata: undefined },
    ])) as typeof fetch);
  await assert.rejects(
    new PortableBackend(incomplete).run({
      mode: "plan",
      prompt: "fixture",
      signal: new AbortController().signal,
      operationReservationId: id,
      claim: { goal: g, task: { id: "planning" }, generation: 0 },
      onCheckpoint: async () => {},
    } as any),
    (error: any) => {
      assert.equal(error.costUsd, undefined);
      assert.deepEqual(error.usage, { kind: "metered", status: "unknown" });
      store.settleOperation(id, error.costUsd, error.usage, "failed");
      return true;
    },
  );
  store.settleOperation(id, 0); // late duplicate success cannot free unknown billing
  assert.equal(store.canSpend(g.id).unresolvedUsd, 1);
  assert.throws(() => store.reserveOperation(g.id, "retry"));
  // The existing evidence-backed reconciliation endpoint refuses repeat settlement.
  const artifact = store.artifact(
    g.id,
    undefined,
    "billing-evidence",
    "receipt.json",
  );
  store.reconcileUsage(
    id,
    {
      costUsd: 0.25,
      status: "reported",
      evidenceArtifactId: artifact,
      explanation: "fixture usage evidence",
    },
    "a".repeat(64),
    "operator",
  );
  assert.equal(store.canSpend(g.id).settledUsd, 0.25);
  assert.equal(store.canSpend(g.id).unresolvedUsd, 0);
  assert.throws(() =>
    store.reconcileUsage(
      id,
      {
        costUsd: 0.5,
        status: "reported",
        evidenceArtifactId: artifact,
        explanation: "changed",
      },
      "a".repeat(64),
      "operator",
    ),
  );
  assert.equal(
    db.one<any>(`SELECT actual FROM control_budgets WHERE id=${sql(id)}`)
      ?.actual,
    0.25,
  );
});

test("Vertex completed coding frees only run capacity for review, retaining atomic spending and resource fences", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-vertex-review-"));
  const db = new SqliteStore(join(root, "db")),
    store = new ControlStore(db);
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  store.setting("configuration-snapshot", {
    settings: {
      authority: { maxConcurrentMeteredRuns: 1, maxTotalAdmittedCostUsd: 10 },
    },
  });
  const goal = store.createGoal({
    title: "fixture",
    description: "fixture",
    repoPath: root,
    backend: config(),
    executionContract: {
      provider: "vertex",
      harness: "tool-loop",
      execution: "isolated",
      authentication: { kind: "controller", reference: "vertex-test" },
      usagePolicy: { kind: "metered", maxCostUsd: 3, estimatePerRunUsd: 1 },
    },
    maxCostUsd: 3,
    estimatePerRunUsd: 1,
    verificationCommands: ["test -d ."],
  });
  store.installPlan(
    goal.id,
    {
      tasks: [
        {
          key: "one",
          title: "one",
          description: "one",
          allowedPaths: ["**"],
          acceptanceCriteria: ["done"],
        },
      ],
    },
    goal.revision,
  );
  const claim = store.claimNextTask("worker", { goalId: goal.id })!;
  store.transition(claim.task.id, claim.workerId, claim.generation, "running");
  const codingSession: any = {
    id: "fixture-session",
    taskId: claim.task.id,
    generation: claim.generation,
    spec: {
      goalId: goal.id,
      workerId: claim.workerId,
      authorityGeneration: claim.generation,
    },
  };
  assertSessionAuthority(store, codingSession);
  store.checkpoint(claim.task.id, claim.workerId, claim.generation, {
    summary: "partial",
    usage: { kind: "metered", status: "estimated", costUsd: 0.1 },
  });
  assert.throws(
    () => store.reserveOperation(goal.id, "premature review", claim),
    /concurrency/,
  );
  const result: any = {
    text: "done",
    inputTokens: 100,
    outputTokens: 50,
    usage: { kind: "metered", status: "unknown" },
    executionSessionId: codingSession.id,
  };
  store.transition(
    claim.task.id,
    claim.workerId,
    claim.generation,
    "verifying",
    result,
  );
  assert.throws(
    () => assertSessionAuthority(store, codingSession),
    /Coding inference ended/,
  );
  assert.throws(
    () => store.reserveOperation(goal.id, "unknown review", claim),
    /concurrency/,
  );
  result.usage = { kind: "metered", status: "estimated", costUsd: 0.1 };
  db.exec(
    `UPDATE control_attempts SET result=${sql(JSON.stringify(result))},usage=${sql(JSON.stringify(result.usage))} WHERE id=${sql(`${claim.task.id}:${claim.generation}`)}`,
  );
  const sessionRecord = {
    ...codingSession,
    status: "active",
    container: "fixture-container",
  };
  db.exec(
    `INSERT INTO execution_invocations VALUES(${sql(codingSession.id)},${sql(claim.task.id)},${claim.generation},${sql(JSON.stringify(sessionRecord))})`,
  );
  assert.throws(
    () => store.reserveOperation(goal.id, "live resources", claim),
    /concurrency/,
  );
  db.exec(
    `UPDATE execution_invocations SET record=${sql(JSON.stringify({ ...sessionRecord, status: "checkpointed", container: undefined }))}`,
  );
  const reservations = await Promise.allSettled([
    Promise.resolve().then(() =>
      store.reserveOperation(goal.id, "review", claim),
    ),
    Promise.resolve().then(() =>
      store.reserveOperation(goal.id, "parallel review", claim),
    ),
  ]);
  assert.equal(reservations.filter((r) => r.status === "fulfilled").length, 1);
  const reviewId = (
    reservations.find(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<string>
  ).value;
  assertSessionAuthority(store, {
    ...codingSession,
    spec: { ...codingSession.spec, operationReservationId: reviewId },
  });
  assert.equal(store.canSpend(goal.id).reservedUsd, 2);
  store.settleOperation(reviewId, 0.2);
  assert.throws(
    () =>
      assertSessionAuthority(store, {
        ...codingSession,
        spec: { ...codingSession.spec, operationReservationId: reviewId },
      }),
    /reservation/,
  );
  assert.equal(store.canSpend(goal.id).reservedUsd, 1);
  // Coding dollars remain reserved until acceptance/release, despite stopped execution.
  assert.equal(store.canSpend(goal.id).settledUsd, 0.2);
  store.release(
    claim.task.id,
    claim.workerId,
    claim.generation,
    "failed",
    "fixture complete",
    0.1,
  );
  assert.ok(Math.abs(store.canSpend(goal.id).settledUsd - 0.3) < 1e-12);
});

test("Vertex diagnostics retain partial counters without secrets or free settlement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-vertex-diagnostic-"));
  const db = new SqliteStore(join(root, "db"));
  const store = new ControlStore(db);
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  store.redactor.register("diagnostic-secret");
  const p = new VertexProvider(
    config(),
    (async () =>
      stream(
        [
          {
            modelVersion: "gemini-4-argon",
            responseId: "partial-request",
            usageMetadata: usage,
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: "diagnostic-secret",
                      thought: true,
                      thoughtSignature: "private-signature",
                    },
                  ],
                },
              },
            ],
          },
        ],
        "data: {",
      )) as typeof fetch,
    async () => ({ Authorization: "Bearer diagnostic-secret" }),
    store.reliability,
    "fixture",
    now,
  );
  await assert.rejects(
    p.generate(messages, [], new AbortController().signal, {
      goalId: "fixture-goal",
      attemptId: "fixture-attempt",
    }),
  );
  const d = store.reliability.page("inference_diagnostics")[0];
  assert.equal(d.usageStatus, "unknown");
  assert.equal(d.providerCostUsd, undefined);
  assert.equal(d.tokenUsage.thinking, 30);
  assert.equal(d.modelVersion, "gemini-4-argon");
  assert.equal(d.requestIds["vertex-response-id"], "partial-request");
  assert.equal(d.project, "fixture-project");
  assert.equal(d.quotaProject, "fixture-quota");
  assert.equal(JSON.stringify(d).includes("diagnostic-secret"), false);
  assert.equal(JSON.stringify(d).includes("private-signature"), false);
});

test("Vertex event/stream bounds and HTTP deadline stop reading without replay", async () => {
  let cancelled = false;
  const p = provider(
    (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode("data: " + "x".repeat(1024 * 1024 + 1)),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch,
  );
  await assert.rejects(p.generate(messages, [], new AbortController().signal));
  assert.equal(cancelled, true);
  let calls = 0,
    httpAborted = false;
  const timed = provider((async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) =>
      init?.signal?.addEventListener(
        "abort",
        () => {
          httpAborted = true;
          reject(init.signal?.reason);
        },
        { once: true },
      ),
    );
  }) as typeof fetch);
  const keepAlive = setTimeout(() => {}, 100);
  await assert.rejects(
    timed.generate(
      messages,
      [],
      deadlineSignal(Date.now() + 20, new AbortController().signal),
    ),
  );
  clearTimeout(keepAlive);
  assert.equal(calls, 1);
  assert.equal(httpAborted, true);
});

test("Vertex installation admission is cumulative across goals and cannot use absent caps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-vertex-caps-"));
  const db = new SqliteStore(join(root, "db"));
  const store = new ControlStore(db);
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const goal: Parameters<ControlStore["createGoal"]>[0] = {
    title: "fixture",
    description: "fixture",
    repoPath: root,
    backend: config(),
    maxCostUsd: 1,
    estimatePerRunUsd: 1,
    executionContract: {
      provider: "vertex",
      harness: "tool-loop",
      execution: "isolated",
      authentication: { kind: "controller", reference: "fixture" },
      usagePolicy: { kind: "metered", maxCostUsd: 1, estimatePerRunUsd: 1 },
    },
  };
  assert.throws(() => store.createGoal(goal), /applied installation/);
  store.setting("configuration-snapshot", {
    settings: { authority: { maxTotalAdmittedCostUsd: 1 } },
  });
  assert.throws(() => store.createGoal(goal), /concurrency caps/);
  store.setting("configuration-snapshot", {
    settings: {
      authority: { maxTotalAdmittedCostUsd: 1, maxConcurrentMeteredRuns: 1 },
    },
  });
  const results = await Promise.allSettled([
    Promise.resolve().then(() => store.createGoal(goal)),
    Promise.resolve().then(() => store.createGoal(goal)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(store.setting("admitted-cost-usd"), 1);
  assert.equal(store.goals().length, 1);
});

test("Vertex controller revocation fences authentication dispatch and aborts active isolated operations", async (t) => {
  for (const phase of [
    "auth-return",
    "auth-pending",
    "http",
    "stream",
    "tool",
    "pause",
    "generation",
    "deadline",
  ]) {
    await t.test(phase, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "mc-vertex-revocation-"));
      const db = new SqliteStore(join(root, "db"));
      const store = new ControlStore(db);
      t.after(async () => {
        db.close();
        await rm(root, { recursive: true, force: true });
      });
      store.setting("configuration-snapshot", {
        settings: {
          authority: {
            maxConcurrentMeteredRuns: 1,
            maxTotalAdmittedCostUsd: 10,
          },
        },
      });
      const goal = store.createGoal({
        title: "fixture",
        description: "fixture",
        repoPath: root,
        backend: config(),
        executionContract: {
          provider: "vertex",
          harness: "tool-loop",
          execution: "isolated",
          authentication: { kind: "controller", reference: "vertex-test" },
          usagePolicy: { kind: "metered", maxCostUsd: 3, estimatePerRunUsd: 1 },
        },
        maxCostUsd: 3,
        estimatePerRunUsd: 1,
        verificationCommands: ["test -d ."],
      });
      store.installPlan(
        goal.id,
        {
          tasks: [
            {
              key: "one",
              title: "one",
              description: "one",
              allowedPaths: ["**"],
              acceptanceCriteria: ["done"],
            },
          ],
        },
        goal.revision,
      );
      const claim = store.claimNextTask("worker", { goalId: goal.id })!;
      store.transition(
        claim.task.id,
        claim.workerId,
        claim.generation,
        "running",
      );
      const session: any = {
        id: "fixture-session",
        taskId: claim.task.id,
        generation: claim.generation,
        spec: {
          goalId: goal.id,
          workerId: claim.workerId,
          authorityGeneration: claim.generation,
        },
      };
      let dispatches = 0,
        executions = 0,
        activeAborted = false,
        readerCancelled = false;
      let authSignal: AbortSignal | undefined;
      const revoke = () => {
        if (phase === "generation") {
          db.exec(
            `UPDATE control_tasks SET generation=generation+1 WHERE id=${sql(claim.task.id)}`,
          );
        } else {
          const current = store.getGoal(goal.id);
          store.setGoalState(
            goal.id,
            phase === "pause" ? "paused" : "cancelled",
            current.revision,
            "operator",
          );
        }
      };
      const waitForAbort = (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          const stop = () => {
            activeAborted = true;
            reject(signal.reason);
          };
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });
        });
      const p = new VertexProvider(
        config(),
        (async (_url, init) => {
          dispatches++;
          const signal = init!.signal!;
          if (phase === "http") {
            revoke();
            return waitForAbort(signal);
          }
          if (phase === "stream") {
            return new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(
                    new TextEncoder().encode(
                      'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
                    ),
                  );
                  revoke();
                },
                cancel() {
                  readerCancelled = true;
                },
              }),
            );
          }
          return stream([
            terminal([
              {
                functionCall: {
                  name: "read_file",
                  args: { path: "file" },
                  id: "call",
                },
              },
            ]),
          ]);
        }) as typeof fetch,
        async (signal) => {
          authSignal = signal;
          if (phase === "deadline") return waitForAbort(signal);
          if (
            ["auth-return", "auth-pending", "pause", "generation"].includes(
              phase,
            )
          )
            revoke();
          if (phase === "auth-pending") return waitForAbort(signal);
          return { Authorization: "Bearer fixture-token" };
        },
        store.reliability,
        "fixture",
        now,
      );
      const environment: any = {
        async execute(
          _session: string,
          _command: string[],
          signal: AbortSignal,
        ) {
          executions++;
          revoke();
          return waitForAbort(signal);
        },
      };
      const parent = new AbortController();
      const context: any = {
        claim,
        mode: "implement",
        prompt: "fixture",
        signal: parent.signal,
        deadlineAt: Date.now() + (phase === "deadline" ? 40 : 2000),
        onCheckpoint: async () => {},
        executionSessionId: session.id,
      };
      // Keep the test process alive while the authority watch/deadline is unref'ed.
      const keepAlive = setTimeout(() => {}, 2500);
      try {
        await assert.rejects(
          new IsolatedPortableTools(p, environment, session.id, () =>
            assertSessionAuthority(store, session),
          ).run(context),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            if (phase === "deadline") {
              assert.ok(error instanceof ProviderFailure);
              assert.match(error.message, /deadline expired/);
            }
            return true;
          },
        );
      } finally {
        clearTimeout(keepAlive);
      }
      assert.equal(
        parent.signal.aborted,
        false,
        "controller authority changed before scheduler signal propagation",
      );
      assert.equal(
        dispatches,
        ["http", "stream", "tool"].includes(phase) ? 1 : 0,
      );
      assert.equal(executions, phase === "tool" ? 1 : 0);
      if (["auth-pending", "http", "tool", "deadline"].includes(phase)) {
        assert.equal(activeAborted, true);
        assert.equal(authSignal?.aborted, true);
      }
      if (phase === "stream") assert.equal(readerCancelled, true);
      const diagnostic = store.reliability.page("inference_diagnostics")[0];
      assert.equal(diagnostic.providerRequestStarted === true, dispatches > 0);
      if (phase !== "tool") {
        assert.equal(diagnostic.usageStatus, "unknown");
        assert.equal(diagnostic.providerCostUsd, undefined);
      }
      const budget = db.one<any>(
        `SELECT amount,status FROM control_budgets WHERE id=${sql(`${claim.task.id}:${claim.generation}`)}`,
      )!;
      assert.equal(budget.amount, 1);
      assert.ok(
        ["reserved", "unresolved"].includes(budget.status),
        "revocation retains uncertain spending reservation",
      );
    });
  }
});

// These boundaries run in one turn of the event loop: timer/watch delivery
// cannot mask an absent synchronous fence.
test("already-expired invocation cannot authenticate, infer, dispatch tools or complete (finding_39505f35daec4f09889969d3ed4b2eb9)", async () => {
  let auth = 0,
    inference = 0,
    tools = 0,
    checkpoints = 0;
  const provider = new VertexProvider(
    config(),
    (async () => {
      inference++;
      return stream([terminal()]);
    }) as typeof fetch,
    async () => {
      auth++;
      return { Authorization: "Bearer fixture" };
    },
    undefined,
    "fixture",
    now,
  );
  const context: any = {
    signal: new AbortController().signal,
    deadlineAt: Date.now() - 1,
    claim: { task: {}, goal: { config: { estimatePerRunUsd: 1 } } },
    prompt: "fixture",
    mode: "implement",
    onCheckpoint: async () => {
      checkpoints++;
    },
  };
  const backend = new IsolatedPortableTools(
    provider,
    {
      execute: async () => {
        tools++;
        throw Error("unexpected tool");
      },
    } as any,
    "fixture",
    () => {},
  );
  await assert.rejects(
    backend.run(context),
    (e: any) => e.failure?.kind === "deadline",
  );
  await assert.rejects(
    provider.generate(messages, [], context.signal, {
      deadlineAt: context.deadlineAt,
    }),
    (e: any) => e.failure?.kind === "deadline",
  );
  await assert.rejects(
    backend.tool(context, {
      id: "fixture",
      name: "read_file",
      arguments: { path: "fixture" },
    }),
    (e: any) => e.failure?.kind === "deadline",
  );
  assert.deepEqual([auth, inference, tools, checkpoints], [0, 0, 0, 0]);
  assert.equal(deadlineSignal(context.deadlineAt).aborted, true);
});

test("authentication fences OAuth, impersonation and cached acceptance (finding_5e276375b62c4b2a9fabc50268a6069b)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-vertex-auth-fence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "adc.json"),
    JSON.stringify({
      type: "authorized_user",
      client_id: "fixture-client",
      client_secret: "fixture-secret",
      refresh_token: "fixture-refresh",
      quota_project_id: "fixture-quota",
    }),
    { mode: 0o600 },
  );
  let wall = Date.now();
  t.mock.method(Date, "now", () => wall);
  for (const phase of [
    "before-oauth",
    "oauth-return",
    "oauth-body",
    "impersonation-body",
    "cached",
    "deadline-oauth",
    "deadline-cached",
  ]) {
    await t.test(phase, async () => {
      let revoked = false,
        calls = 0,
        cancelled = false;
      const reason = Object.assign(new Error("fixture authority revoked"), {
        code: "stale_claim",
      });
      const deadlineAt = wall + 60000;
      const context = {
        deadlineAt,
        assertAuthority: () => {
          if (revoked) throw reason;
        },
      };
      const body = (value: unknown, change: () => void) =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(value)),
              );
              change(); // body resolves, but authority/deadline changed before acceptance
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      const auth = vertexAuthentication(
        {
          kind: "google-adc",
          reference: { kind: "file", path: "adc.json" },
          egressHosts: [
            "oauth2.googleapis.com",
            "aiplatform.googleapis.com",
            "iamcredentials.googleapis.com",
          ],
          impersonateServiceAccount:
            "fixture@fixture-project.iam.gserviceaccount.com",
        },
        root,
        "fixture-quota",
        () => {},
        (async (url) => {
          calls++;
          if (String(url).includes("oauth2")) {
            if (phase === "oauth-return") revoked = true;
            if (phase === "deadline-oauth") wall = deadlineAt;
            const token = { access_token: "fixture-access", expires_in: 3600 };
            return phase === "oauth-body"
              ? body(token, () => {
                  revoked = true;
                })
              : Response.json(token);
          }
          const token = {
            accessToken: "fixture-impersonated",
            expireTime: new Date(wall + 3500000).toISOString(),
          };
          return phase === "impersonation-body"
            ? body(token, () => {
                revoked = true;
              })
            : Response.json(token);
        }) as typeof fetch,
      );
      const signal = new AbortController().signal;
      if (phase.includes("cached")) {
        await auth(signal, context);
        assert.equal(calls, 2);
        if (phase === "cached") revoked = true;
        else wall = deadlineAt;
      }
      if (phase === "before-oauth") revoked = true;
      await assert.rejects(auth(signal, context), (error: any) =>
        phase.startsWith("deadline")
          ? error.failure?.kind === "deadline"
          : error === reason,
      );
      assert.equal(
        calls,
        phase === "before-oauth"
          ? 0
          : phase.includes("cached") || phase === "impersonation-body"
            ? 2
            : 1,
      );
      if (phase.endsWith("body")) assert.equal(cancelled, true);
    });
  }
});

test("deadline changes between auth, stream, tool and completion stages reject acceptance synchronously", async (t) => {
  let wall = Date.now();
  t.mock.method(Date, "now", () => wall);
  for (const phase of [
    "auth",
    "stream",
    "tool-dispatch",
    "tool-result",
    "completion",
  ]) {
    await t.test(phase, async () => {
      const deadlineAt = wall + 60000;
      let calls = 0,
        executions = 0,
        cancelled = false;
      const provider = new VertexProvider(
        config(),
        (async () => {
          calls++;
          if (phase === "stream")
            return new Response(
              new ReadableStream({
                pull(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify(terminal())}\n\n`,
                    ),
                  );
                  wall = deadlineAt;
                },
                cancel() {
                  cancelled = true;
                },
              }),
            );
          return stream([
            terminal(
              phase.startsWith("tool")
                ? [
                    {
                      functionCall: {
                        name: "read_file",
                        args: { path: "fixture" },
                        id: "fixture",
                      },
                    },
                  ]
                : undefined,
            ),
          ]);
        }) as typeof fetch,
        async () => {
          if (phase === "auth") wall = deadlineAt;
          return { Authorization: "Bearer fixture" };
        },
        undefined,
        "fixture",
        now,
      );
      const context: any = {
        signal: new AbortController().signal,
        deadlineAt,
        claim: {
          generation: 1,
          task: { id: "fixture", spec: { allowedPaths: ["**"] } },
          goal: {
            id: "fixture",
            config: { estimatePerRunUsd: 1, timeoutMs: 60000 },
          },
        },
        prompt: "fixture",
        mode: "implement",
        onCheckpoint: async (summary: string) => {
          if (phase === "tool-dispatch" && summary.startsWith("Starting tool"))
            wall = deadlineAt;
        },
        onProgress: (event: string) => {
          if (phase === "completion" && event === "model_completed")
            wall = deadlineAt;
        },
      };
      const backend = new IsolatedPortableTools(
        provider,
        {
          execute: async () => {
            executions++;
            wall = deadlineAt;
            return { stdout: JSON.stringify({ result: "fixture" }) };
          },
        } as any,
        "fixture",
        () => {},
      );
      await assert.rejects(
        backend.run(context),
        (e: any) => e.failure?.kind === "deadline",
      );
      assert.equal(calls, phase === "auth" ? 0 : 1);
      assert.equal(executions, phase === "tool-result" ? 1 : 0);
      if (phase === "stream") assert.equal(cancelled, true);
    });
  }
});

test("authority watcher terminates active auth, HTTP and isolated tools with deterministic ticks", async (t) => {
  let tick: () => void = () => {
    throw Error("watch not installed");
  };
  t.mock.method(globalThis, "setInterval", (callback: () => void) => {
    tick = callback;
    return { unref() {} };
  });
  t.mock.method(globalThis, "clearInterval", () => {});
  for (const phase of ["auth", "http", "tool"]) {
    await t.test(phase, async () => {
      let revoked = false,
        terminated = false,
        dispatches = 0,
        executions = 0;
      const reason = new Error("fixture authority revoked");
      const active = (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              terminated = true;
              reject(signal.reason);
            },
            { once: true },
          );
          revoked = true;
          tick(); // explicitly deliver a watcher tick while operation is pending
        });
      const provider = new VertexProvider(
        config(),
        (async (_url, init) => {
          dispatches++;
          if (phase === "http") return active(init!.signal!);
          return stream([
            terminal([
              {
                functionCall: {
                  name: "read_file",
                  args: { path: "fixture" },
                  id: "fixture",
                },
              },
            ]),
          ]);
        }) as typeof fetch,
        async (signal) => {
          if (phase === "auth") return active(signal);
          return { Authorization: "Bearer fixture" };
        },
        undefined,
        "fixture",
        now,
      );
      const backend = new IsolatedPortableTools(
        provider,
        {
          execute: async (
            _session: string,
            _command: string[],
            signal: AbortSignal,
          ) => {
            executions++;
            return active(signal);
          },
        } as any,
        "fixture",
        () => {
          if (revoked) throw reason;
        },
      );
      await assert.rejects(
        backend.run({
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 60000,
          claim: {
            generation: 1,
            task: { id: "fixture", spec: { allowedPaths: ["**"] } },
            goal: { id: "fixture", config: { estimatePerRunUsd: 1 } },
          },
          prompt: "fixture",
          mode: "implement",
          onCheckpoint: async () => {},
        } as any),
        (error) => error === reason,
      );
      assert.equal(terminated, true);
      assert.equal(dispatches, phase === "auth" ? 0 : 1);
      assert.equal(executions, phase === "tool" ? 1 : 0);
    });
  }
});
