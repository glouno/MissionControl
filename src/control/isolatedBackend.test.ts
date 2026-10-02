import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../sqlite.js";
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
  return { context, registry, env, db, source, stopped, checkpoints, backend };
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
