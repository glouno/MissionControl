import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, sql } from "../sqlite.js";
import { git } from "./git.js";
import { EnvironmentRegistry, FakeEnvironment } from "./environments.js";
import { InferenceGateway } from "./inferenceGateway.js";
import { IsolatedBackend } from "./isolatedBackend.js";
import { HumanWait, OwnerWait } from "./backend.js";
import { goalSchema } from "./schema.js";
import { dockerNativeExecution } from "./nativeExecution.js";
async function fixture(t: any, mode: "implement" | "review" = "implement") {
  const root = await mkdtemp(join(tmpdir(), "mc-isolated-backend-")),
    source = join(root, "trusted");
  await mkdir(source);
  await git(source, ["init", "-b", "task"]);
  await writeFile(join(source, "base"), "base");
  await git(source, ["add", "."]);
  await git(source, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "base",
  ]);
  const registry = new EnvironmentRegistry(join(root, "managed")),
    env = new FakeEnvironment(registry),
    db = new SqliteStore(join(root, "gateway.db"));
  const gateway = new InferenceGateway(
    db,
    {
      fixture: {
        protocol: "messages",
        endpoint: "https://fixture.invalid/messages",
        headers: async () => ({}),
      },
    },
    () => {},
  );
  const stopped: string[] = [],
    checkpoints: string[] = [];
  const networks = {
    acquire: async (spec: any) => ({ ...spec, network: "fixture" }),
    stop: async (id: string) => {
      stopped.push(id);
    },
  };
  // Fake execution does not attach a network; real gateway lifecycle is separately tested.
  const originalAcquire = env.acquire.bind(env);
  env.acquire = async (id) => {
    const s = registry.get(id);
    registry.save({ ...s, spec: { ...s.spec, gatewayNetwork: undefined } });
    return originalAcquire(id);
  };
  const config = goalSchema.parse({
    title: "fixture",
    description: "fixture",
    repoPath: source,
    backend: { kind: "claude-code", model: "claude-opus-5-5" },
    estimatePerRunUsd: 1,
  });
  const context: any = {
    workspace: source,
    mode,
    prompt: "task",
    signal: new AbortController().signal,
    claim: {
      goal: { id: "goal", config },
      task: {
        id: "task",
        spec: { cpuUnits: 1, memoryMiB: 512, allowedPaths: ["one"] },
      },
      generation: 1,
    },
    onCheckpoint: async (s: string) => {
      checkpoints.push(s);
    },
  };
  const options = {
    imageDigest: `sha256:${"a".repeat(64)}`,
    provider: "fixture",
    socketDirectory: root,
    relayScript: join(root, "relay.py"),
    assertLease: () => {},
    transport: () => ({
      workspace: "/workspace",
      spawn: () => {
        throw new Error("fixture doesn't spawn");
      },
    }),
  };
  const backend = (run: any) =>
    new IsolatedBackend(env, registry, networks as any, gateway, {
      ...options,
      backend: { run },
    });
  t.after(async () => {
    registry.db.close();
    db.close();
    await rm(root, { recursive: true });
  });
  return {
    context,
    registry,
    env,
    db,
    source,
    stopped,
    checkpoints,
    backend,
    gateway,
  };
}
test("isolated coding imports scoped source only after stopping and retains evidence for recovery", async (t) => {
  const f = await fixture(t);
  const b = f.backend(async (c: any) => {
    assert.equal(c.execution.workspace, "/workspace");
    assert.equal(c.workspace, f.source);
    const s = f.registry.all().at(-1)!;
    await writeFile(join(s.path, "one"), "worker\n");
    await c.onCheckpoint("done");
    return { text: "done", costUsd: 0.1, inputTokens: 1, outputTokens: 2 };
  });
  const result = await b.run(f.context);
  assert.equal(await readFile(join(f.source, "one"), "utf8"), "worker\n");
  assert.ok(result.executionSessionId);
  assert.equal(
    f.registry.get(result.executionSessionId!).status,
    "checkpointed",
  );
  assert.equal(f.registry.get(result.executionSessionId!).container, undefined);
  assert.equal(
    f.registry.get(result.executionSessionId!).spec.gatewayEnv,
    undefined,
  );
  assert.equal(f.stopped.length, 1);
  assert.deepEqual(f.checkpoints, ["done"]);
  await git(f.source, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "accepted",
  ]);
  await b.run(f.context);
  assert.equal(f.registry.all().length, 2);
});

test("successful isolated invocation does not consume terminal attempt cleanup allowance", async (t) => {
  const f = await fixture(t, "review");
  let terminalCleanupCalls = 0;
  f.context.cleanupSignal = () => {
    terminalCleanupCalls++;
    return AbortSignal.abort(
      new Error("terminal cleanup must not run on success"),
    );
  };
  const result = await f
    .backend(async () => ({ text: "reviewed", costUsd: 0.1 }))
    .run(f.context);
  assert.ok(result.executionSessionId);
  assert.equal(terminalCleanupCalls, 0);
  assert.equal(f.registry.get(result.executionSessionId!).container, undefined);
});

test("isolated Codex configuration honors admitted reasoning effort", async (t) => {
  const f = await fixture(t, "review");
  f.context.claim.goal.config.backend = {
    kind: "codex",
    model: "synthetic",
    reasoningEffort: "low",
  };
  f.gateway.upstreams.fixture.protocol = "responses";
  let toml = "";
  f.env.execute = async (_id, command) => {
    const encoded = command[2].match(/write_text\((.*)\)$/)![1];
    toml = JSON.parse(encoded);
    return { stdout: "", stderr: "" };
  };
  await f
    .backend(async () => ({ text: "reviewed", costUsd: 0.1 }))
    .run(f.context);
  assert.match(toml, /model_reasoning_effort = "low"/);
  assert.match(toml, /model_provider = "missioncontrol"/);
});

test("failed isolated invocation shares terminal cleanup with its caller", async (t) => {
  const f = await fixture(t, "review");
  let terminalCleanupCalls = 0;
  f.context.cleanupSignal = () => {
    terminalCleanupCalls++;
    return new AbortController().signal;
  };
  await assert.rejects(
    f
      .backend(async () => {
        throw new Error("synthetic failure");
      })
      .run(f.context),
    /synthetic failure/,
  );
  assert.equal(terminalCleanupCalls, 1);
});
test("human waits preserve scoped progress and release execution and inference", async (t) => {
  const f = await fixture(t);
  const b = f.backend(async (c: any) => {
    await writeFile(join(f.registry.all()[0].path, "one"), "progress");
    await c.onCheckpoint("waiting");
    throw new HumanWait({
      question: "Which behavior?",
      reason: "decision",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });
  });
  await assert.rejects(b.run(f.context), HumanWait);
  assert.equal(await readFile(join(f.source, "one"), "utf8"), "progress");
  assert.equal(f.stopped.length, 1);
  assert.equal(f.registry.all()[0].container, undefined);
  assert.ok(
    JSON.parse(
      f.db.one<{ record: string }>("SELECT record FROM inference_capabilities")!
        .record,
    ).revoked,
  );
});
test("review mutation and stale import never alter trusted source", async (t) => {
  const f = await fixture(t, "review");
  const b = f.backend(async () => {
    await writeFile(
      join(f.registry.all()[0].path, "one"),
      "untrusted review write",
    );
    return { text: "pass", costUsd: 0, inputTokens: 0, outputTokens: 0 };
  });
  await assert.rejects(b.run(f.context), /review changed/);
  await assert.rejects(readFile(join(f.source, "one")));
  assert.equal(f.stopped.length, 1);
});
test("owner waits import progress without commentary and stop execution before propagation", async (t) => {
  const f = await fixture(t);
  const b = f.backend(async () => {
    await writeFile(
      join(f.registry.all()[0].path, "one"),
      "owner-wait progress",
    );
    throw new OwnerWait({
      action: "Provision fixture",
      scope: "development",
      reason: "Blocked test",
      idempotencyKey: "fixture-1",
    });
  });
  await assert.rejects(b.run(f.context), OwnerWait);
  assert.equal(
    await readFile(join(f.source, "one"), "utf8"),
    "owner-wait progress",
  );
  assert.equal(f.registry.all()[0].container, undefined);
  assert.equal(f.registry.all()[0].spec.gatewayEnv, undefined);
  assert.equal(f.stopped.length, 1);
});
test("expired execution lease retains private work and prevents trusted import", async (t) => {
  const f = await fixture(t);
  let valid = true;
  const b = f.backend(async () => {
    await writeFile(join(f.registry.all()[0].path, "one"), "unfinished");
    valid = false;
    return { text: "done", costUsd: 0, inputTokens: 0, outputTokens: 0 };
  });
  b.options.assertLease = () => {
    if (!valid) throw new Error("stale lease");
  };
  await assert.rejects(b.run(f.context), /stale lease/);
  await assert.rejects(readFile(join(f.source, "one")));
  assert.equal(
    await readFile(join(f.registry.all()[0].path, "one"), "utf8"),
    "unfinished",
  );
  assert.equal(f.registry.all()[0].container, undefined);
  assert.equal(f.stopped.length, 1);
});
test("native transport accepts pinned harness names and forwards no host environment", () => {
  const calls: any[] = [];
  const session: any = {
    id: "session",
    taskId: "task",
    generation: 1,
    status: "active",
    container: "mc-session",
  };
  let current = true;
  const transport = dockerNativeExecution(
    session,
    () => {
      if (!current) throw new Error("stale");
    },
    ((...args: any[]) => {
      calls.push(args);
      return {};
    }) as any,
  );
  transport.spawn("claude", ["--print"]);
  assert.deepEqual(calls[0][1], [
    "exec",
    "-i",
    "mc-session",
    "claude",
    "--print",
  ]);
  assert.deepEqual(Object.keys(calls[0][2].env), ["PATH"]);
  assert.throws(() => transport.spawn("/host/claude", []), /pinned image/);
  current = false;
  assert.throws(() => transport.spawn("codex", []), /stale/);
});
test("goal-level review uses its controller reservation while execution has a positive generation", async (t) => {
  const f = await fixture(t, "review");
  f.context.claim.generation = 0;
  const generations: number[] = [];
  const b = f.backend(async () => ({
    text: "pass",
    costUsd: 0.1,
    inputTokens: 1,
    outputTokens: 1,
  }));
  b.options.assertLease = (_task, generation) => {
    generations.push(generation);
  };
  const result = await b.run(f.context);
  assert.equal(f.registry.get(result.executionSessionId!).generation, 1);
  assert.ok(generations.every((g) => g === 0));
});

test("portable isolation avoids worker inference network and persists continuation intent before tools", async (t) => {
  const f = await fixture(t);
  f.context.claim.goal.config.backend = {
    kind: "bedrock",
    model: "synthetic",
    region: "eu-west-1",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
  };
  let continuation = false;
  f.context.onContinuation = async () => {
    continuation = true;
  };
  const b = f.backend(async (c: any) => {
    await c.onCheckpoint(
      "Before tool",
      [{ role: "user", content: "synthetic" }],
      { id: "tool", name: "shell", arguments: { command: "synthetic" } },
      0.1,
    );
    assert.equal(continuation, true);
    assert.equal(c.execution, undefined);
    assert.equal(f.registry.all()[0].spec.gatewayNetwork, undefined);
    return { text: "synthetic", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
  });
  await b.run(f.context);
  assert.equal(f.stopped.length, 0);
  assert.equal(f.db.query("SELECT * FROM inference_capabilities").length, 0);
});

for (const cleanupFails of [false, true])
  for (const priced of [true, false])
    test(`failed Codex invocation retains provider counters with ${priced ? "estimated" : "unknown"} billing and cleanup ${cleanupFails ? "fails" : "succeeds"}`, async (t) => {
      const f = await fixture(t, "review");
      f.context.claim.goal.config.backend = {
        kind: "codex",
        model: "gpt-6.1-sol",
      };
      f.gateway.upstreams.fixture.protocol = "responses";
      if (cleanupFails)
        f.env.reset = async () => {
          throw new Error("synthetic reset failure");
        };
      const b = f.backend(async () => {
        const sessionId = f.registry.all().at(-1)!.id;
        const record = {
          sessionId,
          complete: false,
          usage: { input_tokens: 100, output_tokens: 10 },
          costUsd: priced ? 0.0003 : null,
        };
        f.db.exec(
          `INSERT INTO inference_usage(capability_hash,record,created_at) VALUES('fixture',${sql(JSON.stringify(record))},1)`,
        );
        throw new Error("incomplete provider response");
      });
      await assert.rejects(b.run(f.context), (error: any) => {
        if (cleanupFails) assert.equal(error.failure.kind, "cleanup_blocked");
        else assert.equal(error.message, "incomplete provider response");
        assert.equal(error.usage.status, priced ? "estimated" : "unknown");
        assert.equal(error.usage.inputTokens, 100);
        assert.equal(error.usage.outputTokens, 10);
        assert.equal(error.costUsd, priced ? 0.0003 : undefined);
        assert.equal(error.usage.costUsd, error.costUsd);
        return true;
      });
    });

test("native Vertex uses existing isolated controller tool execution without cloud worker environment", async (t) => {
  const { VertexProvider } = await import("./vertexProvider.js");
  const { vertexBackendSchema } = await import("./vertexConfig.js");
  const f = await fixture(t);
  const config = vertexBackendSchema.parse({
    kind: "vertex",
    project: "fixture-project",
    quotaProject: "fixture-quota",
    location: "global",
    model: "gemini-4-argon",
    thinkingLevel: "low",
    maxInputTokens: 8192,
    maxOutputTokens: 1024,
    maxRequestCostUsd: 1,
    pricing: [
      {
        version: "fixture",
        currency: "USD",
        effectiveFrom: "2026-01-01T00:00:00Z",
        effectiveUntil: "2027-01-01T00:00:00Z",
        inputUsdPerMillion: 1,
        cachedInputUsdPerMillion: 0.1,
        outputUsdPerMillion: 2,
        thinkingUsdPerMillion: 2,
        evidenceUrl: "https://example.invalid/pricing",
      },
    ],
  });
  f.context.claim.goal.config.backend = config;
  let calls = 0,
    tools = 0;
  const provider = new VertexProvider(
    config,
    (async (_url, init) => {
      calls++;
      assert.equal(
        (init?.headers as any).Authorization,
        "Bearer controller-only-fixture",
      );
      const body = JSON.parse(String(init?.body));
      if (calls === 2)
        assert.equal(
          body.contents.at(-1).parts[0].functionResponse.name,
          "read_file",
        );
      return new Response(
        `data: ${JSON.stringify({ modelVersion: "gemini-4-argon", candidates: [{ content: { role: "model", parts: calls === 1 ? [{ functionCall: { name: "read_file", args: { path: "base" } }, thoughtSignature: "opaque-fixture" }] : [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 0, totalTokenCount: 110 } })}\n\n`,
      );
    }) as typeof fetch,
    async () => ({ Authorization: "Bearer controller-only-fixture" }),
    undefined,
    "fixture",
    () => Date.parse("2026-10-21T00:00:00Z"),
  );
  const b = f.backend(async () => {
    throw Error("must use portable provider");
  });
  delete b.options.backend;
  b.options.portableProvider = provider;
  f.env.execute = async (_id, command, signal) => {
    signal.throwIfAborted();
    tools++;
    assert.equal(command[0], "python3");
    assert.equal(command.join(" ").includes("controller-only-fixture"), false);
    assert.equal(JSON.parse(command[3]!).name, "read_file");
    return {
      exitCode: 0,
      stdout: JSON.stringify({ result: "base" }),
      stderr: "",
    };
  };
  const result = await b.run(f.context);
  assert.equal(result.text, "done");
  assert.equal(calls, 2);
  assert.equal(tools, 1);
  assert.equal(f.registry.all()[0].spec.gatewayNetwork, undefined);
  assert.equal(f.registry.all()[0].spec.gatewayEnv, undefined);
  assert.equal(f.db.query("SELECT * FROM inference_capabilities").length, 0);
});
