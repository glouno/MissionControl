import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  SubscriptionNativeBackend,
  subscriptionUsage,
} from "./subscriptionNative.js";
import { HumanWait } from "./backend.js";
import { goalSchema } from "./schema.js";
function fixture(
  t: any,
  harness: "codex" | "claude-code",
  events: unknown[],
  extra = "",
) {
  const args: string[][] = [],
    checkpoints: string[] = [],
    children: ReturnType<typeof spawn>[] = [];
  t.after(() => {
    for (const p of children) p.kill("SIGKILL");
  });
  const config = goalSchema.parse({
    title: "synthetic",
    description: "synthetic",
    repoPath: "/tmp/synthetic",
    backend: { kind: harness },
    maxCostUsd: 0,
    estimatePerRunUsd: 0,
    maxWorkers: 1,
    maxAttempts: 2,
    timeoutMs: 1000,
    executionContract: {
      harness,
      provider:
        harness === "codex" ? "codex-subscription" : "claude-subscription",
      authentication: { kind: "session", reference: "synthetic" },
      execution: "isolated",
      usagePolicy: {
        kind: "subscription",
        maxAttempts: 2,
        timeoutMs: 1000,
        maxConcurrency: 1,
      },
    },
  });
  return {
    args,
    checkpoints,
    context: {
      claim: { goal: { config }, task: {} },
      mode: "implement",
      prompt: "synthetic",
      signal: new AbortController().signal,
      onCheckpoint: async (text: string) => {
        checkpoints.push(text);
      },
      execution: {
        workspace: "/workspace",
        spawn: (_command: string, argv: string[]) => {
          args.push(argv);
          const child = spawn(
            process.execPath,
            [
              "-e",
              `process.stdin.resume();process.stdin.on('end',()=>{${events.map((e) => `console.log(${JSON.stringify(JSON.stringify(e))});`).join("")}${extra}});`,
            ],
            { stdio: ["pipe", "pipe", "pipe"], detached: true },
          );
          children.push(child);
          return child;
        },
      },
    } as any,
  };
}
const final = {
  text: "synthetic completion",
  question: null,
  ownerOperation: null,
};
const codex = [
  { type: "thread.started", thread_id: "synthetic" },
  {
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(final) },
  },
  {
    type: "turn.completed",
    usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 3 },
  },
];
const claude = [
  {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "synthetic",
    structured_output: final,
    total_cost_usd: 900,
    usage: {
      input_tokens: 8,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 2,
      output_tokens: 3,
    },
  },
];
test("subscription native adapters report tokens without dollars and select clean configuration flags", async (t) => {
  for (const [harness, events] of [
    ["codex", codex],
    ["claude-code", claude],
  ] as const) {
    const f = fixture(t, harness, [...events]);
    const result = await new SubscriptionNativeBackend().run(f.context);
    assert.equal(result.text, final.text);
    assert.equal(result.costUsd, undefined);
    assert.equal(result.usage?.kind, "subscription");
    assert.equal((result.usage as any).status, "reported");
    assert.equal(
      (result.usage as any).inputTokens,
      harness === "codex" ? 12 : 14,
    );
    assert.ok(!f.args[0].includes("--max-budget-usd"));
    assert.ok(
      f.args[0].includes(
        harness === "codex" ? "--ignore-user-config" : "--safe-mode",
      ),
    );
    assert.deepEqual(f.checkpoints, [final.text]);
  }
});
test("missing and partial subscription counters remain explicit; malformed counters refuse acceptance", async (t) => {
  assert.deepEqual(subscriptionUsage("codex", undefined), {
    kind: "subscription",
    status: "unknown",
  });
  assert.deepEqual(
    subscriptionUsage("claude-code", { input_tokens: 12, output_tokens: 0 }),
    { kind: "subscription", status: "reported", outputTokens: 0 },
  );
  assert.throws(() => subscriptionUsage("codex", { input_tokens: -1 }));
  const f = fixture(
    t,
    "codex",
    codex.slice(0, 2).concat({ type: "turn.completed" } as any),
  );
  const result = await new SubscriptionNativeBackend().run(f.context);
  assert.equal((result.usage as any).status, "unknown");
  assert.equal((result.usage as any).inputTokens, undefined);
});
test("duplicate terminals, post-terminal activity, invalid protocol and missing results never produce checkpoints", async (t) => {
  for (const events of [
    [...codex, codex[2]],
    [...codex, codex[1]],
    [...claude, ...claude],
    codex.slice(0, 2),
    [{ type: "turn.failed", error: { message: "private diagnostic" } }],
  ]) {
    const harness =
      (events[0] as any).type === "result" ? "claude-code" : "codex";
    const f = fixture(t, harness, events);
    await assert.rejects(
      new SubscriptionNativeBackend().run(f.context),
      (error) => {
        assert.equal((error as any).usage.kind, "subscription");
        assert.ok(!String(error).includes("private diagnostic"));
        return true;
      },
    );
    assert.deepEqual(f.checkpoints, []);
  }
  const f = fixture(t, "codex", [], "console.log('not json')");
  await assert.rejects(
    new SubscriptionNativeBackend().run(f.context),
    /protocol/,
  );
});
test("time, output and unavailable/exceeded token limits fail closed", async (t) => {
  const timed = fixture(t, "codex", [], "setInterval(()=>{},1000)");
  await assert.rejects(
    new SubscriptionNativeBackend().run(timed.context),
    /time limit/,
  );
  const output = fixture(
    t,
    "codex",
    [],
    // Keep the owned group alive until the adapter enforces the output limit.
    // Immediate exit races buffered output against process-group teardown on macOS.
    "process.stdout.write('x'.repeat(8*1024*1024+1));setInterval(()=>{},1000)",
  );
  await assert.rejects(
    new SubscriptionNativeBackend().run(output.context),
    /output limit|protocol/,
  );
  for (const events of [
    codex,
    codex.slice(0, 2).concat({ type: "turn.completed" } as any),
  ]) {
    const f = fixture(t, "codex", events);
    f.context.claim.goal.config.executionContract.usagePolicy.maxReportedTokens = 2;
    await assert.rejects(
      new SubscriptionNativeBackend().run(f.context),
      /token limit/,
    );
    assert.deepEqual(f.checkpoints, []);
  }
});
test("subscription structured handoffs retain non-dollar usage; host fallback and policy mismatches refuse spawn", async (t) => {
  const q = {
    question: "Synthetic choice?",
    reason: "synthetic",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  };
  const f = fixture(t, "claude-code", [
    { ...claude[0], structured_output: { ...final, question: q } },
  ]);
  await assert.rejects(
    new SubscriptionNativeBackend().run(f.context),
    (error) =>
      error instanceof HumanWait &&
      (error as any).usage.kind === "subscription" &&
      (error as any).costUsd === undefined,
  );
  const noHost = fixture(t, "codex", codex);
  delete noHost.context.execution;
  await assert.rejects(
    new SubscriptionNativeBackend().run(noHost.context),
    /isolated execution/,
  );
  assert.deepEqual(noHost.args, []);
});
