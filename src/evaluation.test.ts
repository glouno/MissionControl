import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FIXTURES,
  DEFAULT_BUDGET,
  IDENTITIES,
  EventAccumulator,
  parseConfig,
  prepare,
  evaluate,
  selfVerify,
  boundedProcess,
  runAdapter,
  readManifest,
  report,
  admission,
  comparisonFlags,
  eligible,
  summarize,
  type RunConfig,
} from "./evaluation.js";
const root = resolve(new URL("../", import.meta.url).pathname);
const config = (executable = process.execPath): RunConfig =>
  parseConfig({
    schemaVersion: 1,
    identity: "codex-native",
    executable,
    executableVersion: "fixture-v1",
    nativeVersion: "fixture-v1",
    wrapperRevision: "fixture-v1",
    evidence: "synthetic",
    settings: {
      model: "fixture",
      reasoning: "medium",
      authentication: "none",
      billing: "none",
      permissions: "repo-write",
      isolation: "synthetic",
      environment: "node24-linux",
    },
    budget: {},
  });
const hello = (c: RunConfig) => ({
  schemaVersion: 1,
  seq: 0,
  type: "hello",
  identity: c.identity,
  effectiveSettings: c.settings,
  supportedSettings: Object.keys(c.settings),
  executableVersion: c.executableVersion,
  nativeVersion: c.nativeVersion,
});
const measured = (value: number) => ({
  value,
  provenance: "measured" as const,
});
async function temp(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "mc-evaluation-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("both fixtures have reproducible pinned trees and independent exact acceptance", async () => {
  const result = await selfVerify(root);
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.evidence.map((e) => e.startTree),
    [
      "37ba7dd1f9433af0491103b82342a6be067f1355",
      "dfede0bef930b99e3ae83d80708fda3ebb3ac704",
    ],
  );
});
test("acceptance rejects forbidden files, Git tampering, symlinks and checker bypass", async (t) => {
  const dir = await temp(t);
  for (const [i, attack] of [
    "extra",
    "git",
    "symlink",
    "spoof",
    "prototype-toJSON",
    "own-toJSON",
    "getter",
    "descriptor-spoof",
    "escape",
    "loop",
  ].entries()) {
    const run = join(dir, String(i)),
      m = await prepare("inventory", run, root),
      repo = join(run, "repo");
    await writeFile(join(repo, "reservation.mjs"), FIXTURES.inventory.solution);
    if (attack === "extra")
      await writeFile(join(repo, "checker.mjs"), "process.exit(0)");
    if (attack === "git")
      await writeFile(join(repo, ".git", "config"), "tampered");
    if (attack === "symlink") {
      await rm(join(repo, "reservation.mjs"));
      await symlink(
        join(root, "src", "evaluation.ts"),
        join(repo, "reservation.mjs"),
      );
    }
    if (attack === "spoof")
      await writeFile(
        join(repo, "reservation.mjs"),
        'JSON.stringify=()=>\'{"value":{"ok":true,"reserved":1}}\'; export function reserve(){return null}',
      );
    // Fabricate the correct answer for every case while returning null. A
    // captured JSON.stringify still calls inherited toJSON on the envelope.
    if (attack === "prototype-toJSON")
      await writeFile(
        join(repo, "reservation.mjs"),
        `${FIXTURES.inventory.solution.replace("export function reserve", "function expected")} let answer; Object.prototype.toJSON = function(){return answer}; export function reserve(...args){answer={value:expected(...args)};return null}`,
      );
    if (attack === "own-toJSON")
      await writeFile(
        join(repo, "reservation.mjs"),
        `${FIXTURES.inventory.solution.replace("export function reserve", "function expected")} export function reserve(...args){return {toJSON(){return expected(...args)}}}`,
      );
    if (attack === "getter" || attack === "descriptor-spoof")
      await writeFile(
        join(repo, "reservation.mjs"),
        `${attack === "descriptor-spoof" ? "Object.prototype.value=true;Object.getOwnPropertyDescriptor=()=>({value:true});" : ""} export function reserve(){return {get ok(){return true},reserved:1}}`,
      );
    if (attack === "escape")
      await writeFile(
        join(repo, "reservation.mjs"),
        "export function reserve(){return this.constructor.constructor('return process')().exit(0)}",
      );
    if (attack === "loop")
      await writeFile(
        join(repo, "reservation.mjs"),
        "export function reserve(){while(true){}}",
      );
    assert.equal(
      (await evaluate("inventory", repo, m.baseline)).passed,
      false,
      attack,
    );
  }
});
test("acceptance rejects Proxy descriptor lies before running traps", async (t) => {
  const dir = await temp(t);
  for (const attack of ["descriptor-lie", "trap-loop", "nested", "revoked"]) {
    const run = join(dir, attack),
      m = await prepare("inventory", run, root),
      repo = join(run, "repo");
    const proxy =
      attack === "descriptor-lie"
        ? `return new Proxy({ok:false,reserved:-999}, {
          get: (target,key) => target[key],
          getOwnPropertyDescriptor: (target,key) => ({value:answer[key],enumerable:true,configurable:true,writable:true})
        });`
        : attack === "trap-loop"
          ? `return new Proxy(answer, {ownKeys(){while(true){}}});`
          : attack === "nested"
            ? `return {ok:answer.ok,reserved:new Proxy({}, {ownKeys(){while(true){}}})};`
            : `const {proxy,revoke}=Proxy.revocable(answer,{}); revoke(); return proxy;`;
    await writeFile(
      join(repo, "reservation.mjs"),
      `${FIXTURES.inventory.solution.replace("export function reserve", "function expected")}
       export function reserve(...args){const answer=expected(...args); ${proxy}}`,
    );
    const result = await evaluate("inventory", repo, m.baseline);
    assert.equal(result.passed, false, attack);
    assert.equal(result.reason, "checker-execution-failed", attack);
    assert.ok(result.candidateHash);
  }
});
test("acceptance evaluates original ES module syntax and named exports", async (t) => {
  const dir = await temp(t);
  for (const id of ["inventory", "csv"] as const) {
    const f = FIXTURES[id],
      run = join(dir, id),
      m = await prepare(id, run, root),
      repo = join(run, "repo");
    for (const source of [
      f.solution + f.solution,
      f.solution.replace("export function", "function"),
      `import "node:fs"; ${f.solution}`,
      `import "./missing.mjs"; ${f.solution}`,
      `with ({}) {} ${f.solution}`,
    ]) {
      await writeFile(join(repo, f.file), source);
      const result = await evaluate(id, repo, m.baseline);
      assert.equal(result.passed, false, source);
      assert.equal(result.reason, "checker-execution-failed");
    }
    // Legal module exports need not use an inline export declaration.
    await writeFile(
      join(repo, f.file),
      f.solution.replace("export function", "function") +
        `\nexport {${f.entry}};`,
    );
    assert.equal((await evaluate(id, repo, m.baseline)).passed, true);
  }
});
test("event contract rejects malformed identity, sequencing and measurements; preserves missing/partial usage", () => {
  const c = config(),
    s = new EventAccumulator(c);
  s.accept(hello(c));
  assert.equal(s.metrics.totalTokens.value, null);
  assert.equal(s.metrics.costUsd.provenance, "unknown");
  s.accept({
    schemaVersion: 1,
    seq: 1,
    type: "measurement",
    metrics: { inputTokens: measured(10), cacheReadTokens: measured(5) },
    costBasis: "unknown",
  });
  assert.equal(s.metrics.totalTokens.value, null);
  assert.throws(() =>
    s.accept({
      schemaVersion: 1,
      seq: 2,
      type: "measurement",
      metrics: { inputTokens: measured(3) },
      costBasis: "unknown",
    }),
  );
  assert.equal(s.metrics.inputTokens.value, 10);
  assert.throws(() =>
    s.accept({
      schemaVersion: 1,
      seq: 2,
      type: "result",
      outcome: "completed",
      secret: "not retained",
    }),
  );
  s.accept({ schemaVersion: 1, seq: 2, type: "result", outcome: "cancelled" });
  assert.equal(s.outcome, "cancelled");
  assert.throws(() => s.accept({ schemaVersion: 1, seq: 3, type: "restart" }));
  assert.throws(() =>
    new EventAccumulator(c).accept({
      ...hello(c),
      identity: "openhands-sdk-model-loop",
    }),
  );
  const sub = config();
  sub.settings.authentication = "subscription";
  sub.settings.billing = "subscription";
  const subscription = new EventAccumulator(sub);
  subscription.accept(hello(sub));
  assert.throws(() =>
    subscription.accept({
      schemaVersion: 1,
      seq: 1,
      type: "measurement",
      metrics: { costUsd: measured(0) },
      costBasis: "provider-receipt",
    }),
  );
});
test("capability mismatches and budget limits fail closed", () => {
  const c = config(),
    s = new EventAccumulator(c);
  s.accept({
    ...hello(c),
    effectiveSettings: { ...c.settings, reasoning: "unknown" },
    supportedSettings: ["model"],
  });
  assert.ok(s.flags.includes("unsupported:reasoning"));
  assert.ok(s.flags.includes("mismatch:reasoning"));
  assert.throws(() => parseConfig({ ...c, budget: { timeoutMs: 300001 } }));
  assert.throws(() => parseConfig({ ...c, budget: { maxAttempts: 4 } }));
  assert.throws(() =>
    parseConfig({ ...c, budget: { maxOutputBytes: 1048577 } }),
  );
  assert.deepEqual(c.budget, DEFAULT_BUDGET);
});
test("bounded processes retain evidence on malformed output, timeout, cancellation and output overflow", async (t) => {
  const cwd = await temp(t);
  const run = (code: string, options = {}) =>
    boundedProcess(process.execPath, ["-e", code], "", {
      cwd,
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      ...options,
    });
  const malformed = await run("console.log('not json')", {
    onLine: (line: string) => JSON.parse(line),
  });
  assert.equal(malformed.outcome, "malformed");
  assert.ok(malformed.outputBytes > 0);
  const timeout = await run("console.log('partial');setInterval(()=>{},1000)");
  assert.equal(timeout.outcome, "timeout");
  assert.ok(timeout.stdout.includes("partial"));
  const controller = new AbortController();
  const promise = run("setInterval(()=>{},1000)", {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 30);
  assert.equal((await promise).outcome, "cancelled");
  const overflow = await run("process.stdout.write('x'.repeat(4096))");
  assert.equal(overflow.outcome, "output-limit");
  assert.equal(overflow.outputBytes, 1024);
});
async function wrapper(dir: string, events: unknown[], tail = "") {
  const file = join(dir, "adapter.cjs");
  const source = `#!${process.execPath}\nlet input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const r=JSON.parse(input);require('node:fs').writeFileSync(require('node:path').join(r.repository,'reservation.mjs'),${JSON.stringify(FIXTURES.inventory.solution)});${events.map((e) => `console.log(${JSON.stringify(JSON.stringify(e))});`).join("")} ${tail}});\n`;
  await writeFile(file, source, { mode: 0o700 });
  return file;
}
test("synthetic adapter attempts preserve successes, failure history, cancellation and restart accounting without live conclusions", async (t) => {
  const dir = await temp(t);
  const c = config();
  const events = [
    hello(c),
    {
      schemaVersion: 1,
      seq: 1,
      type: "measurement",
      metrics: { totalTokens: measured(12), cacheWriteTokens: measured(2) },
      costBasis: "unknown",
    },
    { schemaVersion: 1, seq: 2, type: "result", outcome: "completed" },
  ];
  c.executable = await wrapper(dir, events);
  const run = join(dir, "good");
  await prepare("inventory", run, root);
  const a = await runAdapter(run, c, root);
  assert.equal(a.acceptance.passed, true, JSON.stringify(a));
  assert.equal(a.outcome, "completed");
  assert.equal(a.metrics.costUsd.value, null);
  const m = await readManifest(run);
  assert.equal(eligible(m), false);
  assert.equal(
    report([m]).liveMatrix.every((r) => r.status === "pending"),
    true,
  );
  await assert.rejects(runAdapter(run, c, root), /attempt-limit/);
  const failedDir = join(dir, "failed");
  await prepare("inventory", failedDir, root);
  c.executable = await wrapper(
    dir,
    events.slice(0, 2),
    "console.log('broken');",
  );
  const failed = await runAdapter(failedDir, c, root);
  assert.equal(failed.outcome, "malformed");
  assert.equal(failed.metrics.totalTokens.value, 12);
  assert.equal(failed.metrics.costUsd.value, null);
  assert.ok(
    admission([failed], {
      ...c,
      budget: { ...c.budget, maxAttempts: 2 },
    }).includes("unknown-token-admission"),
  );
  const restartsDir = join(dir, "restart");
  await prepare("inventory", restartsDir, root);
  c.executable = await wrapper(dir, [
    hello(c),
    { schemaVersion: 1, seq: 1, type: "restart" },
  ]);
  const restarted = await runAdapter(restartsDir, c, root);
  assert.equal(restarted.restarts, 1);
  assert.ok(restarted.flags.includes("restart-limit"));
  assert.ok(admission([restarted], c).includes("unknown-token-admission"));
  const cancelledDir = join(dir, "cancelled");
  await prepare("inventory", cancelledDir, root);
  c.executable = await wrapper(
    dir,
    [hello(c), events[1]],
    "setInterval(()=>{},1000);",
  );
  const controller = new AbortController();
  const pending = runAdapter(cancelledDir, c, root, controller.signal);
  setTimeout(() => controller.abort(), 750);
  const cancelled = await pending;
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(cancelled.metrics.totalTokens.value, 12);
  assert.ok(
    admission([cancelled], {
      ...c,
      budget: { ...c.budget, maxAttempts: 2 },
    }).includes("unknown-token-admission"),
  );
  const timeoutDir = join(dir, "timeout");
  await prepare("inventory", timeoutDir, root);
  c.budget.timeoutMs = 750;
  const timed = await runAdapter(timeoutDir, c, root);
  assert.equal(timed.outcome, "timeout");
  assert.equal(timed.metrics.totalTokens.value, 12);
  const history = await readManifest(timeoutDir);
  assert.equal(history.attempts.length, 1);
  assert.equal(history.attempts[0].outcome, "timeout");
  const retryConfig = { ...c, budget: { ...c.budget, maxAttempts: 2 } };
  assert.ok(
    admission(history.attempts, retryConfig).includes(
      "unknown-token-admission",
    ),
  );
  assert.equal(summarize(history).usageComplete, false);
  assert.ok(comparisonFlags(m, history).includes("budget-mismatch"));
  history.attempts[0].config.identity = "openhands-sdk-model-loop";
  assert.ok(comparisonFlags(m, history).includes("execution-family-mismatch"));
  assert.equal(IDENTITIES.length, 4);
});
test("explicit continuation retains attempt history and sums restarts without unknown zero", async (t) => {
  const dir = await temp(t),
    run = join(dir, "history"),
    c = config();
  c.budget.maxAttempts = 2;
  c.budget.maxRestarts = 1;
  c.executable = await wrapper(dir, [
    hello(c),
    { schemaVersion: 1, seq: 1, type: "restart" },
    { schemaVersion: 1, seq: 2, type: "intervention" },
    {
      schemaVersion: 1,
      seq: 3,
      type: "measurement",
      metrics: { totalTokens: measured(12) },
      costBasis: "unknown",
    },
    { schemaVersion: 1, seq: 4, type: "result", outcome: "failed" },
  ]);
  await prepare("inventory", run, root);
  await runAdapter(run, c, root);
  await runAdapter(run, c, root);
  const m = await readManifest(run),
    summary = summarize(m);
  assert.equal(m.attempts.length, 2);
  assert.equal(summary.restarts, 2);
  assert.equal(summary.interventions, 1);
  assert.equal(summary.metrics.costUsd.value, null);
  assert.equal(summary.metrics.totalTokens.value, null);
  assert.equal(m.attempts[1].outcome, "malformed");
  assert.ok(m.attempts[1].flags.includes("restart-limit"));
  assert.ok(admission(m.attempts, c).includes("restart-limit"));
  assert.equal(report([m, m]).comparisons[0].status, "excluded");
});
test("partial receipts block readmission after timeout, cancellation, crash or malformed protocol", async (t) => {
  const dir = await temp(t);
  for (const outcome of [
    "timeout",
    "cancelled",
    "failed",
    "malformed",
  ] as const) {
    const run = join(dir, outcome),
      c = config();
    c.budget.maxAttempts = 2;
    c.budget.timeoutMs = 750;
    c.settings.authentication = "api";
    c.settings.billing = "metered";
    c.executable = await wrapper(
      dir,
      [
        hello(c),
        {
          schemaVersion: 1,
          seq: 1,
          type: "measurement",
          metrics: { totalTokens: measured(12), costUsd: measured(0.1) },
          costBasis: "provider-receipt",
        },
      ],
      outcome === "failed"
        ? "process.exitCode=1;"
        : outcome === "malformed"
          ? "console.log('broken');"
          : "setInterval(()=>{},1000);",
    );
    await prepare("inventory", run, root);
    const controller = new AbortController();
    const promise = runAdapter(run, c, root, controller.signal);
    if (outcome === "cancelled") setTimeout(() => controller.abort(), 500);
    const a = await promise;
    assert.equal(a.outcome, outcome);
    assert.equal(a.metrics.totalTokens.value, 12);
    assert.equal(a.metrics.costUsd.value, 0.1);
    const blockers = admission([a], c);
    assert.ok(blockers.includes("unknown-token-admission"));
    assert.ok(blockers.includes("unknown-cost-admission"));
    await assert.rejects(runAdapter(run, c, root), /unknown-token-admission/);
    assert.equal((await readManifest(run)).attempts.length, 1);
  }
});
test("remaining restart allowance reaches adapters and over-budget live-shaped histories are excluded", async (t) => {
  const dir = await temp(t),
    run = join(dir, "run"),
    c = config();
  c.budget.maxAttempts = 2;
  c.budget.maxRestarts = 1;
  c.executable = await wrapper(
    dir,
    [
      hello(c),
      { schemaVersion: 1, seq: 1, type: "restart" },
      {
        schemaVersion: 1,
        seq: 2,
        type: "measurement",
        metrics: { totalTokens: measured(12), agentMs: measured(1) },
        costBasis: "unknown",
      },
      { schemaVersion: 1, seq: 3, type: "result", outcome: "completed" },
    ],
    "if(r.budget.maxRestarts!==(r.attempt===1?1:0))process.exitCode=1;",
  );
  await prepare("inventory", run, root);
  const first = await runAdapter(run, c, root);
  assert.equal(first.outcome, "completed");
  assert.deepEqual(admission([first], c), []);
  for (const outcome of [
    "timeout",
    "malformed",
    "output-limit",
    "interrupted",
  ] as const) {
    assert.ok(
      admission([{ ...first, outcome }], c).includes("unknown-token-admission"),
    );
  }
  assert.ok(
    admission([{ ...first, exitCode: 1 }], c).includes(
      "unknown-token-admission",
    ),
  );
  assert.ok(
    admission([{ ...first, signal: "SIGKILL" }], c).includes(
      "unknown-token-admission",
    ),
  );
  const second = await runAdapter(run, c, root);
  assert.equal(second.restarts, 1);
  assert.equal(second.outcome, "malformed");
  assert.ok(second.flags.includes("restart-limit"));
  const m = await readManifest(run);
  // Historical/manually supplied report input must independently enforce the
  // budget even when earlier controllers failed to attach attempt flags.
  for (const a of m.attempts) {
    Object.assign(a, structuredClone(first), {
      index: a.index,
      evidence: "live",
      outcome: "completed",
      flags: [],
    });
    a.config.evidence = "live";
    a.wallMs = measured(1);
    a.metrics.totalTokens = measured(12);
    a.metrics.agentMs = measured(1);
  }
  assert.equal(summarize(m).restarts, 2);
  assert.equal(eligible(m), false);
  const comparison = report([m, structuredClone(m)]).comparisons[0];
  assert.equal(comparison.status, "excluded");
  assert.ok(comparison.flags.includes("restart-limit"));
  // Other run-wide reported limits also cannot be hidden by splitting attempts.
  m.attempts.forEach((a) => (a.restarts = 0));
  assert.equal(eligible(m), true);
  m.attempts.forEach((a) => (a.config.budget.maxReportedTokens = 20));
  assert.equal(eligible(m), false);
  m.attempts.forEach((a) => {
    a.config.budget.maxReportedTokens = 100;
    a.config.settings.billing = "metered";
    a.config.budget.maxReportedCostUsd = 1;
    a.metrics.costUsd = measured(0.75);
  });
  assert.equal(eligible(m), false);
  assert.ok(
    report([m, m]).comparisons[0].flags.includes("reported-cost-limit"),
  );
  m.attempts.forEach((a) => {
    a.config.budget.maxReportedCostUsd = 5;
    a.config.budget.maxAttempts = 1;
  });
  assert.equal(eligible(m), false);
  assert.ok(report([m, m]).comparisons[0].flags.includes("attempt-limit"));
});
test("MissionControl live subscription cannot bypass private qualification and auth stays outside manifests", async (t) => {
  const dir = await temp(t),
    run = join(dir, "gate");
  await prepare("inventory", run, root);
  const c = config();
  c.identity = "missioncontrol-codex-native";
  c.evidence = "live";
  c.settings.authentication = "subscription";
  c.settings.billing = "subscription";
  await assert.rejects(runAdapter(run, c, root), /qualification/);
  assert.equal((await readManifest(run)).attempts.length, 0);
  assert.equal(
    (await readFile(join(run, "manifest.json"), "utf8")).includes(
      "process.env",
    ),
    false,
  );
});
