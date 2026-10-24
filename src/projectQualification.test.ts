import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  mkdtemp,
  writeFile,
  symlink,
  rm,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  PROJECT_PROFILES,
  qualifyProjects,
  parseQualificationJson,
  readQualificationInput,
  configurationFingerprint,
  type QualificationInputs,
} from "./projectQualification.js";

const fixtureBundle = JSON.parse(
  (await readFile(resolve("docs/project-qualification.md"), "utf8"))
    .split("<!-- qualification-fixtures-v1 -->\n\n```json\n")[1]
    .split("\n```")[0],
) as Record<string, unknown>;
async function fixtures(): Promise<QualificationInputs> {
  return structuredClone(
    Object.fromEntries(
      [
        "expectations",
        "configuration",
        "repositories",
        "artifacts",
        "checks",
      ].map((name) => [name, fixtureBundle[name]]),
    ),
  ) as unknown as QualificationInputs;
}
// Test mutations exercise deliberately hostile external JSON.
type Document = {
  projects: Record<string, any>[];
  receipts: Record<string, any>[];
};
function document(
  input: QualificationInputs,
  name: keyof QualificationInputs,
): Document {
  return input[name] as Document;
}

test("four fixture profiles qualify deterministic supplied evidence only", async () => {
  const input = await fixtures();
  const report = qualifyProjects(input);
  assert.equal(report.suppliedEvidenceQualified, true);
  assert.equal(report.fixtureOutcome, "passed");
  assert.deepEqual(
    report.projects.map((p) => p.profile),
    PROJECT_PROFILES,
  );
  assert.equal(report.actualPrivateApplicationAcceptance, "unresolved");
  assert.equal(report.nativeMacAcceptance, "unresolved");
  assert.equal(report.liveSubscriptionExecution, "unresolved");
  assert.equal(
    report.toolingDelivery,
    "requires-mc-check-and-controller-review",
  );
  assert.equal(JSON.stringify(report), JSON.stringify(qualifyProjects(input)));
  const config = document(input, "configuration").projects[0];
  assert.equal(
    configurationFingerprint(config),
    configurationFingerprint(
      Object.fromEntries(Object.entries(config).reverse()),
    ),
  );
});

test("missing and stale fixture receipts block all profiles", async () => {
  for (const [key, file, issue] of [
    ["artifacts", "missing-artifacts", "missing artifact"],
    ["checks", "stale-checks", "pins mismatch"],
  ] as const) {
    const input = await fixtures();
    input[key] = structuredClone(fixtureBundle[file]);
    const report = qualifyProjects(input);
    assert.equal(report.suppliedEvidenceQualified, false);
    assert.equal(report.fixtureOutcome, "blocked");
    for (const project of report.projects) {
      assert.equal(project.qualified, false);
      assert(project.issues.some((i) => i.includes(issue)));
      assert(project.nextCommands.length > 0);
    }
  }
});

test("dependency-lock keys cannot disappear from any qualification input", async () => {
  for (const name of [
    "expectations",
    "configuration",
    "repositories",
    "artifacts",
    "checks",
  ] as const)
    for (let index = 0; index < 4; index++) {
      const input = await fixtures();
      const doc = document(input, name);
      const row = (doc.projects ?? doc.receipts)[index];
      const binding = name === "configuration" ? row.config : row;
      Object.defineProperty(binding.dependencyLocks, "__proto__", {
        value: "f".repeat(64),
        enumerable: true,
      });
      assert.equal(
        qualifyProjects(input).suppliedEvidenceQualified,
        false,
        `${name}/${index}: silently discarded lock`,
      );
    }
});

test("every binding in every receipt family and profile fails closed", async () => {
  const changes: Record<string, unknown> = {
    repository: "fixture:wrong",
    baseCommit: "d".repeat(40),
    candidateCommit: "e".repeat(40),
    configurationSha256: "f".repeat(64),
    dependencyLocks: { "package-lock.json": "f".repeat(64) },
    executionImage: `sha256:${"f".repeat(64)}`,
    verificationImage: `sha256:${"f".repeat(64)}`,
    projectId: "wrong",
    evidenceRevision: "stale",
    platform: { os: "macos", hostFingerprintSha256: "f".repeat(64) },
  };
  for (const name of ["repositories", "artifacts", "checks"] as const)
    for (let index = 0; index < 4; index++)
      for (const [field, value] of Object.entries(changes)) {
        const input = await fixtures();
        document(input, name).receipts[index][field] = value;
        const report = qualifyProjects(input);
        assert.equal(
          report.suppliedEvidenceQualified,
          false,
          `${name}/${index}/${field}`,
        );
        assert.equal(report.projects[index].qualified, false);
      }
  for (let index = 0; index < 4; index++)
    for (const name of [
      "configuration",
      "repositories",
      "artifacts",
      "checks",
    ] as const)
      for (const pin of ["DependencyA", "DependencyB"])
        for (const field of [
          "repository",
          "commit",
          "configurationSha256",
          "imageDigest",
        ]) {
          const input = await fixtures();
          const row =
            name === "configuration"
              ? document(input, name).projects[index].config
              : document(input, name).receipts[index];
          row.pins[pin][field] =
            field === "repository"
              ? "fixture:wrong"
              : field === "commit"
                ? "d".repeat(40)
                : field === "imageDigest"
                  ? `sha256:${"f".repeat(64)}`
                  : "f".repeat(64);
          assert.equal(
            qualifyProjects(input).suppliedEvidenceQualified,
            false,
            `${name}/${index}/${pin}/${field}`,
          );
        }
});

test("malformed, duplicate, failed and empty evidence never qualifies", async () => {
  const mutations: ((input: QualificationInputs) => void)[] = [
    (i) => {
      i.checks = null;
    },
    (i) => {
      document(i, "checks").receipts[0].commands[0].command = "   ";
    },
    (i) => {
      document(i, "checks").receipts[0].commands = [];
    },
    (i) => {
      document(i, "checks").receipts[0].commands[0].status = "failed";
    },
    (i) => {
      document(i, "checks").receipts[0].commands[0].exitCode = 1;
    },
    (i) => {
      document(i, "checks").receipts[0].commands.pop();
    },
    (i) => {
      document(i, "checks").receipts[0].commands.push(
        document(i, "checks").receipts[0].commands[0],
      );
    },
    (i) => {
      document(i, "artifacts").receipts[0].artifacts = [];
    },
    (i) => {
      document(i, "artifacts").receipts[0].artifacts[0].sha256 = "unknown";
    },
    (i) => {
      document(i, "artifacts").receipts[0].artifacts.pop();
    },
    (i) => {
      document(i, "artifacts").receipts[0].artifacts.push(
        document(i, "artifacts").receipts[0].artifacts[0],
      );
    },
    (i) => {
      document(i, "repositories").receipts[0].clean = false;
    },
    (i) => {
      document(i, "configuration").projects[0].enabled = false;
    },
    (i) => {
      document(i, "configuration").projects[0].config.verificationCommands = [];
    },
    (i) => {
      document(i, "configuration").projects[0].config.executionImage = "latest";
    },
    (i) => {
      document(i, "expectations").projects[0].pins.DependencyA = null;
    },
    (i) => {
      document(i, "expectations").projects[0].localVerificationDocumentation =
        [];
    },
    (i) => {
      document(i, "checks").receipts[0].unknownField = true;
    },
  ];
  for (const mutate of mutations) {
    const input = await fixtures();
    mutate(input);
    assert.equal(qualifyProjects(input).suppliedEvidenceQualified, false);
  }
  for (const name of [
    "expectations",
    "configuration",
    "repositories",
    "artifacts",
    "checks",
  ] as const) {
    const input = await fixtures(),
      doc = document(input, name),
      rows = doc.projects ?? doc.receipts;
    rows[1] = rows[0];
    assert.equal(qualifyProjects(input).suppliedEvidenceQualified, false, name);
  }
  for (const name of ["repositories", "artifacts", "checks"] as const) {
    const input = await fixtures();
    document(input, name).receipts = [];
    assert.equal(qualifyProjects(input).suppliedEvidenceQualified, false);
  }
});

test("host and authority gaps remain explicit and commands are display only", async () => {
  const input = await fixtures();
  document(input, "checks").receipts[0].hostStatus = "unknown";
  document(input, "checks").receipts[0].authorities.statusWriter = null;
  document(
    input,
    "checks",
  ).receipts[0].authorities.protectedIntegration.principal = "worker";
  const report = qualifyProjects(input);
  const issues = report.projects[0].issues.join("\n");
  assert.match(issues, /platform\/host blocker/);
  assert.match(issues, /authority gap: statusWriter/);
  assert.match(issues, /authority gap: protectedIntegration/);
});

test("JSON parser and file reader bound hostile inputs without accepting discarded keys", async (t) => {
  for (const source of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"x": {"a":1,"a":2}}',
    '{"__proto__":"unexpected"}',
    '{"x":{"\\u005f_proto__":"unexpected"}}',
    "[1,]",
    "true true",
    '{"a": nope}',
    " ".repeat(1024 * 1024 + 1),
    "[".repeat(34) + "0" + "]".repeat(34),
    "[" + "0,".repeat(20000) + "0]",
  ])
    assert.throws(() => parseQualificationJson(source));
  assert.deepEqual(parseQualificationJson('{"x":[null,true,1,"a"]}'), {
    x: [null, true, 1, "a"],
  });
  const root = await mkdtemp(join(tmpdir(), "mc-project-qualification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "input.json"),
    link = join(root, "link.json");
  await writeFile(file, "{}");
  await symlink(file, link);
  await assert.rejects(readQualificationInput(link), /canonical/);
  await assert.rejects(readQualificationInput(root), /regular/);
  await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(readQualificationInput(file), /bounded/);
  await writeFile(file, Buffer.from([0xff]));
  await assert.rejects(readQualificationInput(file));
});

test("CLI requires all explicit files, emits stable JSON and never runs supplied commands", async (t) => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["scripts/qualify-projects.mjs", ...args], {
      encoding: "utf8",
    });
  const fixtureRoot = await mkdtemp(join(tmpdir(), "mc-project-cli-fixtures-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(fixtureBundle))
    await writeFile(join(fixtureRoot, `${name}.json`), JSON.stringify(value));
  const args = [
    "expectations",
    "configuration",
    "repositories",
    "artifacts",
    "checks",
  ].flatMap((name) => [`--${name}`, join(fixtureRoot, `${name}.json`)]);
  assert.equal(run([]).status, 2);
  assert.equal(run([...args.slice(0, -2), "--artifacts", args[1]]).status, 2);
  assert.equal(run([...args, "--extra", "file"]).status, 2);
  const valid = run(args);
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  assert.equal(valid.stdout, run(args).stdout);
  for (const name of [
    "expectations",
    "configuration",
    "repositories",
    "artifacts",
    "checks",
  ] as const) {
    const input = await fixtures();
    const doc = document(input, name);
    const row = (doc.projects ?? doc.receipts)[0];
    const binding = name === "configuration" ? row.config : row;
    Object.defineProperty(binding.dependencyLocks, "__proto__", {
      value: "f".repeat(64),
      enumerable: true,
    });
    const file = join(fixtureRoot, `${name}.json`);
    await writeFile(file, JSON.stringify(input[name]));
    const rejected = run(args);
    assert.equal(rejected.status, 2, `${name}: ${rejected.stdout}`);
    await writeFile(file, JSON.stringify(fixtureBundle[name]));
  }
  const missing = [...args];
  missing[7] = join(fixtureRoot, "missing-artifacts.json");
  assert.equal(run(missing).status, 1);
  const stale = [...args];
  stale[9] = join(fixtureRoot, "stale-checks.json");
  assert.equal(run(stale).status, 1);
  const root = await mkdtemp(join(tmpdir(), "mc-project-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixtures(),
    marker = join(root, "executed"),
    command = `touch ${marker}`;
  for (let index = 0; index < 4; index++) {
    document(input, "expectations").projects[index].requiredCommands = [
      command,
    ];
    document(input, "configuration").projects[
      index
    ].config.verificationCommands = [command];
    const fingerprint = configurationFingerprint(
      document(input, "configuration").projects[index],
    );
    document(input, "expectations").projects[index].configurationSha256 =
      fingerprint;
    for (const name of ["repositories", "artifacts", "checks"] as const)
      document(input, name).receipts[index].configurationSha256 = fingerprint;
    document(input, "checks").receipts[index].commands = [
      { command, status: "pending", exitCode: 1 },
    ];
  }
  const hostileArgs: string[] = [];
  for (const [name, value] of Object.entries(input)) {
    const path = join(root, `${name}.json`);
    await writeFile(path, JSON.stringify(value));
    hostileArgs.push(`--${name}`, path);
  }
  const hostile = run(hostileArgs);
  assert.equal(hostile.status, 1);
  assert(hostile.stdout.includes(command));
  await assert.rejects(access(marker));
  await writeFile(
    join(root, "checks.json"),
    '{"schemaVersion":1,"schemaVersion":1}',
  );
  assert.equal(run(hostileArgs).status, 2);
});
