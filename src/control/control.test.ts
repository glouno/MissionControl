import { StorageManager } from "./storage.js";
import test from "node:test";
// CI runner disk capacity is unrelated to fixture lifecycle behavior.
test.mock.method(StorageManager.prototype, "pressure", async () => ({
  freeBytes: 100 * 1024 ** 3,
  reserveBytes: 50 * 1024 ** 3,
  admissionAllowed: true,
}));

import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { SqliteStore, sql } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { ControlClient } from "./client.js";
import { createControlServer } from "./api.js";
import { validatePlan, type Claim, type Goal } from "./schema.js";
import { git, WorkspaceManager } from "./workspaces.js";
import { Scheduler } from "./scheduler.js";
import { executeClaim } from "./worker.js";
import {
  FakeBackend,
  HumanWait,
  PortableBackend,
  type AgentBackend,
  type RunContext,
} from "./backends.js";
import { GithubHost } from "./gitHost.js";
import {
  AzureProvider,
  BedrockProvider,
  type ModelProvider,
} from "./providers.js";

const spec = (key: string, dependencies: string[] = []) => ({
  key,
  title: key,
  description: `Implement ${key}`,
  dependencies,
  acceptanceCriteria: ["File exists"],
  allowedPaths: ["**"],
  verificationCommands: ["test -f " + key + ".txt"],
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mc-control-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-b", "development"]);
  await writeFile(join(repo, "README.md"), "Fixture\n");
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "Initial",
  ]);
  let now = Date.now();
  const db = new SqliteStore(join(root, "state.db"));
  const store = new ControlStore(db, () => now);
  store.setting("scheduler-limits", {
    workers: 4,
    cpu: 16,
    memoryMiB: 16384,
    providerWorkers: 4,
    repositoryWorkers: 4,
  });
  return { root, repo, db, store, advance: (ms: number) => (now += ms) };
}
async function planned(
  f: Awaited<ReturnType<typeof fixture>>,
  tasks: any[] = [spec("one"), spec("two")],
) {
  const g = f.store.createGoal({
    title: "Goal",
    description: "Two independent tasks",
    repoPath: f.repo,
    repository: { mode: "local" as const, branch: "development" },
    backend: { kind: "fake" },
  });
  f.store.installPlan(g.id, { tasks }, g.revision);
  return f.store.getGoal(g.id);
}
async function serve(
  f: Awaited<ReturnType<typeof fixture>>,
  scheduler?: Scheduler,
) {
  const token = "operator-test-token-0123456789";
  const server = createControlServer(f.store, {
    token,
    onResult: scheduler ? (...a) => scheduler.result(...a) : undefined,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  return { server, url, client: new ControlClient(url, token) };
}

test("plan rejects cycles, missing dependencies and duplicate keys", () => {
  assert.throws(
    () => validatePlan({ tasks: [spec("a", ["b"]), spec("b", ["a"])] }),
    /cycle/,
  );
  assert.throws(
    () => validatePlan({ tasks: [spec("a", ["missing"])] }),
    /Missing/,
  );
  assert.throws(
    () => validatePlan({ tasks: [spec("a"), spec("a")] }),
    /Duplicate/,
  );
});
test("claims enforce dependencies, global slots, resources and stale generations", async () => {
  const f = await fixture();
  const g = await planned(f, [
    { ...spec("one"), resources: ["gpu"] },
    { ...spec("two"), resources: ["gpu"] },
    spec("three", ["one"]),
  ]);
  const c = f.store.claimNextTask("first")!;
  assert.equal(c.task.key, "one");
  assert.equal(f.store.claimNextTask("second"), null);
  const store2 = new ControlStore(new SqliteStore(f.db.path), f.store.clock);
  assert.equal(store2.claimNextTask("competing"), null);
  f.advance(121000);
  assert.throws(
    () => f.store.heartbeat(c.task.id, c.workerId, c.generation),
    /lease/,
  );
  f.store.reconcileExpired(c.task.id, c.generation);
  assert.equal(f.store.claimNextTask("new-owner"), null);
  const question = f.store.questions()[0];
  f.store.answer(
    question.id,
    "inspect",
    question.revision,
    "operator",
    "Confirmed synthetic worker and resource stopped",
  );
  const recovered = f.store.claimNextTask("new-owner")!;
  assert.equal(recovered.generation, c.generation + 1);
  assert.throws(
    () =>
      f.store.checkpoint(c.task.id, c.workerId, c.generation, {
        summary: "late",
      }),
    /lease/,
  );
  assert.equal(
    f.store.tasks(g.id).find((t) => t.key === "three")?.status,
    "pending",
  );
});
test("human waiting releases slots, persists across restart and resumes only affected work", async () => {
  const f = await fixture();
  const g = await planned(f);
  const c = f.store.claimNextTask("first")!;
  f.store.transition(c.task.id, c.workerId, c.generation, "running");
  f.store.checkpoint(c.task.id, c.workerId, c.generation, {
    summary: "Need decision",
    commit: "abc",
  });
  const q = f.store.requestHuman(c.task.id, c.workerId, c.generation, {
    question: "A or B?",
    reason: "Product semantics",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  });
  assert.equal(f.store.getTask(c.task.id).status, "waiting_human");
  assert.equal(f.store.claimNextTask("second")?.task.key, "two");
  const restarted = new ControlStore(new SqliteStore(f.db.path), f.store.clock);
  restarted.answer(q.id, "a", 1, "operator");
  assert.equal(restarted.getTask(c.task.id).status, "ready");
  assert.throws(() => restarted.answer(q.id, "b", 1, "operator"), /changed/);
  assert.ok(restarted.memory("semantics").length);
});
test("evidence acceptance is tied to exact source and integration commits", async () => {
  const f = await fixture();
  await planned(f, [spec("one")]);
  const c = f.store.claimNextTask("one")!;
  f.store.transition(c.task.id, c.workerId, c.generation, "running");
  f.store.transition(c.task.id, c.workerId, c.generation, "verifying");
  f.store.transition(c.task.id, c.workerId, c.generation, "integrating");
  assert.throws(
    () => f.store.accept(c.task.id, c.workerId, c.generation, "a", "b"),
    /evidence/,
  );
  for (const kind of ["tests", "review"] as const)
    f.store.evidence(
      c.task.id,
      c.workerId,
      c.generation,
      "wrong",
      kind,
      true,
      {},
    );
  f.store.evidence(
    c.task.id,
    c.workerId,
    c.generation,
    "b",
    "integration",
    true,
    {},
  );
  assert.throws(
    () => f.store.accept(c.task.id, c.workerId, c.generation, "a", "b"),
    /evidence/,
  );
  for (const kind of ["tests", "review"] as const)
    f.store.evidence(c.task.id, c.workerId, c.generation, "a", kind, true, {});
  f.store.accept(c.task.id, c.workerId, c.generation, "a", "b");
  assert.equal(f.store.getGoal(c.goal.id).status, "publishing");
  assert.throws(
    () => f.db.exec("UPDATE control_events SET actor='other'"),
    /immutable/,
  );
});
test("parallel claims reserve budget and provider waits do not consume attempts", async () => {
  const f = await fixture();
  const g = f.store.createGoal({
    title: "Paid",
    description: "Test",
    repoPath: f.repo,
    repository: { mode: "local" as const, branch: "development" },
    executionContract: {
      harness: "tool-loop",
      provider: "azure",
      authentication: { kind: "controller", reference: "synthetic" },
      execution: "isolated",
      usagePolicy: { kind: "metered", maxCostUsd: 10, estimatePerRunUsd: 1 },
    },
    backend: {
      kind: "azure",
      endpoint: "https://example.openai.azure.com",
      model: "deployment",
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    },
    maxCostUsd: 1,
    estimatePerRunUsd: 1,
  });
  f.store.installPlan(g.id, { tasks: [spec("one"), spec("two")] }, g.revision);
  const c = f.store.claimNextTask("first")!;
  assert.equal(f.store.claimNextTask("second"), null);
  f.store.release(
    c.task.id,
    c.workerId,
    c.generation,
    "waiting_provider",
    "quota",
    0,
  );
  assert.equal(f.store.getTask(c.task.id).attempts, 0);
  assert.ok(f.store.claimNextTask("second"));
});
test("API authenticates, fences worker scope and replays idempotent goal submission", async (t) => {
  const f = await fixture();
  const s = await serve(f);
  t.after(() => s.server.close());
  const input = {
    title: "API goal",
    description: "Create",
    repoPath: f.repo,
    repository: { mode: "local" as const, branch: "development" },
    backend: { kind: "fake" as const },
  };
  const a = await s.client.createGoal(input, "same");
  const b = await s.client.createGoal(input, "same");
  assert.equal(a.id, b.id);
  await assert.rejects(
    () => s.client.createGoal({ ...input, title: "Changed" }, "same"),
    /another request/,
  );
  const bad = await fetch(s.url + "/api/v1/goals");
  assert.equal(bad.status, 401);
  const token = f.store.createToken("worker", "worker", "worker");
  const client = new ControlClient(s.url, token);
  f.store.installPlan(
    a.id,
    { tasks: [spec("worker-one"), spec("worker-two")] },
    a.revision,
  );
  const owned = f.store.claimNextTask("worker", { goalId: a.id })!;
  assert.ok(owned);
  await assert.rejects(
    () => client.request(`/events?goalId=${a.id}`),
    /authority/,
  );
  for (const suffix of ["evidence", "artifacts", "findings", "attempts"])
    await assert.rejects(
      () => client.request(`/goals/${a.id}/${suffix}`),
      /authority/,
    );
  await assert.rejects(() => client.createGoal(input), /authority/);
  await assert.rejects(() => client.claim("different"), /identity/);
  const openapi = (await (
    await fetch(s.url + "/api/v1/openapi.json")
  ).json()) as any;
  assert.ok(openapi.components.schemas.GoalInput);
});
test("parallel API workers integrate two branches without editing primary checkout", async (t) => {
  const f = await fixture();
  const g = await planned(f);
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
  });
  const s = await serve(f, scheduler);
  t.after(() => s.server.close());
  const claims = [f.store.claimNextTask("w1")!, f.store.claimNextTask("w2")!];
  assert.equal(claims.length, 2);
  for (const c of claims)
    await scheduler.workspaces.prepareTask(c.goal, c.task);
  await Promise.all(claims.map((c) => executeClaim(s.client, c, f.root)));
  assert.ok(f.store.tasks(g.id).every((t) => t.status === "accepted"));
  await scheduler.publish(g.id);
  assert.equal(f.store.getGoal(g.id).status, "completed");
  assert.equal(await git(f.repo, ["status", "--porcelain"]), "");
  assert.equal(
    await readFile(join(scheduler.workspaces.goalPath(g), "one.txt"), "utf8"),
    "Implement one\n",
  );
  assert.equal(
    await readFile(join(scheduler.workspaces.goalPath(g), "two.txt"), "utf8"),
    "Implement two\n",
  );
});
test("terminal reports retry without replaying completed work and include authoritative attempts", async (t) => {
  const f = await fixture();
  const g = await planned(f, [spec("one")]);
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
  });
  const s = await serve(f, scheduler);
  t.after(() => s.server.close());
  const claim = f.store.claimNextTask("report-worker")!;
  await scheduler.workspaces.prepareTask(claim.goal, claim.task);
  await executeClaim(s.client, claim, f.root);
  const failing = t.mock.method(scheduler.workspaces, "report", async () => {
    throw Error("Synthetic disk failure");
  });
  await assert.rejects(() => scheduler.publish(g.id), /Synthetic disk failure/);
  assert.equal(f.store.getGoal(g.id).status, "completed");
  assert.equal(f.store.setting(`report:${g.id}`).state, "pending");
  assert.equal(f.store.jobs("report").length, 1);
  const committed = (f.store.getTask(claim.task.id).result as any)?.commit;
  const count = f.store.attempts(g.id).length;
  await scheduler.tick();
  assert.equal(f.store.getGoal(g.id).status, "completed");
  assert.equal(f.store.setting(`report:${g.id}`).state, "pending");
  failing.mock.restore();
  // A new scheduler observes the durable pending intent after a restart.
  f.advance(31000);
  const resumed = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
  });
  await resumed.tick();
  const path = join(f.root, "goals", g.id, "report.json");
  const report = JSON.parse(await readFile(path, "utf8"));
  assert.equal(report.goal.status, "completed");
  assert.equal(report.goal.result.report, `goals/${g.id}/report.json`);
  assert.equal(report.attempts.length, count);
  assert.ok(
    report.attempts.every((a: any) => a.configurationHash && a.endedAt),
  );
  assert.ok(
    report.evidence.every((e: any) => e.commit_sha === committed && e.passed),
  );
  assert.ok(report.events.some((e: any) => e.type === "GOAL_COMPLETED"));
  assert.equal(f.store.setting(`report:${g.id}`).state, "ready");
  assert.equal(f.store.attempts(g.id).length, count);
  assert.equal(
    f.store.events(0, g.id, 500).filter((e: any) => e.type === "GOAL_COMPLETED")
      .length,
    1,
  );
  assert.equal(f.store.jobs("report").length, 0);
  await resumed.writeGoalReport(g.id);
  assert.equal(
    f.db.query("SELECT id FROM control_artifacts WHERE kind='goal-report'")
      .length,
    1,
  );
});
test("controller-approved HTTP claims are atomic, replayable and reject unknown dispatches", async (t) => {
  const f = await fixture();
  await planned(f, [spec("one")]);
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
  });
  const token = "synthetic-approved-operator-token";
  const server = createControlServer(f.store, {
    token,
    externalClaimsDisabled: true,
    claimTask: (...args) => scheduler.claimControllerWorker(...args),
    onResult: (...args) => scheduler.result(...args),
    replayResult: (...args) => scheduler.replayResult(...args),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const client = (id: string) =>
    new ControlClient(url, f.store.createToken(id, "worker", id));
  const unapproved = client("unknown");
  await assert.rejects(() => unapproved.claim("unknown"), /controller-owned/);
  scheduler.authorizeControllerWorker("one");
  scheduler.authorizeControllerWorker("two");
  const first = client("one"),
    second = client("two");
  const results = await Promise.all([
    first.claim("one"),
    first.claim("one"),
    second.claim("two"),
  ]);
  assert.ok(results[0]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[2], null);
  assert.equal(f.store.attempts(results[0]!.goal.id).length, 1);
  assert.ok(results[0]!.workspace?.baseCommit);
  await assert.rejects(() => first.claim("two"), /identity/);
  await executeClaim(first, results[0]!, f.root);
  assert.equal(f.store.getTask(results[0]!.task.id).status, "accepted");
  const acceptedAttempt = f.store
    .attempts(results[0]!.goal.id)
    .find((a) => a.taskId === results[0]!.task.id)!;
  const replayed = await first.result(results[0]!, acceptedAttempt.result);
  assert.equal((replayed as any).status, "accepted");
  await assert.rejects(
    () =>
      first.result(results[0]!, {
        ...(acceptedAttempt.result as any),
        costUsd: 9,
      }),
    /differs/,
  );
  await assert.rejects(() => first.claim("one"), /lease/i);
});
test("pending claims preserve scope and revoked dispatches cannot receive work", async () => {
  const f = await fixture();
  const goal = await planned(f, [spec("one")]);
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
  });
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const proceed = new Promise<void>((resolve) => (release = resolve));
  const prepare = scheduler.workspaces.prepareTask.bind(scheduler.workspaces);
  scheduler.workspaces.prepareTask = async (...args) => {
    entered();
    await proceed;
    return prepare(...args);
  };
  scheduler.authorizeControllerWorker("scoped");
  const pending = scheduler.claimControllerWorker("scoped", goal.id);
  await waiting;
  await assert.rejects(
    scheduler.claimControllerWorker("scoped", "another-goal"),
    /same goal scope/,
  );
  const retry = scheduler.claimControllerWorker("scoped", goal.id);
  scheduler.revokeControllerWorker("scoped");
  const outcomes = Promise.allSettled([pending, retry]);
  release();
  for (const outcome of await outcomes) {
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected")
      assert.match(outcome.reason.message, /revoked/);
  }
  assert.equal(f.store.tasks(goal.id)[0].workerId, null);
  assert.equal(f.store.tasks(goal.id)[0].status, "retry_wait");
  assert.equal(f.store.attempts(goal.id).length, 1);
});
test("isolated runtime routes planning and replanning without a host backend fallback", async () => {
  const f = await fixture();
  const g = f.store.createGoal({
    title: "Plan",
    description: "Plan through the authorized provider",
    repoPath: f.repo,
    repository: { mode: "local", branch: "development" },
    backend: { kind: "fake" },
    maxCostUsd: 5,
    estimatePerRunUsd: 1,
  });
  let calls = 0;
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    backend: () => {
      throw new Error("Host subscription must not be used");
    },
    isolatedBackend: () => ({
      run: async (context) => {
        assert.equal(context.mode, "plan");
        assert.equal(context.claim.generation, 0);
        assert.ok(
          f.store.db.one(
            `SELECT id FROM control_budgets WHERE id=${sql(context.operationReservationId)} AND status='reserved'`,
          ),
        );
        calls++;
        return {
          text: JSON.stringify({ tasks: [spec("one")] }),
          costUsd: 0.1,
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    }),
  });
  try {
    await scheduler.plan(g.id);
    await scheduler.replan(g.id);
    assert.equal(calls, 2);
    assert.equal(f.store.getGoal(g.id).planRevision, 2);
    assert.equal(f.store.canSpend(g.id).spent, 0.2);
  } finally {
    f.db.close();
  }
});

test("isolated planning failure settles its reservation without host fallback", async () => {
  const f = await fixture();
  const g = f.store.createGoal({
    title: "Failure",
    description: "Failure",
    repoPath: f.repo,
    backend: { kind: "fake" },
    maxCostUsd: 5,
    estimatePerRunUsd: 1,
  });
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    backend: () => {
      throw new Error("Host fallback");
    },
    isolatedBackend: () => ({
      run: async () => {
        throw Object.assign(new Error("Azure unavailable"), { costUsd: 0.1 });
      },
    }),
  });
  try {
    await assert.rejects(
      scheduler.runBackend(
        g,
        {
          claim: scheduler.plannerClaim(g),
          workspace: f.repo,
          mode: "plan",
          prompt: "Plan",
          signal: new AbortController().signal,
          onCheckpoint: async () => {},
        },
        "planning",
      ),
      /Azure unavailable/,
    );
    assert.equal(f.store.canSpend(g.id).spent, 0.1);
    assert.equal(
      f.store.db.one("SELECT id FROM control_budgets WHERE status='reserved'"),
      null,
    );
  } finally {
    f.db.close();
  }
});

test("independent review failure creates repair continuation and blocks acceptance", async (t) => {
  const f = await fixture();
  const g = await planned(f, [spec("one")]);
  let reviews = 0;
  const fake = new FakeBackend();
  const backend: AgentBackend = {
    run: async (c) =>
      c.mode === "review" && reviews++ === 0
        ? {
            text: JSON.stringify({
              commit: await git(c.workspace, ["rev-parse", "HEAD"]),
              verdict: "fail",
              findings: [
                {
                  summary: "Repair required",
                  blocking: true,
                  evidence: "one.txt",
                },
              ],
            }),
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
          }
        : fake.run(c),
  };
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
    backend: () => backend,
  });
  const s = await serve(f, scheduler);
  t.after(() => s.server.close());
  let c = f.store.claimNextTask("builder")!;
  await scheduler.workspaces.prepareTask(g, c.task);
  await executeClaim(s.client, c, f.root);
  assert.equal(f.store.getTask(c.task.id).status, "retry_wait");
  assert.match(
    f.store.getTask(c.task.id).checkpoint!.summary,
    /Repair required/,
  );
  f.advance(30000);
  c = f.store.claimNextTask("repair")!;
  await executeClaim(s.client, c, f.root);
  assert.equal(f.store.getTask(c.task.id).status, "accepted");
});
test("conflicting branches retain a conflict finding and never overwrite accepted work", async (t) => {
  const f = await fixture();
  const g = await planned(f, [
    { ...spec("one"), verificationCommands: ["test -f shared.txt"] },
    { ...spec("two"), verificationCommands: ["test -f shared.txt"] },
  ]);
  const backend: AgentBackend = {
    run: async (c) => {
      if (c.mode === "implement") {
        await writeFile(join(c.workspace, "shared.txt"), c.claim.task.key);
        return {
          text: "Changed shared file",
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      return new FakeBackend().run(c);
    },
  };
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
  });
  const s = await serve(f, scheduler);
  t.after(() => s.server.close());
  const a = f.store.claimNextTask("a")!,
    b = f.store.claimNextTask("b")!;
  await scheduler.workspaces.prepareTask(g, a.task);
  await scheduler.workspaces.prepareTask(g, b.task);
  await executeClaim(s.client, a, f.root, backend);
  await executeClaim(s.client, b, f.root, backend);
  assert.equal(f.store.getTask(a.task.id).status, "accepted");
  assert.equal(f.store.getTask(b.task.id).status, "waiting_human");
  assert.ok(f.store.questions().some((q) => q.taskId === b.task.id));
  assert.equal(
    await readFile(
      join(scheduler.workspaces.goalPath(g), "shared.txt"),
      "utf8",
    ),
    "one",
  );
});

test("Azure streamed tools and usage normalize into portable results", async () => {
  {
    let payload: any;
    const provider = new AzureProvider(
      {
        kind: "azure",
        reasoningEffort: "medium",
        maxOutputTokens: 8192,
        endpoint: "https://example.openai.azure.com",
        model: "deployment",
        credential: "key",
        inputUsdPerMillion: 2,
        outputUsdPerMillion: 4,
      },
      async (url, init) => {
        assert.equal(
          String(url),
          "https://example.openai.azure.com/openai/v1/responses",
        );
        payload = JSON.parse(String(init?.body));
        return new Response(
          "data: " +
            JSON.stringify({
              type: "response.completed",
              response: {
                output: [
                  {
                    type: "function_call",
                    call_id: "call-1",
                    name: "read_file",
                    arguments: '{"path":"README.md"}',
                  },
                ],
                usage: { input_tokens: 100, output_tokens: 20 },
              },
            }) +
            "\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
      async () => ({ "api-key": "synthetic-provider-key" }),
    );
    const r = await provider.generate(
      [{ role: "user", content: "Read" }],
      [],
      new AbortController().signal,
    );
    assert.equal(r.calls[0].name, "read_file");
    assert.equal(r.inputTokens, 100);
    assert.equal(provider.cost(r), 0.00028);
    assert.equal(payload.store, false);
  }
});
test("Bedrock streams tool calls and uses the supplied credential-chain client", async () => {
  const fakeClient = {
    send: async () => ({
      stream: (async function* () {
        yield {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "x", name: "read_file" } },
          },
        };
        yield {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '{"path":"README.md"}' } },
          },
        };
        yield { messageStop: { stopReason: "tool_use" } };
        yield { metadata: { usage: { inputTokens: 30, outputTokens: 10 } } };
      })(),
    }),
  };
  const provider = new BedrockProvider(
    {
      kind: "bedrock",
      region: "eu-west-1",
      model: "test",
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    },
    fakeClient as any,
  );
  const r = await provider.generate(
    [{ role: "user", content: "Read" }],
    [],
    new AbortController().signal,
  );
  assert.equal(r.calls[0].arguments.path, "README.md");
  assert.equal(r.outputTokens, 10);
});
test("portable tools reject traversal, external symlinks and reviewer writes", async () => {
  const f = await fixture();
  await planned(f, [spec("one")]);
  const claim = f.store.claimNextTask("worker")!;
  await symlink("/tmp", join(f.repo, "outside"));
  const provider: ModelProvider = {
    generate: async () => ({
      text: "",
      calls: [],
      inputTokens: 0,
      outputTokens: 0,
    }),
    cost: () => 0,
  };
  const backend = new PortableBackend(provider);
  const c: RunContext = {
    claim,
    workspace: f.repo,
    mode: "implement",
    prompt: "Test",
    signal: new AbortController().signal,
    onCheckpoint: async () => {},
  };
  assert.match(
    await backend.tool(c, {
      id: "a",
      name: "read_file",
      arguments: { path: "../state.db" },
    }),
    /outside workspace/,
  );
  assert.match(
    await backend.tool(c, {
      id: "b",
      name: "write_file",
      arguments: { path: "outside/escape.txt", content: "x" },
    }),
    /Symlink/,
  );
  assert.match(
    await backend.tool(
      { ...c, mode: "review" },
      {
        id: "c",
        name: "write_file",
        arguments: { path: "README.md", content: "x" },
      },
    ),
    /Read-only/,
  );
});
test("automatic publication requires production exclusion and refuses deployment workflows", async () => {
  const f = await fixture();
  assert.throws(
    () =>
      f.store.createGoal({
        title: "Bad",
        description: "Unsafe",
        repoPath: f.repo,
        repository: { mode: "local" as const, branch: "development" },
        policy: { publish: true, autoMerge: true },
      }),
    /exclusion/,
  );
  await mkdir(join(f.repo, ".github/workflows"), { recursive: true });
  await writeFile(
    join(f.repo, ".github/workflows/deploy.yml"),
    "on:\n  push:\njobs:\n  deploy:\n    steps: []\n",
  );
  await assert.rejects(
    () => new GithubHost().checkWorkflows(f.repo, "development"),
    /deploy/,
  );
});

test("publication retention records recover after completion without resetting their window", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const created = f.store.createGoal({
    title: "Publication retention",
    description: "Implement one",
    repoPath: f.repo,
    repository: { mode: "local", branch: "development" },
    backend: { kind: "fake" },
    policy: { publish: true, autoMerge: false },
  });
  f.store.installPlan(created.id, { tasks: [spec("one")] }, created.revision);
  const goal = f.store.getGoal(created.id);
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    spawnWorkers: false,
    gitHost: {
      publish: async () => ({ url: "local://retention", merged: false }),
    },
  });
  const s = await serve(f, scheduler);
  t.after(() => s.server.close());
  const claim = f.store.claimNextTask("worker")!;
  await scheduler.workspaces.prepareTask(goal, claim.task);
  await executeClaim(s.client, claim, f.root);
  assert.equal(f.store.getTask(claim.task.id).status, "accepted");
  assert.ok(
    scheduler.workspaces.storage.workspaces().every((w) => w.unfinished),
  );
  await scheduler.publish(goal.id);
  assert.equal(f.store.getGoal(goal.id).status, "completed");
  // A reviewable unmerged PR does not authorize successful-work retirement.
  assert.ok(
    scheduler.workspaces.storage
      .workspaces()
      .every((w) => w.unfinished && !w.publication),
  );
  const candidate = f.store.setting(`publication:${goal.id}`);
  const result = f.store.getGoal(goal.id).result as any;
  // Crash boundary: completion is durable, but lifecycle records were not updated.
  f.db.exec(
    `UPDATE control_goals SET result=${sql(JSON.stringify({ ...result, publication: { url: "local://retention", merged: true } }))} WHERE id=${sql(goal.id)}`,
  );
  await scheduler.tick();
  const records = scheduler.workspaces.storage.workspaces();
  assert.ok(
    records.every(
      (w) => !w.unfinished && w.publication?.candidateSha === candidate.commit,
    ),
  );
  const acceptedAt = records[0].acceptedAt;
  f.advance(1000);
  await scheduler.publish(goal.id);
  assert.ok(
    scheduler.workspaces.storage
      .workspaces()
      .every((w) => w.acceptedAt === acceptedAt),
  );
});
