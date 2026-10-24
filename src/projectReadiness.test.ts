import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mkdtemp,
  writeFile,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  auditProjectReadiness,
  evidenceHash,
  projectSnapshotHash,
  formatReadinessReport,
  GATE_ASSERTIONS,
} from "./projectReadiness.js";
import { SUBSCRIPTION_GATES } from "./control/subscriptionQualification.js";
const asOf = "2026-10-22T12:00:00Z";
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../docs/fixtures/project-readiness/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
function complete() {
  const c = fixture("config"),
    s = fixture("status");
  c.projects = [c.projects[0]];
  s.projects = [s.projects[0]];
  const p = c.projects[0],
    r = p.requirements,
    st = s.projects[0];
  p.providerEnabled = true;
  Object.assign(p.project.config, {
    maxCostUsd: 0,
    estimatePerRunUsd: 0,
    maxAttempts: 2,
    timeoutMs: 600000,
    maxWorkers: 1,
  });
  r.projectHash = projectSnapshotHash(p.project);
  for (const key of [
    "configHash",
    "runtimeHash",
    "implementationHash",
    "authenticationPolicyHash",
  ])
    r[key] = "a".repeat(64);
  r.context[0].sha256 = "b".repeat(64);
  st.requirementsHash = evidenceHash(r);
  Object.assign(st, {
    paused: false,
    unknownUsageHold: false,
    hostPolicyAllowsExecution: true,
    dockerAvailable: true,
    executionImage: r.executionImage,
    verificationImage: r.verificationImage,
    authPrepared: true,
    authWriterActive: false,
  });
  st.qualification = {
    schemaVersion: 1,
    requirementsHash: st.requirementsHash,
    expiresAt: "2026-10-23T12:00:00Z",
    gates: SUBSCRIPTION_GATES.map((id) => {
      const evidence = {
        schemaVersion: 1,
        gate: id,
        passed: true,
        requirementsHash: st.requirementsHash,
        observedAt: asOf,
        assertions: [...GATE_ASSERTIONS[id]],
      };
      return { id, sha256: evidenceHash(evidence), evidence };
    }),
  };
  return { c, s };
}
test("public fixture is deterministic and installation/readiness claims grant no qualification", () => {
  const c = fixture("config"),
    s = fixture("status"),
    expected = fixture("expected");
  const report = auditProjectReadiness(c, s, asOf);
  assert.deepEqual(report, expected);
  assert.equal(
    formatReadinessReport(report),
    readFileSync(
      new URL(
        "../docs/fixtures/project-readiness/expected.txt",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  c.projects.reverse();
  s.projects.reverse();
  assert.deepEqual(auditProjectReadiness(c, s, asOf), expected);
  assert.ok(
    report.projects.every(
      (p) => p.schemaValid && !p.executionQualified && !p.ready,
    ),
  );
  assert.equal(
    report.projects.find((p) => p.id === "example-web")?.projectEnabled,
    false,
  );
  assert.ok(
    report.projects
      .find((p) => p.id === "example-python")
      ?.executionBlockers.includes("paused"),
  );
});
test("malformed, missing, secret-bearing, duplicated and unknown exports fail closed without echoing data", () => {
  const { c, s } = complete();
  for (const bad of [
    null,
    {},
    { ...c, schemaVersion: 2 },
    { ...c, credentials: "do-not-echo" },
    { ...c, projects: [] },
  ]) {
    const report = auditProjectReadiness(bad, s, asOf);
    assert.equal(report.exitCode, 2);
    assert.equal(JSON.stringify(report).includes("do-not-echo"), false);
  }
  assert.equal(auditProjectReadiness(c, null, asOf).exitCode, 2);
  assert.equal(auditProjectReadiness(c, s, "bad").exitCode, 2);
  s.projects.push(s.projects[0]);
  assert.equal(auditProjectReadiness(c, s, asOf).exitCode, 2);
  c.projects[0].project.config = { secret: "do-not-echo" };
  s.projects.pop();
  assert.equal(
    auditProjectReadiness(c, s, asOf).projects[0].schemaValid,
    false,
  );
});
test("matching evidence qualifies independently of enablement and current execution blockers", () => {
  const { c, s } = complete();
  assert.equal(auditProjectReadiness(c, s, asOf).exitCode, 0);
  c.projects[0].project.enabled = false;
  s.projects[0].authWriterActive = true;
  const p = auditProjectReadiness(c, s, asOf).projects[0];
  assert.equal(p.schemaValid, true);
  assert.equal(p.executionQualified, true);
  assert.equal(p.ready, false);
  assert.deepEqual(p.executionBlockers, [
    "authWriterActive",
    "project_disabled",
  ]);
});
test("exact binding, expiry, gate bytes/assertions and export freshness changes invalidate qualification", () => {
  const mutations: ((c: any, s: any) => void)[] = [
    (c) => (c.exportedAt = "2026-10-20T12:00:00Z"),
    (_, s) => (s.exportedAt = "2026-10-23T12:00:00Z"),
    (_, s) => (s.projects = []),
    (_, s) => (s.projects[0].qualification.expiresAt = asOf),
    (_, s) => (s.projects[0].qualification.expiresAt = "2026-12-01T12:00:00Z"),
    (_, s) => s.projects[0].qualification.gates.pop(),
    (_, s) =>
      (s.projects[0].qualification.gates[1] =
        s.projects[0].qualification.gates[0]),
    (_, s) => (s.projects[0].qualification.gates[0].evidence = null),
    (_, s) => (s.projects[0].qualification.gates[0].sha256 = "f".repeat(64)),
    (_, s) => {
      const g = s.projects[0].qualification.gates[0];
      g.evidence.assertions = [];
      g.sha256 = evidenceHash(g.evidence);
    },
    (_, s) =>
      (s.projects[0].qualification.gates[0].evidence.observedAt =
        "2026-10-20T12:00:00Z"),
    (_, s) => (s.projects[0].executionImage = null),
    (c) => (c.projects[0].requirements.runtime.model = "changed"),
  ];
  for (const field of [
    "implementationHash",
    "runtimeHash",
    "configHash",
    "authenticationPolicyHash",
    "executionImage",
    "verificationImage",
    "providerId",
    "model",
    "platform",
    "architecture",
    "exactBase",
    "repository",
    "targetBranch",
  ])
    mutations.push((c) => (c.projects[0].requirements[field] = null));
  for (const mutate of mutations) {
    const { c, s } = complete();
    mutate(c, s);
    const report = auditProjectReadiness(c, s, asOf);
    assert.equal(report.exitCode, 1);
    assert.equal(report.projects[0].executionQualified, false);
  }
  const { c, s } = complete();
  c.projects[0].requirements.contract.provider = "bedrock";
  assert.equal(auditProjectReadiness(c, s, asOf).exitCode, 2);
});
test("CLI reads only explicit regular exports, rejects bad flags/links/oversize and leaves files untouched", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mc-readiness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { c, s } = complete();
  await writeFile(join(dir, "config.json"), JSON.stringify(c));
  await writeFile(join(dir, "status.json"), JSON.stringify(s));
  await writeFile(join(dir, "private-sentinel"), "never-read-or-modify");
  const script = new URL(
    "../scripts/audit-project-readiness.mjs",
    import.meta.url,
  ).pathname;
  const args = [
    script,
    "--config-export",
    join(dir, "config.json"),
    "--status-export",
    join(dir, "status.json"),
    "--as-of",
    asOf,
    "--format",
    "json",
  ];
  const before = await readdir(dir);
  const run = (a: string[]) =>
    spawnSync(process.execPath, a, {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: "/nonexistent", HOME: dir, MC_CONFIG_DIR: dir },
      timeout: 10000,
    });
  const first = run(args),
    second = run(args);
  assert.equal(first.status, 0);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stderr, "");
  assert.equal(run([script]).status, 2);
  assert.equal(run([...args, "--discover", "yes"]).status, 2);
  assert.equal(run([...args, "--as-of", asOf]).status, 2);
  await symlink(join(dir, "config.json"), join(dir, "link.json"));
  const bad = [...args];
  bad[2] = join(dir, "link.json");
  assert.equal(run(bad).status, 2);
  bad[2] = join(dir, "missing.json");
  assert.equal(run(bad).status, 2);
  await writeFile(join(dir, "large.json"), " ".repeat(1024 * 1024 + 1));
  bad[2] = join(dir, "large.json");
  assert.equal(run(bad).status, 2);
  const hostile = join(dir, "hostile.json");
  for (const [flagIndex, content] of [
    [
      2,
      JSON.stringify(c).replace(
        '"schemaVersion":1',
        '"schemaVersion":2,"schemaVersion":1',
      ),
    ],
    [
      2,
      JSON.stringify(c).replace(
        '"schemaVersion":1',
        '"schemaVersion":2,"schema\\u0056ersion":1',
      ),
    ],
    [
      4,
      JSON.stringify(s).replace(
        '"paused":false',
        '"paused":true,"paused":false',
      ),
    ],
    [
      4,
      JSON.stringify(s).replace(
        '"passed":true',
        '"passed":false,"passed":true',
      ),
    ],
    [
      2,
      JSON.stringify(c).replace(
        '"name":"ExampleEngine"',
        '"name":' + "[".repeat(33) + "null" + "]".repeat(33),
      ),
    ],
    [
      2,
      Buffer.concat([
        Buffer.from(JSON.stringify(c).split("ExampleEngine")[0]),
        Buffer.from([0xff]),
        Buffer.from(
          JSON.stringify(c).slice(
            JSON.stringify(c).indexOf("ExampleEngine") + "ExampleEngine".length,
          ),
        ),
      ]),
    ],
  ] as const) {
    await writeFile(hostile, content);
    const hostileArgs = [...args];
    hostileArgs[flagIndex] = hostile;
    const result = run(hostileArgs);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).inputValid, false);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(hostile), false);
  }
  assert.equal(
    await readFile(join(dir, "private-sentinel"), "utf8"),
    "never-read-or-modify",
  );
  assert.equal(
    await readFile(join(dir, "config.json"), "utf8"),
    JSON.stringify(c),
  );
  assert.deepEqual(
    (await readdir(dir)).filter(
      (n) => !["link.json", "large.json", "hostile.json"].includes(n),
    ),
    before,
  );
});
