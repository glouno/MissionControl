import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
// Protocol fixtures inject an explicit transport; production has no host fallback.
const fixtureExecution = (
  workspace: string,
  executable: string,
  env: NodeJS.ProcessEnv = {},
) => ({
  workspace,
  spawn: (command: string, args: string[]) =>
    spawn(executable, args, {
      cwd: workspace,
      env: { PATH: process.env.PATH, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    }),
});
import { SqliteStore, sql } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { ControlClient } from "./client.js";
import { createControlServer } from "./api.js";
import { goalSchema, taskSchema, type Claim } from "./schema.js";
import { ClaudeCodeBackend } from "./claudeCode.js";
import { HumanWait, OwnerWait } from "./backend.js";
import { CodexBackend, parseReview } from "./backends.js";
import { reviewOutputSchema } from "./workerHandoff.js";

const spec = (key: string) =>
  taskSchema.parse({
    key,
    title: key,
    description: key,
    allowedPaths: ["**"],
    acceptanceCriteria: ["Verified"],
  });
async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), "mc-harness-"));
  const db = new SqliteStore(join(root, "state.db"));
  const store = new ControlStore(db);
  let g = store.createGoal({
    title: "Goal",
    description: "Goal",
    repoPath: root,
    backend: { kind: "fake" },
    maxCostUsd: 10,
    estimatePerRunUsd: 1,
  });
  store.installPlan(g.id, { tasks: [spec("a"), spec("b")] }, g.revision);
  g = store.getGoal(g.id);
  return { root, db, store, g };
}
test("switching requires drained paused work, preserves continuation and fences prior ownership", async () => {
  const { db, store, g } = await storeFixture();
  try {
    assert.throws(
      () => store.switchBackend(g.id, { kind: "claude-code" }, g.revision),
      /Pause/,
    );
    const claim = store.claimNextTask("old", { goalId: g.id })!;
    store.checkpoint(claim.task.id, "old", claim.generation, {
      commit: "sha",
      summary: "Durable progress",
      messages: [{ role: "assistant", content: "native" }],
      costUsd: 0.2,
    });
    const paused = store.setGoalState(
      g.id,
      "paused",
      store.getGoal(g.id).revision,
      "test",
    );
    assert.throws(
      () => store.switchBackend(g.id, { kind: "claude-code" }, paused.revision),
      /drain/,
    );
    store.release(
      claim.task.id,
      "old",
      claim.generation,
      "waiting_provider",
      "Quota",
      0.2,
    );
    const attemptsBeforeSwitch = store.getTask(claim.task.id).attempts;
    const switched = store.switchBackend(
      g.id,
      { kind: "fake", model: "alternate-synthetic" },
      paused.revision,
    );
    assert.equal(switched.status, "paused");
    const task = store.getTask(claim.task.id);
    assert.equal(task.status, "pending");
    assert.deepEqual(task.checkpoint, {
      commit: "sha",
      summary: "Durable progress",
      costUsd: 0.2,
    });
    assert.equal(task.attempts, attemptsBeforeSwitch);
    assert.throws(
      () => store.switchBackend(g.id, { kind: "fake" }, paused.revision),
      /Goal changed/,
    );
    assert.throws(() => store.heartbeat(task.id, "old", claim.generation));
    store.setGoalState(g.id, "running", switched.revision, "test");
    const next = store.claimNextTask("new", { goalId: g.id })!;
    assert.equal(next.goal.config.backend.model, "alternate-synthetic");
    assert.ok(
      store.events(0, g.id).some((e) => (e as any).type === "BACKEND_SWITCHED"),
    );
  } finally {
    db.close();
  }
});
test("switch refuses unreconciled side effects and reserved planner/reviewer runs", async () => {
  const { db, store, g } = await storeFixture();
  try {
    const claim = store.claimNextTask("old", { goalId: g.id })!;
    store.checkpoint(claim.task.id, "old", claim.generation, {
      summary: "Interrupted",
      pendingTool: {
        id: "call",
        name: "shell",
        arguments: { command: "migrate" },
      },
    });
    store.release(
      claim.task.id,
      "old",
      claim.generation,
      "retry_wait",
      "Interrupted",
    );
    const paused = store.setGoalState(
      g.id,
      "paused",
      store.getGoal(g.id).revision,
      "test",
    );
    assert.throws(
      () => store.switchBackend(g.id, { kind: "codex" }, paused.revision),
      /Reconcile/,
    );
    db.exec(
      `UPDATE control_tasks SET checkpoint=NULL WHERE id=${sql(claim.task.id)}`,
    );
    db.exec(
      `INSERT INTO control_budgets VALUES('review',${sql(g.id)},NULL,1,NULL,'reserved')`,
    );
    assert.throws(
      () => store.switchBackend(g.id, { kind: "codex" }, paused.revision),
      /drain/,
    );
  } finally {
    db.close();
  }
});
test("backend API enforces operator scope and idempotency", async () => {
  const { db, store, g } = await storeFixture();
  const token = "operator-test-token-0123456789";
  const server = createControlServer(store, { token });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const c = store.claimNextTask("worker", { goalId: g.id })!;
    const worker = new ControlClient(
      url,
      store.createToken("worker", "worker", "worker"),
    );
    const operator = new ControlClient(url, token);
    await assert.rejects(
      worker.switchBackend(g.id, { kind: "fake", model: "fake" }, g.revision),
      (e) => (e as any).status === 403,
    );
    store.release(
      c.task.id,
      "worker",
      c.generation,
      "waiting_provider",
      "Quota",
    );
    const paused = store.setGoalState(
      g.id,
      "paused",
      store.getGoal(g.id).revision,
      "test",
    );
    const first = await operator.switchBackend(
      g.id,
      { kind: "fake", model: "alternate-synthetic" },
      paused.revision,
      "switch",
    );
    const repeated = await operator.switchBackend(
      g.id,
      { kind: "fake", model: "alternate-synthetic" },
      paused.revision,
      "switch",
    );
    assert.deepEqual(first, repeated);
    await assert.rejects(
      operator.switchBackend(
        g.id,
        { kind: "fake", model: "fake" },
        paused.revision,
        "switch",
      ),
      (e) => (e as any).code === "idempotency_conflict",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
});

async function claudeFixture(event: unknown, scriptExtra = "") {
  const root = await mkdtemp(join(tmpdir(), "mc-claude-"));
  const command = join(root, "claude");
  await writeFile(
    command,
    `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nwriteFileSync('args.json',JSON.stringify(process.argv.slice(2)));writeFileSync('provider-env.json',JSON.stringify({foundry:process.env.CLAUDE_CODE_USE_FOUNDRY,resource:process.env.ANTHROPIC_FOUNDRY_RESOURCE,keyPresent:!!process.env.ANTHROPIC_FOUNDRY_API_KEY,tokenPresent:!!process.env.ANTHROPIC_FOUNDRY_AUTH_TOKEN,opus:process.env.ANTHROPIC_DEFAULT_OPUS_MODEL}));\nlet input='';for await(const b of process.stdin)input+=b;writeFileSync('prompt.txt',input);\n${scriptExtra || `console.log(JSON.stringify(${JSON.stringify(event)}));`}\n`,
    { mode: 0o755 },
  );
  const goal = goalSchema.parse({
    title: "Goal",
    description: "Goal",
    repoPath: root,
    backend: { kind: "claude-code", command: "claude" },
    maxCostUsd: 10,
    estimatePerRunUsd: 1,
  });
  const claim = {
    goal: { id: "goal", config: goal },
    task: { id: "task", spec: spec("a") },
    generation: 1,
    workerId: "worker",
  } as Claim;
  const checkpoints: string[] = [];
  const context = {
    claim,
    workspace: root,
    execution: fixtureExecution(root, command),
    mode: "implement" as const,
    prompt: "Implement task",
    signal: new AbortController().signal,
    onCheckpoint: async (summary: string) => {
      checkpoints.push(summary);
    },
  };
  const backend = new ClaudeCodeBackend({
    kind: "claude-code",
    command: "claude",
    maxTurns: 40,
  });
  return { root, context, backend, checkpoints };
}
const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  structured_output: { text: "Implemented", question: null },
  total_cost_usd: 0.1,
  session_id: "session",
  usage: {
    input_tokens: 10,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 5,
    output_tokens: 8,
  },
};
test("Claude Code normalizes structured output, usage, scoped tools and budget", async () => {
  const f = await claudeFixture(result);
  assert.deepEqual(await f.backend.run(f.context), {
    text: "Implemented",
    usage: {
      kind: "metered",
      status: "reported",
      costUsd: 0.1,
      inputTokens: 35,
      outputTokens: 8,
    },
    costUsd: 0.1,
    inputTokens: 35,
    outputTokens: 8,
    sessionId: "session",
  });
  const args = JSON.parse(
    await readFile(join(f.root, "args.json"), "utf8"),
  ) as string[];
  assert.equal(args[args.indexOf("--tools") + 1], "default");
  const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "1");
  assert.ok(f.checkpoints.includes("Implemented"));
  await f.backend.run({ ...f.context, mode: "review" });
  const reviewArgs = JSON.parse(
    await readFile(join(f.root, "args.json"), "utf8"),
  ) as string[];
  assert.equal(reviewArgs[reviewArgs.indexOf("--tools") + 1], "default");
});
test("Claude Code turns explicit questions and denied permissions into durable waits", async () => {
  const q = {
    question: "Deletion policy?",
    reason: "Missing semantics",
    options: [
      { id: "a", label: "Recoverable" },
      { id: "b", label: "Permanent" },
    ],
  };
  const f = await claudeFixture({
    ...result,
    structured_output: { text: "Progress", question: q },
  });
  await assert.rejects(
    f.backend.run(f.context),
    (e) =>
      e instanceof HumanWait &&
      e.request.question === q.question &&
      (e as any).costUsd === 0.1,
  );
  const denied = await claudeFixture({
    ...result,
    permission_denials: [{ tool_name: "Bash" }],
  });
  await assert.rejects(
    denied.backend.run(denied.context),
    (e) => e instanceof HumanWait && e.request.category === "policy",
  );
});
test("Claude Code never treats a missing, malformed or failed result as completion", async () => {
  for (const event of [
    { type: "assistant" },
    { ...result, structured_output: undefined },
    { ...result, subtype: "error_max_turns", is_error: true },
  ]) {
    const f = await claudeFixture(event);
    await assert.rejects(f.backend.run(f.context));
  }
});
test("duplicate Claude terminal results fail closed and retain ambiguous usage evidence", async () => {
  const duplicate = { ...result, total_cost_usd: 0.25 };
  const f = await claudeFixture(
    result,
    `console.log(${JSON.stringify(JSON.stringify(result))});console.log(${JSON.stringify(JSON.stringify(duplicate))});`,
  );
  await assert.rejects(f.backend.run(f.context), (error: any) => {
    assert.match(error.message, /Duplicate Claude Code result/);
    assert.equal(error.costUsd, undefined);
    assert.equal(error.usage.status, "unknown");
    assert.equal(error.terminalEvents[1].costUsd, 0.25);
    assert.equal(error.terminalEvents.length, 2);
    assert.deepEqual(
      error.terminalEvents.map((event: any) => event.hasStructuredOutput),
      [true, true],
    );
    assert.equal(
      JSON.stringify(error.terminalEvents).includes("Implemented"),
      false,
    );
    return true;
  });
});
test("native Claude review returns the schema object directly without prose extraction", async () => {
  const review = { commit: "exact", verdict: "pass", findings: [] };
  const f = await claudeFixture({ ...result, structured_output: review });
  const output = await f.backend.run({
    ...f.context,
    mode: "review",
    outputSchema: reviewOutputSchema,
  });
  assert.deepEqual(parseReview(output.text, "exact"), review);
  const args = JSON.parse(await readFile(join(f.root, "args.json"), "utf8"));
  assert.deepEqual(
    JSON.parse(args[args.indexOf("--json-schema") + 1]),
    reviewOutputSchema,
  );
  assert.throws(() =>
    parseReview(JSON.stringify(review) + "\nExtra prose", "exact"),
  );
});
test("Claude native owner requests retain usage and cannot run during review", async () => {
  const operation = {
    action: "Create fixture service",
    scope: "development",
    reason: "Tests require it",
    idempotencyKey: "fixture-1",
  };
  const f = await claudeFixture({
    ...result,
    structured_output: {
      text: "Progress saved",
      question: null,
      ownerOperation: operation,
    },
  });
  await assert.rejects(
    f.backend.run(f.context),
    (e) =>
      e instanceof OwnerWait &&
      e.request.idempotencyKey === "fixture-1" &&
      (e as any).costUsd === 0.1,
  );
  await assert.rejects(
    f.backend.run({ ...f.context, mode: "review" }),
    /only during coding/,
  );
});
test("Claude Code cancellation terminates its child instead of accepting partial output", async () => {
  const f = await claudeFixture(
    {},
    "console.log(JSON.stringify({type:'system'}));setInterval(()=>{},1000);",
  );
  const abort = new AbortController();
  const running = f.backend.run({ ...f.context, signal: abort.signal });
  const timer = setTimeout(
    () => abort.abort(new Error("Test cancellation")),
    100,
  );
  await assert.rejects(running, /Test cancellation/);
  clearTimeout(timer);
});

test("schedule configuration mutations use operator API authority and durable events", async () => {
  const { db, store, g } = await storeFixture();
  const token = "operator-test-token-0123456789";
  const server = createControlServer(store, { token });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const operator = new ControlClient(url, token);
  const worker = new ControlClient(
    url,
    store.createToken("worker", "worker", "worker"),
  );
  const body = {
    config: g.config,
    intervalMs: 60000,
    timezone: "UTC",
  };
  try {
    await assert.rejects(
      worker.request("/schedules", "POST", body),
      (e) => (e as any).status === 403,
    );
    const first = await operator.request("/schedules", "POST", body, "daily");
    assert.deepEqual(
      await operator.request("/schedules", "POST", body, "daily"),
      first,
    );
    assert.equal(store.schedules().length, 1);
    await assert.rejects(
      operator.request("/schedules", "POST", {
        ...body,
        config: { ...g.config, policy: { autoMerge: true } },
      }),
      (e) => (e as any).code === "policy",
    );
    assert.ok(
      store.events().some((e) => (e as any).type === "SCHEDULE_CREATED"),
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
});

test("native harnesses refuse ambient host execution and credentials", async () => {
  const f = await claudeFixture(result);
  const context = { ...f.context, execution: undefined };
  await assert.rejects(f.backend.run(context), /isolated execution/);
  await assert.rejects(
    new CodexBackend({ kind: "codex", command: "codex" }).run(context),
    /isolated execution/,
  );
});

test("Codex planning uses final output instead of progress commentary", async () => {
  const root = await mkdtemp(join(tmpdir(), "mc-codex-final-"));
  const command = join(root, "codex-stub");
  await writeFile(
    command,
    `#!/usr/bin/env node
+import {createInterface} from 'node:readline';
+const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
+for await (const line of createInterface({input:process.stdin})) {
+  const m = JSON.parse(line);
+  if (m.method==='initialize') send({id:m.id,result:{}});
+  if (m.method==='thread/start') send({id:m.id,result:{thread:{id:'fixture'}}});
+  if (m.method==='turn/start') {
+    await (await import('node:fs/promises')).writeFile('turn.json',JSON.stringify(m.params));
+    send({id:m.id,result:{}});
+    send({method:'item/completed',params:{item:{type:'agentMessage',phase:'commentary',text:'I will inspect the repository.'}}});
+    send({method:'item/completed',params:{item:{type:'agentMessage',phase:'final_answer',text:'{"tasks":[]}'}}});
+    send({method:'item/completed',params:{item:{type:'agentMessage',phase:'commentary',text:'Trailing progress'}}});
+    send({method:'turn/completed',params:{turn:{status:'completed'}}});
+  }
+}
+`.replace(/^\+/gm, ""),
    { mode: 0o755 },
  );
  const backend = new CodexBackend({ kind: "codex", command: "codex" });
  const output = await backend.run({
    claim: {
      goal: {
        config: goalSchema.parse({
          title: "Plan",
          description: "Plan",
          repoPath: root,
        }),
      },
    } as Claim,
    workspace: root,
    execution: fixtureExecution(root, command),
    mode: "plan",
    outputSchema: { type: "object", properties: { tasks: { type: "array" } } },
    prompt: "Return JSON",
    signal: AbortSignal.timeout(5000),
    onCheckpoint: async () => {},
  });
  assert.deepEqual(JSON.parse(output.text), { tasks: [] });
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "turn.json"), "utf8")).outputSchema,
    { type: "object", properties: { tasks: { type: "array" } } },
  );
});
test("Codex registers scoped handoff tools and stops on validated owner request", async () => {
  const root = await mkdtemp(join(tmpdir(), "mc-codex-owner-"));
  const command = join(root, "codex-stub");
  await writeFile(
    command,
    `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
for await (const line of createInterface({input:process.stdin})) {
  const m=JSON.parse(line);
  if (m.method==='initialize') {writeFileSync(${JSON.stringify(join(root, "initialize.json"))}, JSON.stringify(m.params));send({id:m.id,result:{}});}
  if (m.method==='thread/start') {writeFileSync(${JSON.stringify(join(root, "thread.json"))}, JSON.stringify(m.params));send({id:m.id,result:{thread:{id:'fixture'}}});}
  if (m.method==='turn/start') {
    send({id:m.id,result:{}});
    send({id:100,method:'item/tool/call',params:{threadId:'wrong',tool:'missioncontrol_owner_operation',arguments:{}}});
  }
  if (m.id===100) {
    if (m.result.success) process.exit(2);
    send({id:101,method:'item/tool/call',params:{threadId:'fixture',tool:'missioncontrol_owner_operation',arguments:{action:'Create fixture',scope:'development',reason:'Test endpoint',idempotencyKey:'fixture-1'}}});
  }
}
`,
    { mode: 0o755 },
  );
  const backend = new CodexBackend({ kind: "codex", command: "codex" });
  await assert.rejects(
    backend.run({
      claim: {
        goal: {
          config: goalSchema.parse({
            title: "Task",
            description: "Task",
            repoPath: root,
          }),
        },
      } as Claim,
      workspace: root,
      execution: fixtureExecution(root, command),
      mode: "implement",
      prompt: "Request endpoint",
      signal: AbortSignal.timeout(5000),
      onCheckpoint: async () => {},
    }),
    (e) => e instanceof OwnerWait && e.request.idempotencyKey === "fixture-1",
  );
  assert.equal(
    JSON.parse(await readFile(join(root, "initialize.json"), "utf8"))
      .capabilities.experimentalApi,
    true,
  );
  const thread = JSON.parse(await readFile(join(root, "thread.json"), "utf8"));
  assert.deepEqual(
    thread.dynamicTools.map((t: any) => t.name),
    ["missioncontrol_question", "missioncontrol_owner_operation"],
  );
});

test("controller-reserved Claude repair cannot emit human or owner task handoffs", async () => {
  const f = await claudeFixture({
    ...result,
    structured_output: {
      text: "need help",
      question: {
        question: "Choose?",
        reason: "fixture",
        options: [
          { id: "wait", label: "Wait" },
          { id: "continue", label: "Continue" },
        ],
      },
      ownerOperation: null,
    },
  });
  await assert.rejects(
    f.backend.run({
      ...f.context,
      mode: "implement",
      disableTaskHandoffs: true,
    }),
    /cannot issue task handoffs/,
  );
});
