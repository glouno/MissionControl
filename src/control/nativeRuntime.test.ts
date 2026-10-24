import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { git } from "./git.js";
import { goalSchema, type Goal, inputPlanSchema } from "./schema.js";
import { NativeRuntime, nativePreflight } from "./nativeRuntime.js";
import {
  nativeProfileSchema,
  nativeBinding,
  nativeEnvironment,
} from "./nativeConfig.js";
import { observedBackend, InvocationStore } from "./invocations.js";
import {
  processIdentity,
  ownedGroup,
  nativeCommand,
  cleanupNativeProcess,
} from "./nativeProcess.js";
import { createControlServer } from "./api.js";
import { Scheduler } from "./scheduler.js";
import { StorageManager } from "./storage.js";
import { executionContractSchema } from "./executionContract.js";
import { CodexEvents } from "./nativeCodex.js";

test.mock.method(StorageManager.prototype, "pressure", async () => ({
  freeBytes: 100 * 1024 ** 3,
  reserveBytes: 50 * 1024 ** 3,
  admissionAllowed: true,
}));
async function fixture(t: test.TestContext, scenario = "") {
  const root = await mkdtemp(join(tmpdir(), "mc-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-b", "development"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  const executable = join(root, "codex-fixture");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const a=process.argv.slice(2);
if(a.includes('--version')){console.log('codex-cli fixture');process.exit(0)}
if(a.includes('login')){console.log('Logged in using ChatGPT');process.exit(0)}
let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
console.log(JSON.stringify({type:'thread.started',thread_id:a.includes('resume')?a[a.indexOf('resume')+1]:'fixture-'+process.pid}));
console.log(JSON.stringify({type:'turn.started'}));
if(input.includes('WAIT_FOREVER')){setInterval(()=>{},1000);return}
if(input.includes('MALFORMED')){console.log('invalid json');return}
if(input.includes('QUOTA')){console.log(JSON.stringify({type:'turn.failed',error:{message:'You have hit your usage limit'}}));return}
if(input.includes('DUPLICATE')){console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:10}}));}

const schema=JSON.parse(fs.readFileSync(a[a.indexOf('--output-schema')+1]));let result;
if(schema.properties.commit){result={commit:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),verdict:fs.readFileSync('one.txt','utf8')==='review-bug'?'fail':'pass',findings:fs.readFileSync('one.txt','utf8')==='review-bug'?[{summary:'Remove review-bug',blocking:true,evidence:'one.txt'}]:[],resolvedObservations:null};}
else {fs.writeFileSync('one.txt',!a.includes('resume')&&input.includes('CHECK_REPAIR')?'broken':!a.includes('resume')&&input.includes('REVIEW_REPAIR')?'review-bug':'implemented');result={text:'Implemented',question:null,ownerOperation:null};}
fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify(result));
fs.writeFileSync(${JSON.stringify(join(root, "last-args.json"))},JSON.stringify({args:a,env:process.env}));
console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:40,output_tokens:10}}));
});`,
    { mode: 0o700 },
  );
  const db = new SqliteStore(join(root, "state.db"));
  t.after(() => db.close());
  const store = new ControlStore(db);
  store.setting("scheduler-limits", {
    workers: 2,
    cpu: 4,
    memoryMiB: 16384,
    providerWorkers: 2,
    repositoryWorkers: 2,
  });
  const profile = nativeProfileSchema.parse({
    executable,
    codexHome: join(root, "codex-home"),
    home: root,
    path: process.env.PATH,
    permissions: "devbox",
  });
  let config = goalSchema.parse({
    title: "Native",
    description: "Implement one",
    repoPath: repo,
    repository: { mode: "local", branch: "development" },
    backend: { kind: "codex", model: "fixture", reasoningEffort: "low" },
    verificationCommands: [
      scenario === "CHECK_REPAIR"
        ? 'test "$(cat one.txt)" = implemented'
        : "test -f one.txt",
    ],
    maxWorkers: 1,
    executionContract: {
      harness: "codex",
      provider: "codex-subscription",
      execution: "native",
      authentication: { kind: "local", reference: "fixture" },
      usagePolicy: { kind: "observed" },
    },
    admission: {
      configurationHash: "a".repeat(64),
      executionMode: "native",
      nativeProfile: profile,
      prompts: [],
    },
  });
  config.admission!.runtimeHash = nativeBinding(config);
  const runtime = new NativeRuntime(store, root);
  const g = store.createGoal(config);
  store.installPlan(
    g.id,
    {
      tasks: [
        {
          key: "one",
          title: "One",
          description: "Implement one.txt " + scenario,
          allowedPaths: ["one.txt"],
          acceptanceCriteria: ["exists"],
          verificationCommands: config.verificationCommands,
        },
      ],
    },
    g.revision,
  );
  const goal = store.getGoal(g.id);
  return { root, repo, store, runtime, goal, db, profile };
}

test("native explicit task completes through separate checks and review without Docker", async (t) => {
  const f = await fixture(t);
  let scheduler: Scheduler;
  const token = "native-test-operator-0123456789";
  const server = createControlServer(f.store, {
    token,
    onResult: (...args) => scheduler.result(...args),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  scheduler = new Scheduler(f.store, f.root, url, { runtime: f.runtime });
  t.after(() => scheduler.close());
  const deadline = Date.now() + 30000;
  while (
    Date.now() < deadline &&
    f.store.getGoal(f.goal.id).status !== "completed"
  ) {
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
  const current = f.store.getGoal(f.goal.id);
  assert.equal(
    current.status,
    "completed",
    JSON.stringify(f.store.tasks(f.goal.id)),
  );
  const ledger = new InvocationStore(f.store),
    records = ledger.all(f.goal.id);
  assert.ok(records.some((r) => r.phase === "verify" && r.kind === "command"));
  const coding = records.find((r) => r.phase === "implement")!,
    review = records.find((r) => r.phase === "review")!;
  assert.notEqual(coding.workspace, review.workspace);
  assert.notEqual(coding.sessionId, review.sessionId);
  assert.equal(coding.candidate, review.candidate);
  assert.ok(coding.baseCommit);
  const metrics = ledger.metrics(f.goal.id);
  assert.equal(metrics.modelRequests.value, null);
  assert.equal(metrics.inputTokens.value, 200);
  assert.equal(metrics.cachedInputTokens.value, 80);
  for (const action of ["invocations", "metrics"]) {
    const response = await fetch(`${url}/api/v1/goals/${f.goal.id}/${action}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
  }
  assert.equal(
    (await fetch(`${url}/api/v1/goals/${f.goal.id}/metrics`)).status,
    401,
  );
});

test("unchanged candidates block only after matching trusted-check failures", async (t) => {
  const f = await fixture(t);
  let checks = 0;
  f.runtime.verify = async (_claim, path) => ({
    commit: await git(path, ["rev-parse", "HEAD"]),
    passed: false,
    unchanged: true,
    verifierVersion: "fixture",
    results: [
      {
        command: "test -f one.txt",
        exitCode: 1,
        stdout: "",
        stderr: ++checks === 1 ? "Temporary tool failure" : "Stable failure",
      },
    ],
  });
  let scheduler: Scheduler;
  const token = "native-check-operator-0123456789";
  const server = createControlServer(f.store, {
    token,
    onResult: (...args) => scheduler.result(...args),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  scheduler = new Scheduler(
    f.store,
    f.root,
    `http://127.0.0.1:${(server.address() as any).port}`,
    { runtime: f.runtime },
  );
  t.after(() => scheduler.close());
  const taskId = f.store.tasks(f.goal.id)[0].id;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await scheduler.tick();
      await new Promise((r) => setTimeout(r, 50));
      const task = f.store.getTask(taskId);
      if (checks === attempt && ["retry_wait", "blocked"].includes(task.status))
        break;
    }
    const task = f.store.getTask(taskId);
    assert.equal(checks, attempt);
    assert.equal(task.status, attempt < 3 ? "retry_wait" : "blocked");
    if (attempt < 3)
      f.store.db.exec(
        `UPDATE control_tasks SET retry_at=0 WHERE id='${taskId}'`,
      );
    else assert.match(JSON.stringify(task.result), /same trusted checks/);
  }
});

test("native preserves sessions and user config while excluding controller credentials", async (t) => {
  const f = await fixture(t);
  const claim = f.store.claimNextTask("native-worker")!;
  const backend = observedBackend(f.store, f.runtime.backend(f.goal));
  const context = {
    claim,
    workspace: f.repo,
    mode: "implement" as const,
    prompt: "Implement one",
    signal: new AbortController().signal,
    onCheckpoint: async () => {},
  };
  const first = await backend.run(context),
    second = await backend.run(context);
  assert.equal(first.sessionId, second.sessionId);
  const call = JSON.parse(
    await readFile(join(f.root, "last-args.json"), "utf8"),
  );
  assert.ok(call.args.includes("resume"));
  assert.ok(call.args.includes('model_reasoning_effort="low"'));
  assert.ok(!call.args.includes("--last"));
  assert.ok(!call.args.includes("--ignore-user-config"));
  assert.ok(!call.args.includes("--ephemeral"));
  const env = nativeEnvironment(f.profile);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.MISSIONCONTROL_INFERENCE_TOKEN, undefined);
});

test("native malformed terminal output fails and preserves unknown usage", async (t) => {
  const f = await fixture(t),
    claim = f.store.claimNextTask("native-worker")!;
  await assert.rejects(
    observedBackend(f.store, f.runtime.backend(f.goal)).run({
      claim,
      workspace: f.repo,
      mode: "implement",
      prompt: "MALFORMED",
      signal: new AbortController().signal,
      onCheckpoint: async () => {},
    }),
  );
  assert.equal(
    new InvocationStore(f.store).all(f.goal.id).at(-1)!.outcome,
    "failed",
  );
});

test("native recovery stops only the selected owned writer and refuses PID reuse", async (t) => {
  const f = await fixture(t),
    claim = f.store.claimNextTask("native-worker")!;
  const abort = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const running = observedBackend(f.store, f.runtime.backend(f.goal)).run({
    claim,
    workspace: f.repo,
    mode: "implement",
    prompt: "WAIT_FOREVER",
    signal: abort.signal,
    onProgress: () => started(),
    onCheckpoint: async () => {},
  });
  const rejected = assert.rejects(running);
  await ready;
  const record = new InvocationStore(f.store).all(f.goal.id).at(-1)!;
  assert.ok(record.process);
  await f.runtime.recover({
    taskId: claim.task.id,
    generation: claim.generation,
  });
  await rejected;
  assert.deepEqual(await ownedGroup(record.process!), []);
  const current = (await processIdentity(process.pid))!;
  await assert.rejects(
    ownedGroup({
      ...current,
      startTime: String(BigInt(current.startTime) + 1n),
    }),
    /reused PID/,
  );
});

test("native preflight detects missing prerequisites without starting an invocation", async (t) => {
  const f = await fixture(t);
  f.goal.config.admission!.nativeProfile!.requiredExecutables = [
    "missioncontrol-nonexistent-tool",
  ];
  f.goal.config.admission!.runtimeHash = nativeBinding(f.goal.config);
  const result = await nativePreflight(f.goal.config);
  assert.equal(result.ready, false);
  assert.ok(result.faults.some((f) => f.includes("nonexistent")));
  assert.equal(new InvocationStore(f.store).all().length, 0);
});

test("execution contracts reject unsupported native combinations and retain omitted plan resources", () => {
  const native = {
    harness: "codex",
    provider: "codex-subscription",
    execution: "native",
    authentication: { kind: "local", reference: "selected" },
    usagePolicy: { kind: "observed" },
  };
  assert.ok(executionContractSchema.safeParse(native).success);
  assert.equal(
    executionContractSchema.safeParse({ ...native, execution: "isolated" })
      .success,
    false,
  );
  assert.equal(
    executionContractSchema.safeParse({ ...native, provider: "azure" }).success,
    false,
  );
  const plan = inputPlanSchema.parse({
    tasks: [
      {
        key: "one",
        title: "One",
        description: "One",
        allowedPaths: ["**"],
        acceptanceCriteria: ["pass"],
      },
    ],
  });
  assert.equal(plan.tasks[0].memoryMiB, undefined);
});

async function completeFixture(t: test.TestContext, scenario: string) {
  const f = await fixture(t, scenario);
  let scheduler: Scheduler;
  const token = "native-test-operator-0123456789";
  const server = createControlServer(f.store, {
    token,
    onResult: (...args) => scheduler.result(...args),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  scheduler = new Scheduler(f.store, f.root, url, { runtime: f.runtime });
  t.after(() => scheduler.close());
  const deadline = Date.now() + 30000;
  while (
    Date.now() < deadline &&
    f.store.getGoal(f.goal.id).status !== "completed"
  ) {
    // Advance only the fixture's retry clock; real command deadlines use wall time.
    f.store.db.exec(
      "UPDATE control_tasks SET retry_at=0 WHERE status='retry_wait'",
    );
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(
    f.store.getGoal(f.goal.id).status,
    "completed",
    JSON.stringify(f.store.tasks(f.goal.id)),
  );
  return f;
}
for (const scenario of ["CHECK_REPAIR", "REVIEW_REPAIR"])
  test(`native ${scenario} repairs within one task and resumes the saved session`, async (t) => {
    const f = await completeFixture(t, scenario),
      records = new InvocationStore(f.store).all(f.goal.id);
    assert.equal(f.store.tasks(f.goal.id).length, 1);
    const writers = records.filter((r) => r.phase === "implement");
    assert.equal(writers.length, 2);
    assert.equal(writers[0].sessionId, writers[1].sessionId);
    const reviews = records.filter((r) => r.phase === "review");
    if (scenario === "REVIEW_REPAIR") {
      assert.equal(reviews.length, 2);
      assert.notEqual(reviews[0].sessionId, reviews[1].sessionId);
    }
    assert.equal(f.store.tasks(f.goal.id)[0].attempts, 2);
  });
test("native quota failures retain unknown usage and establish a provider blocker", async (t) => {
  const f = await fixture(t),
    claim = f.store.claimNextTask("quota-worker")!;
  let error: unknown;
  try {
    await observedBackend(f.store, f.runtime.backend(f.goal)).run({
      claim,
      workspace: f.repo,
      mode: "implement",
      prompt: "QUOTA",
      signal: new AbortController().signal,
      onCheckpoint: async () => {},
    });
  } catch (e) {
    error = e;
  }
  const { classifyFailure } = await import("./reliability.js");
  assert.equal(classifyFailure(error).kind, "quota");
  f.store.recordFailure(
    f.goal.id,
    classifyFailure(error),
    `${claim.task.id}:${claim.generation}`,
  );
  assert.equal(f.store.getGoal(f.goal.id).status, "paused");
  assert.ok(f.store.setting(`provider-block:${f.goal.id}`));
  assert.equal(
    new InvocationStore(f.store).metrics(f.goal.id).inputTokens.value,
    null,
  );
});
test("native duplicate terminal events cannot be accepted or double-count usage", async (t) => {
  const f = await fixture(t),
    claim = f.store.claimNextTask("duplicate-worker")!;
  await assert.rejects(
    observedBackend(f.store, f.runtime.backend(f.goal)).run({
      claim,
      workspace: f.repo,
      mode: "implement",
      prompt: "DUPLICATE",
      signal: new AbortController().signal,
      onCheckpoint: async () => {},
    }),
  );
  const rows = new InvocationStore(f.store).all(f.goal.id);
  assert.equal(rows[0].outcome, "failed");
  assert.equal(rows[0].turns, 1);
});
test("native command completion and cancellation stop detached descendants", async (t) => {
  const f = await fixture(t);
  let identity: Awaited<ReturnType<typeof processIdentity>>;
  await nativeCommand("/bin/sh", ["-c", "setsid sleep 600 >/dev/null 2>&1 &"], {
    cwd: f.repo,
    env: nativeEnvironment(f.profile),
    onProcess: (id) => (identity = id),
  });
  assert.ok(identity);
  assert.deepEqual(await ownedGroup(identity), []);
  const abort = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>((r) => (ready = r));
  const running = nativeCommand("/bin/sh", ["-c", "setsid sleep 600 & wait"], {
    cwd: f.repo,
    env: nativeEnvironment(f.profile),
    signal: abort.signal,
    onProcess: (id) => {
      identity = id;
      ready();
    },
  });
  const rejected = assert.rejects(running);
  await started;
  abort.abort();
  await rejected;
  assert.deepEqual(await ownedGroup(identity!), []);
});
test("native verification rejects source mutation and undeclared outputs but permits declared build outputs", async (t) => {
  const f = await fixture(t),
    claim = f.store.claimNextTask("verify-worker")!;
  await writeFile(join(f.repo, "one.txt"), "implemented");
  await git(f.repo, ["add", "one.txt"]);
  await git(f.repo, ["commit", "-m", "candidate"]);
  for (const [command, outputs, passed] of [
    ["printf mutation >> base.txt", [], false],
    ["touch source.ts", [], false],
    ["mkdir build; touch build/output", ["build/**"], true],
  ] as const) {
    claim.goal.config.verificationCommands = [command];
    claim.task.spec.verificationCommands = [command];
    claim.goal.config.admission!.nativeProfile!.buildOutputPaths = [...outputs];
    claim.goal.config.admission!.runtimeHash = nativeBinding(claim.goal.config);
    const result = await f.runtime.verify(claim, f.repo);
    assert.equal(result.passed, passed);
    assert.equal(result.unchanged, passed);
  }
  assert.equal(await readFile(join(f.repo, "base.txt"), "utf8"), "base\n");
});
test("native admission catches fixture scope conflicts and prerequisite failures without inference", async (t) => {
  const f = await fixture(t);
  f.goal.config.admission!.nativeProfile!.requiredPaths = [
    "missing-fixture.json",
  ];
  f.goal.config.admission!.nativeProfile!.requiredScopePaths = ["fixture.json"];
  f.goal.config.admission!.runtimeHash = nativeBinding(f.goal.config);
  const result = await nativePreflight(
    f.goal.config,
    f.store.tasks(f.goal.id)[0].spec,
  );
  assert.equal(result.ready, false);
  assert.ok(result.faults.some((f) => f.includes("missing-fixture")));
  assert.ok(result.faults.some((f) => f.includes("outside task scope")));
  const goal = f.store.createGoal(f.goal.config);
  assert.throws(
    () =>
      f.store.installPlan(
        goal.id,
        {
          tasks: [
            {
              key: "one",
              title: "One",
              description: "One",
              allowedPaths: ["one.txt"],
              acceptanceCriteria: ["pass"],
            },
          ],
        },
        goal.revision,
      ),
    /outside task scope/,
  );
  assert.equal(new InvocationStore(f.store).all().length, 0);
});

test("native launcher refuses EOF without durable launch authorization", async (t) => {
  const f = await fixture(t),
    marker = join(f.root, "unauthorized-write");
  const child = spawn(process.execPath, [
    new URL("./nativeLauncher.js", import.meta.url).pathname,
    process.execPath,
    "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
  ]);
  const closed = once(child, "close");
  child.stdin.end();
  assert.equal((await closed)[0], 1);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});
test("normal native commands do not prematurely consume the attempt cleanup allowance", async (t) => {
  const f = await fixture(t),
    claim = f.store.claimNextTask("cleanup-worker")!;
  const candidate = f.repo;
  await writeFile(join(candidate, "one.txt"), "implemented");
  await git(candidate, ["add", "one.txt"]);
  await git(candidate, ["commit", "-m", "candidate"]);
  const result = await f.runtime.verify(claim, candidate);
  assert.equal(result.passed, true);
  assert.equal(
    f.store.reliability.runtime(`${claim.task.id}:${claim.generation}`)
      ?.cleanupStartedAt,
    undefined,
  );
});
test("private output rotates with private permissions while metadata remains independently durable", async (t) => {
  const f = await fixture(t);
  const { PrivateOutput } = await import("./privateOutput.js");
  const { finished } = await import("node:stream/promises");
  const { stat } = await import("node:fs/promises");
  const path = join(f.root, "raw-output"),
    stream = new PrivateOutput(path, 16, 2);
  const payload =
    "A".repeat(16) + "B".repeat(16) + "C".repeat(16) + "D".repeat(8);
  stream.end(payload);
  await finished(stream);
  assert.equal(
    (await readFile(path + ".2", "utf8")) +
      (await readFile(path + ".1", "utf8")) +
      (await readFile(path, "utf8")),
    payload.slice(16),
  );
  for (const file of [path, path + ".1", path + ".2"])
    assert.equal((await stat(file)).mode & 0o077, 0);
});

test("native startup retains ambiguous ownership while settling an independent stopped attempt", async (t) => {
  const f = await fixture(t),
    other = await fixture(t),
    claim = f.store.claimNextTask("retained-worker")!;
  const g = f.store.createGoal(other.goal.config);
  f.store.installPlan(
    g.id,
    {
      tasks: [
        {
          key: "two",
          title: "Two",
          description: "Two",
          allowedPaths: ["one.txt"],
          acceptanceCriteria: ["done"],
        },
      ],
    },
    g.revision,
  );
  const second = f.store.claimNextTask("stopped-worker", { goalId: g.id })!;
  assert.ok(second);
  const identity = (await processIdentity(process.pid))!;
  new InvocationStore(f.store).save({
    id: "ambiguous-native",
    goalId: f.goal.id,
    taskId: claim.task.id,
    attemptId: `${claim.task.id}:${claim.generation}`,
    generation: claim.generation,
    phase: "implement",
    environment: "native",
    agent: "codex",
    startedAt: Date.now(),
    workspace: f.repo,
    outcome: "active",
    turns: 0,
    toolEvents: 0,
    retryEvents: 0,
    process: {
      ...identity,
      startTime: String(BigInt(identity.startTime) + 1n),
    },
  });
  f.store.fenceStartup();
  await f.runtime.recoverStartup();
  assert.equal(f.store.getTask(claim.task.id).workerId, "retained-worker");
  assert.equal(f.store.getTask(second.task.id).workerId, null);
  assert.equal(f.store.getGoal(f.goal.id).status, "paused");
  assert.deepEqual(f.store.setting("startup-recovery").tasks, [
    { taskId: claim.task.id, generation: claim.generation },
  ]);
});
test("native operation reconciliation refuses retained active execution", async (t) => {
  const f = await fixture(t),
    attemptId = f.store.reserveOperation(f.goal.id, "plan");
  new InvocationStore(f.store).save({
    id: "owned-operation",
    goalId: f.goal.id,
    attemptId,
    generation: 0,
    phase: "plan",
    environment: "native",
    agent: "codex",
    startedAt: Date.now(),
    workspace: f.repo,
    outcome: "active",
    turns: 0,
    toolEvents: 0,
    retryEvents: 0,
  });
  f.store.fenceStartup();
  assert.throws(
    () => f.store.finishOperationRecovery(attemptId),
    /still owns retained resources/,
  );
});

test("cleanup inspection ambiguity retains a cancelled invocation and its workspace claim", async (t) => {
  const f = await fixture(t),
    claim = f.store.claimNextTask("ambiguous-cleanup-worker")!,
    identity = (await processIdentity(process.pid))!,
    signal = AbortSignal.abort();
  const ambiguous = {
    ...identity,
    startTime: String(BigInt(identity.startTime) + 1n),
  };
  const backend = observedBackend(f.store, {
    async run(context) {
      context.observe?.({ process: ambiguous });
      await cleanupNativeProcess(ambiguous, Promise.resolve());
      throw Error("Ambiguous cleanup must not succeed");
    },
  });
  await assert.rejects(
    backend.run({
      claim,
      workspace: f.repo,
      mode: "implement",
      prompt: "",
      signal,
      onCheckpoint: async () => {},
    }),
    (error: any) => error.failure?.kind === "cleanup_blocked",
  );
  const record = new InvocationStore(f.store).all(f.goal.id).at(-1)!;
  assert.equal(record.outcome, "cleanup_blocked");
  assert.deepEqual(record.usage, { kind: "subscription", status: "unknown" });
  // Startup must preserve ownership rather than release the cancelled writer.
  f.store.fenceStartup();
  await f.runtime.recoverStartup();
  assert.equal(
    f.store.getTask(claim.task.id).workerId,
    "ambiguous-cleanup-worker",
  );
  assert.equal(f.store.getGoal(f.goal.id).status, "paused");
  assert.ok(await processIdentity(process.pid));
});

test("empty additive preparation defaults preserve prior native admission fingerprints", async (t) => {
  const f = await fixture(t);
  const { createHash } = await import("node:crypto");
  const profile = { ...f.profile } as Partial<typeof f.profile>;
  for (const key of [
    "requiredPaths",
    "requiredScopePaths",
    "buildOutputPaths",
    "requiredUrls",
  ] as const)
    delete profile[key];
  const original = createHash("sha256")
    .update(
      JSON.stringify({
        profile,
        backend: f.goal.config.backend,
        contract: f.goal.config.executionContract,
      }),
    )
    .digest("hex");
  assert.equal(nativeBinding(f.goal.config), original);
});

test("malformed native protocol cannot regain trusted usage or successful completion", () => {
  const events = new CodexEvents({});
  assert.throws(() => events.feed("invalid json"));
  assert.throws(() =>
    events.feed(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    ),
  );
  assert.equal(events.turns, 0);
  assert.equal(events.completed, false);
  assert.deepEqual(events.usage, { kind: "subscription", status: "unknown" });
  assert.throws(() => events.assertSuccessful(0));
});

test(
  "native preflight bounds stalled executables and stops their owned processes",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      marker = join(f.root, "preflight-pid");
    await writeFile(
      f.profile.executable,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>process.exit(0),3000);`,
      { mode: 0o700 },
    );
    f.goal.config.timeoutMs = 1000;
    const started = Date.now();
    const result = await nativePreflight(f.goal.config);
    assert.equal(result.ready, false);
    assert.ok(Date.now() - started < 5000);
    const pid = Number(await readFile(marker, "utf8"));
    assert.equal(await processIdentity(pid), undefined);
  },
);

test("native commands and agent execution work from installations with escaped URL paths", async (t) => {
  const f = await fixture(t),
    installation = join(f.root, "installation with spaces # % é");
  await mkdir(installation);
  await writeFile(join(installation, "package.json"), '{"type":"module"}\n');
  // Relocate only the modules under test. Dependencies keep their original URLs;
  // the test does not copy dependency or build trees into its scratch directory.
  for (const name of [
    "nativeProcess.js",
    "nativeRuntime.js",
    "nativeLauncher.js",
  ]) {
    const original = new URL(name, import.meta.url);
    const source = (await readFile(original, "utf8")).replace(
      /from "([^\"]+)"/g,
      (_match, specifier: string) =>
        `from ${JSON.stringify(specifier.startsWith("./") ? new URL(specifier, original).href : import.meta.resolve(specifier))}`,
    );
    await writeFile(join(installation, name), source);
  }
  const relocated = await import(
    pathToFileURL(join(installation, "nativeProcess.js")).href
  );
  const command = await relocated.nativeCommand(
    "/bin/sh",
    ["-c", "printf relocated"],
    {
      cwd: f.repo,
      env: nativeEnvironment(f.profile),
    },
  );
  assert.equal(command.exitCode, 0, command.stderr);
  assert.equal(command.stdout, "relocated");
  const { NativeRuntime: RelocatedRuntime } = await import(
    pathToFileURL(join(installation, "nativeRuntime.js")).href
  );
  const runtime = new RelocatedRuntime(f.store, f.root);
  const claim = f.store.claimNextTask("relocated-worker")!;
  await observedBackend(f.store, runtime.backend(f.goal)).run({
    claim,
    workspace: f.repo,
    mode: "implement",
    prompt: "Implement one",
    signal: new AbortController().signal,
    onCheckpoint: async () => {},
  });
  assert.equal(await readFile(join(f.repo, "one.txt"), "utf8"), "implemented");
});
