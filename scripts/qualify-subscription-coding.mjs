import "./canonical-temp.mjs";
// Real Linux Docker mechanics with synthetic native tools, no vendor login/inference.
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { git } from "../dist/control/git.js";
import { initializeState, lockInstance } from "../dist/instance.js";
import { SqliteStore } from "../dist/sqlite.js";
import { ControlStore } from "../dist/control/store.js";
import {
  EnvironmentRegistry,
  DockerEnvironment,
} from "../dist/control/environments.js";
import {
  authEnvironmentSchema,
  initializeAuthEnvironment,
  inspectAuthEnvironment,
} from "../dist/control/authEnvironment.js";
import { AuthRuntime } from "../dist/control/authRuntime.js";
import { SubscriptionBackend } from "../dist/control/subscriptionBackend.js";
import { IsolatedVerifier } from "../dist/control/isolatedVerifier.js";
import { goalSchema } from "../dist/control/schema.js";
const exec = promisify(execFile);
const docker = (args) =>
  exec("docker", args, {
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH },
  });
const image = (await readFile(process.argv[2], "utf8")).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image))
  throw Error(
    "Supply reviewed immutable Python/Git/native-tool image digest file",
  );
const root = await mkdtemp(join(tmpdir(), "mc-subscription-coding-proof-"));
const state = join(root, "state"),
  secrets = join(root, "private"),
  build = join(root, "build");
await initializeState(state);
await mkdir(secrets, { mode: 0o700 });
await mkdir(build);
const unlock = await lockInstance(state);
const db = new SqliteStore(join(state, "mission-control.db"), {
  mustExist: true,
});
const store = new ControlStore(db),
  registry = new EnvironmentRegistry(join(state, "sandbox"), db),
  environment = new DockerEnvironment(registry);
const tag = "mc-subscription-proof-" + randomUUID(),
  base = tag + "-base";
const results = [],
  native = [];
let proofImage,
  completed = false;
try {
  // Qualify the documented flags against pinned binaries without invoking inference.
  for (const command of ["codex", "claude"]) {
    const result = await docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=64m",
      "--env",
      "HOME=/tmp",
      "--entrypoint",
      command,
      image,
      "--version",
    ]);
    const help = await docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=64m",
      "--entrypoint",
      command,
      image,
      ...(command === "codex" ? ["exec"] : []),
      "--help",
    ]);
    for (const flag of command === "codex"
      ? ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--json"]
      : [
          "--safe-mode",
          "--setting-sources",
          "--strict-mcp-config",
          "--no-session-persistence",
        ])
      assert.ok(help.stdout.includes(flag), `Pinned ${command} lacks ${flag}`);
    native.push({
      command,
      version: result.stdout.trim(),
      requiredFlagsPresent: true,
    });
  }
  const stub = `#!/usr/bin/env python3
import json,os,sys,socket,urllib.request
from pathlib import Path
h='codex' if Path(sys.argv[0]).name=='codex' else 'claude-code'
session=Path('/session')
if 'login' in sys.argv or 'auth' in sys.argv:
 print('Logged in using ChatGPT' if h=='codex' else json.dumps({'loggedIn':True,'authMethod':'claude.ai'}));sys.exit(0)
prompt=sys.stdin.read()
assert os.environ.get('HOME')=='/tmp/mc-home'
assert os.environ.get('CODEX_HOME')=='/session' if h=='codex' else os.environ.get('CLAUDE_CONFIG_DIR')=='/session'
assert not any(k in os.environ for k in ['OPENAI_API_KEY','ANTHROPIC_API_KEY','MISSIONCONTROL_INFERENCE_TOKEN','AWS_ACCESS_KEY_ID','AZURE_CLIENT_SECRET'])
assert not Path('/var/run/docker.sock').exists()
assert not Path('/session/../private').exists()
for host in ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','1.1.1.1']:
 try: socket.create_connection((host,443),timeout=.15);raise AssertionError('Unexpected network access')
 except (TimeoutError,OSError): pass
try:
 urllib.request.urlopen('https://unapproved.example',timeout=3);raise AssertionError('Unapproved proxy egress')
except (OSError,urllib.error.URLError):pass
stamp=session/'synthetic-writes';stamp.write_text(str(int(stamp.read_text())+1 if stamp.exists() else 1))
if 'review-only' not in prompt:Path('/workspace/artifact.txt').write_text('synthetic isolated artifact')
output={'text':'Synthetic isolated completion','question':None,'ownerOperation':None}
if h=='codex':
 print(json.dumps({'type':'thread.started','thread_id':'synthetic-thread'}))
 print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':json.dumps(output)}}))
 print(json.dumps({'type':'turn.completed','usage':{'input_tokens':3,'output_tokens':2}}))
else:
 print(json.dumps({'type':'result','subtype':'success','is_error':False,'session_id':'synthetic-session','structured_output':output,'total_cost_usd':999,'usage':{'input_tokens':1,'cache_creation_input_tokens':1,'cache_read_input_tokens':1,'output_tokens':2}}))
`;
  await writeFile(join(build, "stub.py"), stub, { mode: 0o755 });
  await docker(["tag", image, base]);
  await writeFile(
    join(build, "Dockerfile"),
    `FROM ${base}\nUSER 0\nRUN rm -f /usr/local/bin/codex /usr/local/bin/claude\nCOPY --chmod=755 stub.py /usr/local/bin/codex\nCOPY --chmod=755 stub.py /usr/local/bin/claude\n`,
  );
  await docker(["build", "--network", "none", "-t", tag, build]);
  proofImage = JSON.parse(
    (await docker(["image", "inspect", tag, "--format", "{{json .Id}}"]))
      .stdout,
  );
  for (const harness of ["codex", "claude-code"]) {
    const source = join(root, harness);
    await mkdir(source);
    await git(source, ["init", "-b", "synthetic"]);
    await writeFile(join(source, "base"), "Synthetic base");
    await git(source, ["add", "."]);
    const commit = async (message) =>
      git(source, [
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.invalid",
        "commit",
        "-m",
        message,
      ]);
    await commit("Synthetic base");
    const config = authEnvironmentSchema.parse({
      id: harness,
      harness,
      imageDigest: proofImage,
      sessionDir: harness,
      egress: { hosts: ["provider.example"], timeoutMs: 30000 },
    });
    await initializeAuthEnvironment(config, secrets);
    const goalConfig = goalSchema.parse({
      title: "Synthetic",
      description: "Synthetic",
      repoPath: source,
      backend: { kind: harness },
      maxCostUsd: 0,
      estimatePerRunUsd: 0,
      maxWorkers: 1,
      maxAttempts: 2,
      timeoutMs: 30000,
      verificationCommands: ["test -f artifact.txt && test ! -d /session"],
      executionContract: {
        harness,
        provider:
          harness === "codex" ? "codex-subscription" : "claude-subscription",
        authentication: { kind: "session", reference: config.id },
        execution: "isolated",
        usagePolicy: {
          kind: "subscription",
          maxConcurrency: 1,
          maxAttempts: 2,
          timeoutMs: 30000,
        },
      },
    });
    const claim = {
      generation: 1,
      workerId: "synthetic",
      goal: { id: harness, config: goalConfig },
      task: {
        id: harness,
        spec: {
          cpuUnits: 1,
          memoryMiB: 512,
          allowedPaths: ["artifact.txt"],
          verificationCommands: [],
        },
      },
    };
    const backend = () =>
      new SubscriptionBackend(
        new AuthRuntime(store, state, secrets, config),
        environment,
        registry,
        () => {},
      );
    const result = await backend().run({
      claim,
      workspace: source,
      mode: "implement",
      prompt: "synthetic coding",
      signal: AbortSignal.timeout(30000),
      onCheckpoint: async () => {},
    });
    assert.equal(result.usage.kind, "subscription");
    assert.equal(result.usage.status, "reported");
    assert.equal(result.costUsd, undefined);
    assert.equal(
      await readFile(join(source, "artifact.txt"), "utf8"),
      "synthetic isolated artifact",
    );
    await commit("Synthetic checkpoint");
    const verification = await new IsolatedVerifier(
      environment,
      proofImage,
    ).verify(claim, source);
    assert.equal(verification.passed, true);
    const review = await backend().run({
      claim,
      workspace: source,
      mode: "review",
      prompt: "review-only",
      signal: AbortSignal.timeout(30000),
      onCheckpoint: async () => {},
    });
    assert.notEqual(review.executionSessionId, result.executionSessionId);
    assert.equal(
      (await inspectAuthEnvironment(config, secrets)).writer,
      undefined,
    );
    assert.equal(
      await readFile(
        join(secrets, harness, "session/synthetic-writes"),
        "utf8",
      ),
      "2",
    );
    results.push({
      harness,
      isolatedCoding: true,
      privateAndDirectNetworkDenied: true,
      unapprovedEgressDenied: true,
      stoppedScopedImport: true,
      independentSessionFreeChecks: true,
      independentReview: true,
      dedicatedSessionRestart: true,
      vendorLoginQualified: false,
    });
  }
  assert.ok(
    store
      .setting("subscription-auth-runs")
      .every((r) => r.status === "stopped"),
  );
  completed = true;
  console.log(
    JSON.stringify(
      {
        passed: true,
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        docker: (
          await docker(["version", "--format", "{{.Server.Version}}"])
        ).stdout.trim(),
        baseImage: image,
        proofImage,
        native,
        results,
        syntheticNativeTools: true,
        vendorInferenceUsed: false,
        realSessionUsed: false,
        inferenceSpendUsd: 0,
        productionAdmissionEnabled: false,
      },
      null,
      2,
    ),
  );
} finally {
  // Never remove unknown resources. AuthRuntime teardown/recovery owns its runs.
  for (const session of registry.all())
    if (!session.container) await environment.reset(session.id);
  db.close();
  await unlock();
  await docker(["image", "rm", tag]).catch(() => {});
  await docker(["image", "rm", base]).catch(() => {});
  if (completed) await rm(root, { recursive: true, force: true });
  else console.error(`Failed proof retained privately: ${root}`);
}
