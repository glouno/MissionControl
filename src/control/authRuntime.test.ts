import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { AuthRuntime, authInvocation } from "./authRuntime.js";
import {
  initializeAuthEnvironment,
  authEnvironmentSchema,
  inspectAuthEnvironment,
} from "./authEnvironment.js";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { EnvironmentRegistry, DockerEnvironment } from "./environments.js";
import { SubscriptionBackend } from "./subscriptionBackend.js";
import { git } from "./git.js";
import { goalSchema } from "./schema.js";
import { HumanWait } from "./backend.js";
async function fixture(t: any, harness: "codex" | "claude-code" = "codex") {
  const root = await mkdtemp(join(tmpdir(), "mc-auth-runtime-"));
  await mkdir(join(root, "private"), { mode: 0o700 });
  const config = authEnvironmentSchema.parse({
    id: "subscription",
    harness,
    imageDigest: `sha256:${"a".repeat(64)}`,
    sessionDir: "dedicated",
    egress: { hosts: ["provider.example"] },
  });
  await initializeAuthEnvironment(config, join(root, "private"));
  const db = new SqliteStore(join(root, "test.db")),
    store = new ControlStore(db),
    calls: string[][] = [],
    objects = new Map<string, any>();
  let failRemove = false,
    output =
      harness === "codex"
        ? "Logged in using ChatGPT"
        : '{"loggedIn":true,"authMethod":"claude.ai","email":"synthetic@example.invalid"}',
    exitCode = 0,
    bridgeStops = 0,
    captured: any;
  const docker = async (args: string[]) => {
    calls.push(args);
    const inspect =
      args[0] === "inspect" || (args[0] === "network" && args[1] === "inspect");
    if (inspect) {
      const name = args.at(-1)!;
      if (!objects.has(name))
        throw Object.assign(Error("absent"), {
          stderr: "No such object: " + name,
        });
      return { stdout: JSON.stringify([objects.get(name)]), stderr: "" };
    }
    const labels = Object.fromEntries(
      args.flatMap((a, i) => (a === "--label" ? [args[i + 1].split("=")] : [])),
    );
    if (args[0] === "network" && args[1] === "create")
      objects.set(args.at(-1)!, {
        Internal: true,
        Driver: "bridge",
        EnableIPv6: false,
        Labels: labels,
        Containers: {},
        Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
      });
    if (args[0] === "create")
      objects.set(args[args.indexOf("--name") + 1], {
        Image: config.imageDigest,
        Config: { Labels: labels },
        HostConfig: { NetworkMode: args[args.indexOf("--network") + 1] },
        State: { Running: false },
      });
    if (args[0] === "start") objects.get(args[1]).State.Running = true;
    if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm")) {
      if (failRemove) throw Error("daemon outage");
      objects.delete(args.at(-1)!);
    }
    return { stdout: "", stderr: "" };
  };
  const launch = ((_cmd: any, args: any, options: any) => {
    assert.ok(!args.some((a: string) => a.includes("missioncontrol:")));
    assert.deepEqual(Object.keys(options.env), ["PATH"]);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `process.stdin.on('data',()=>{});process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(output)});process.exitCode=${exitCode}})`,
      ],
      { stdio: ["pipe", "pipe", "pipe"], detached: true },
    );
    const original = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((data: any) => {
      captured = JSON.parse(data);
      return original(data);
    }) as any;
    return child;
  }) as typeof spawn;
  const bridge = (async () => ({
    stop: async () => {
      bridgeStops++;
    },
    child: null,
  })) as any;
  t.after(() => {
    db.close();
    return rm(root, { recursive: true, force: true });
  });
  return {
    root,
    config,
    store,
    calls,
    objects,
    docker,
    runtime: new AuthRuntime(
      store,
      root,
      join(root, "private"),
      config,
      docker,
      bridge,
      launch,
    ),
    captured: () => captured,
    stops: () => bridgeStops,
    failRemove: () => {
      failRemove = true;
    },
    output: (v: string, code = 0) => {
      output = v;
      exitCode = code;
    },
  };
}
test("native authentication status uses only a private session mount and scoped stdin proxy; sanitized status survives restart", async (t) => {
  const f = await fixture(t),
    r = await f.runtime.run("status");
  assert.equal(r.authenticated, true);
  assert.equal(r.qualified, false);
  const worker = f.calls.find(
    (a) => a[0] === "create" && a.includes("--log-driver"),
  )!;
  assert.ok(
    worker.includes("--init"),
    "Auth workers must reap orphaned harness children",
  );
  assert.equal(worker.filter((a) => a === "--mount").length, 1);
  assert.ok(
    worker.includes(
      `type=bind,src=${join(f.root, "private/dedicated/session")},dst=/session`,
    ),
  );
  assert.ok(worker.includes("none"));
  assert.equal(f.objects.size, 0);
  assert.equal(
    (await inspectAuthEnvironment(f.config, join(f.root, "private"))).writer,
    undefined,
  );
  assert.match(f.captured().proxy, /^http:\/\/missioncontrol:/);
  assert.deepEqual(f.captured().environment, { CODEX_HOME: "/session" });
  assert.ok(
    !JSON.stringify(f.store.setting("subscription-auth-runs")).includes(
      f.captured().proxy,
    ),
  );
  assert.equal((await f.runtime.run("status")).authenticated, true);
  f.output("Logged in using an API key");
  assert.equal((await f.runtime.run("status")).authenticated, false);
});
test("Claude subscription status refuses unknown/API formats and strips account information", async (t) => {
  const f = await fixture(t, "claude-code"),
    r = await f.runtime.run("status");
  assert.equal(r.authenticated, true);
  assert.ok(!JSON.stringify(r).includes("synthetic@"));
  f.output('{"loggedIn":true,"authMethod":"api_key"}');
  assert.equal((await f.runtime.run("status")).authenticated, false);
  assert.ok(authInvocation(f.config, "login").argv.includes("--safe-mode"));
  assert.ok(authInvocation(f.config, "login").argv.includes("--claudeai"));
});
test("failed auth teardown retains lock and owned recovery records instead of admitting another writer", async (t) => {
  const f = await fixture(t);
  f.failRemove();
  await assert.rejects(f.runtime.run("status"), /daemon outage/);
  assert.ok(
    (await inspectAuthEnvironment(f.config, join(f.root, "private"))).writer,
  );
  await assert.rejects(f.runtime.run("status"), /writer/);
  assert.equal(
    (f.store.setting("subscription-auth-runs") as any[])[0].status,
    "stopping",
  );
});
test("startup auth reconciliation refuses live writers and recovers only matching dead ownership", async (t) => {
  const f = await fixture(t);
  const { acquireAuthEnvironment } = await import("./authEnvironment.js");
  const owner = await acquireAuthEnvironment(f.config, join(f.root, "private"));
  await assert.rejects(f.runtime.reconcileStartup(), /alive/);
  await owner.release();
  const identity = (
    await inspectAuthEnvironment(f.config, join(f.root, "private"))
  ).identity.instance;
  const nonce = randomUUID();
  await writeFile(
    join(f.root, "private/dedicated/writer.lock"),
    JSON.stringify({
      pid: 2147483647,
      hostname: hostname(),
      nonce,
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  f.store.setting("subscription-auth-runs", [
    {
      id: "synthetic-dead",
      authId: f.config.id,
      identity,
      worker: "mc-synthetic-dead",
      image: f.config.imageDigest,
      status: "running",
      startedAt: new Date().toISOString(),
    },
  ]);
  f.objects.set("mc-synthetic-dead", {
    Config: {
      Labels: {
        "missioncontrol.auth": f.config.id,
        "missioncontrol.auth-instance": identity,
        "missioncontrol.auth-run": "synthetic-dead",
      },
    },
  });
  assert.equal((await f.runtime.reconcileStartup()).recovered, true);
  assert.equal(
    (await inspectAuthEnvironment(f.config, join(f.root, "private"))).writer,
    undefined,
  );
  assert.equal(f.store.setting("subscription-auth-runs")[0].status, "stopped");
  assert.equal(f.objects.size, 0);
});

async function codingFixture(t: any) {
  const f = await fixture(t);
  const source = join(f.root, "trusted");
  await mkdir(source);
  await git(source, ["init", "-b", "synthetic"]);
  await writeFile(join(source, "base"), "synthetic base");
  await git(source, ["add", "."]);
  await git(source, [
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@localhost",
    "commit",
    "-m",
    "base",
  ]);
  const registry = new EnvironmentRegistry(join(f.root, "sandbox"), f.store.db);
  const environment = new DockerEnvironment(registry, f.docker);
  const configuration = goalSchema.parse({
    title: "synthetic",
    description: "synthetic",
    repoPath: source,
    backend: { kind: "codex" },
    maxCostUsd: 0,
    estimatePerRunUsd: 0,
    timeoutMs: 1000,
    maxAttempts: 2,
    maxWorkers: 1,
    executionContract: {
      harness: "codex",
      provider: "codex-subscription",
      authentication: { kind: "session", reference: f.config.id },
      execution: "isolated",
      usagePolicy: {
        kind: "subscription",
        maxAttempts: 2,
        timeoutMs: 1000,
        maxConcurrency: 1,
      },
    },
  });
  const checkpoints: string[] = [];
  const context: any = {
    workspace: source,
    mode: "implement",
    prompt: "synthetic",
    signal: new AbortController().signal,
    claim: {
      workerId: "synthetic",
      generation: 1,
      goal: { id: "synthetic", config: configuration },
      task: {
        id: "synthetic",
        spec: { allowedPaths: ["result"], cpuUnits: 1, memoryMiB: 512 },
      },
    },
    onCheckpoint: async (text: string) => {
      checkpoints.push(text);
    },
  };
  return { ...f, source, registry, environment, context, checkpoints };
}
test("coding refuses a deadline longer than admitted egress before allocating resources", async (t) => {
  const f = await codingFixture(t);
  f.context.claim.goal.config.timeoutMs = 1800000;
  f.context.claim.goal.config.executionContract.usagePolicy.timeoutMs = 1800000;
  const backend = new SubscriptionBackend(
    f.runtime,
    f.environment,
    f.registry,
    () => {},
  );
  await assert.rejects(
    backend.run(f.context),
    /deadline exceeds its admitted egress/,
  );
  assert.equal(f.registry.all().length, 0);
  assert.equal(f.objects.size, 0);
  assert.equal(
    (await inspectAuthEnvironment(f.config, join(f.root, "private"))).writer,
    undefined,
  );
});
test("coding status and source share session ownership, stopped import and immutable image policy", async (t) => {
  const f = await codingFixture(t);
  const backend = new SubscriptionBackend(
    f.runtime,
    f.environment,
    f.registry,
    () => {},
    {
      run: async (c) => {
        assert.equal(c.execution?.workspace, "/workspace");
        const session = f.registry.all().at(-1)!;
        assert.equal(session.status, "active");
        await assert.rejects(f.runtime.run("status"), /writer/);
        await writeFile(join(session.path, "result"), "synthetic work");
        await c.onCheckpoint("synthetic checkpoint");
        return {
          text: "synthetic",
          usage: { kind: "subscription", status: "unknown" },
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    },
  );
  const result = await backend.run(f.context);
  assert.equal(
    await readFile(join(f.source, "result"), "utf8"),
    "synthetic work",
  );
  const session = f.registry.get(result.executionSessionId!);
  assert.equal(session.status, "checkpointed");
  assert.equal(session.container, undefined);
  assert.equal(session.completion?.outcome, "imported");
  assert.equal(f.objects.size, 0);
  assert.deepEqual(f.checkpoints, ["synthetic checkpoint"]);
  const worker = f.calls.find(
    (a) => a[0] === "create" && a.includes("--log-driver"),
  )!;
  assert.equal(worker.filter((a) => a === "--mount").length, 2);
  assert.ok(worker.includes(`type=bind,src=${session.path},dst=/workspace`));
  assert.ok(!worker.join(" ").includes(f.source));
});
test("logged-out coding refuses native execution and preserves clean copied source", async (t) => {
  const f = await codingFixture(t);
  f.output("Not logged in", 1);
  let invoked = false;
  const backend = new SubscriptionBackend(
    f.runtime,
    f.environment,
    f.registry,
    () => {},
    {
      run: async () => {
        invoked = true;
        throw Error("unexpected");
      },
    },
  );
  await assert.rejects(backend.run(f.context), /reauthenticate/);
  assert.equal(invoked, false);
  assert.equal(f.objects.size, 0);
  assert.equal(
    (await inspectAuthEnvironment(f.config, join(f.root, "private"))).writer,
    undefined,
  );
  assert.equal(f.registry.all()[0].completion, undefined);
});
test("review mutation and stale authority keep trusted subscription source untouched", async (t) => {
  for (const mode of ["review", "stale"] as const) {
    const f = await codingFixture(t);
    let valid = true;
    f.context.mode = mode === "review" ? "review" : "implement";
    const backend = new SubscriptionBackend(
      f.runtime,
      f.environment,
      f.registry,
      () => {
        if (!valid) throw Error("stale authority");
      },
      {
        run: async () => {
          await writeFile(
            join(f.registry.all()[0].path, "result"),
            "unaccepted",
          );
          if (mode === "stale") valid = false;
          return {
            text: "synthetic",
            usage: { kind: "subscription", status: "unknown" },
            inputTokens: 0,
            outputTokens: 0,
          };
        },
      },
    );
    await assert.rejects(
      backend.run(f.context),
      mode === "review" ? /review changed/ : /stale authority/,
    );
    await assert.rejects(readFile(join(f.source, "result")));
    assert.equal(f.objects.size, 0);
    assert.equal(
      await readFile(join(f.registry.all()[0].path, "result"), "utf8"),
      "unaccepted",
    );
  }
});
test("subscription human handoffs checkpoint only after clean teardown; failed teardown retains ownership", async (t) => {
  for (const failed of [false, true]) {
    const f = await codingFixture(t);
    const backend = new SubscriptionBackend(
      f.runtime,
      f.environment,
      f.registry,
      () => {},
      {
        run: async (c) => {
          await writeFile(
            join(f.registry.all()[0].path, "result"),
            "partial work",
          );
          await c.onCheckpoint("waiting");
          if (failed) f.failRemove();
          throw Object.assign(
            new HumanWait({
              question: "Synthetic choice?",
              reason: "synthetic",
              options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
              ],
            }),
            { usage: { kind: "subscription", status: "unknown" } },
          );
        },
      },
    );
    await assert.rejects(
      backend.run(f.context),
      failed ? /teardown unresolved/ : HumanWait,
    );
    if (failed) {
      await assert.rejects(readFile(join(f.source, "result")));
      assert.deepEqual(f.checkpoints, []);
      assert.ok(
        (await inspectAuthEnvironment(f.config, join(f.root, "private")))
          .writer,
      );
    } else {
      assert.equal(
        await readFile(join(f.source, "result"), "utf8"),
        "partial work",
      );
      assert.deepEqual(f.checkpoints, ["waiting"]);
    }
  }
});
test("native sessions cannot hardlink credentials into imported source", async (t) => {
  const f = await codingFixture(t);
  const { link } = await import("node:fs/promises");
  const secret = join(f.root, "private/dedicated/session/synthetic-session");
  await writeFile(secret, "synthetic credential", { mode: 0o600 });
  const backend = new SubscriptionBackend(
    f.runtime,
    f.environment,
    f.registry,
    () => {},
    {
      run: async () => {
        await link(secret, join(f.registry.all()[0].path, "result"));
        return {
          text: "synthetic",
          usage: { kind: "subscription", status: "unknown" },
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    },
  );
  await assert.rejects(backend.run(f.context), /redirected or foreign/);
  await assert.rejects(readFile(join(f.source, "result")));
  assert.ok(
    (await inspectAuthEnvironment(f.config, join(f.root, "private"))).writer,
  );
});
