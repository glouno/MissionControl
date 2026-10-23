import "./canonical-temp.mjs";
// Explicit live subscription acceptance, always in new private configuration/state.
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { classifyFailure } from "../dist/control/reliability.js";
import { nativePreflight } from "../dist/control/nativeRuntime.js";
import { nativeCommand } from "../dist/control/nativeProcess.js";
import {
  nativeEnvironment,
  nativeProfileSchema,
  nativeBinding,
} from "../dist/control/nativeConfig.js";

const flags = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, i, args) => {
    if (value.startsWith("--")) pairs.push([value.slice(2), args[i + 1]]);
    return pairs;
  }, []),
);
for (const name of ["output-root", "codex", "codex-home", "model"])
  if (!flags[name]) throw Error(`Required: --${name}`);
const root = resolve(flags["output-root"]),
  exec = promisify(execFile);
await mkdir(root, { mode: 0o700 }); // Refuse reuse of an existing acceptance run.
const configDir = join(root, "config"),
  state = join(root, "state"),
  secrets = join(root, "secrets");
const executable = resolve(flags.codex),
  codexHome = resolve(flags["codex-home"]);
const profile = nativeProfileSchema.parse({
  executable,
  codexHome,
  home: homedir(),
  path: process.env.PATH,
  permissions: "devbox",
  requiredExecutables: ["python3"],
  buildOutputPaths: ["__pycache__/**"],
});
const cliPath = resolve("dist/cli.js");
const cli = (...args) =>
  exec(process.execPath, [cliPath, "--config-dir", configDir, ...args]);
const save = (name, value) =>
  writeFile(join(root, name), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
const report = {
  version: 1,
  sourceRevision: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
  model: flags.model,
  cases: [],
  gaps: [],
  productionActivated: false,
};
let controller, token, port;
async function start() {
  const log = createWriteStream(join(root, "controller.log"), {
    flags: "a",
    mode: 0o600,
  });
  controller = spawn(
    process.execPath,
    [cliPath, "--config-dir", configDir, "serve"],
    {
      env: {
        ...process.env,
        DOCKER_HOST: "unix:" + join(root, "unavailable-docker.sock"),
        NODE_USE_ENV_PROXY: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  controller.stderr.pipe(log);
  await wait(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
    } catch {
      return false;
    }
  });
}
async function stop(signal = "SIGTERM") {
  if (controller?.exitCode === null && controller?.signalCode === null) {
    const stopped = once(controller, "exit");
    controller.kill(signal);
    await stopped;
  }
}
async function wait(check) {
  for (;;) {
    if (await check()) return;
    if (
      controller &&
      (controller.exitCode !== null || controller.signalCode !== null)
    )
      throw Error("Acceptance controller exited; inspect its private log");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
async function request(path, body, key) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(body === undefined ? {} : { "Idempotency-Key": key ?? randomUUID() }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(
      `Acceptance request ${path}: HTTP ${response.status}: ${JSON.stringify(result)}`,
    );
  return result;
}
async function inspect(goal) {
  const result = await request(`/goals/${goal.id}/experiment`);
  result.tasks = await request(`/goals/${goal.id}/tasks`);
  result.evidence = await request(`/goals/${goal.id}/evidence?limit=100`);
  result.recovery = await request(`/goals/${goal.id}/recovery`);
  return result;
}
async function admit(projectId, description, criteria, key) {
  return request(
    "/reviewed-goals",
    {
      goal: { projectId, description },
      plan: {
        tasks: [
          {
            key,
            title: key,
            description,
            allowedPaths: ["module.py"],
            acceptanceCriteria: criteria,
          },
        ],
      },
    },
    key,
  );
}
try {
  await cli("init", "--state-dir", state, "--secrets-dir", secrets);
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  assert.notEqual(port, 43190);
  assert.notEqual(port, 17443);
  const projectFiles = [];
  for (const name of [
    "ordinary",
    "check-repair",
    "review-repair",
    "cancellation",
    "restart",
  ]) {
    const repo = join(root, name);
    await mkdir(repo, { mode: 0o700 });
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.name", "Acceptance"], { cwd: repo });
    await exec("git", ["config", "user.email", "acceptance@example.invalid"], {
      cwd: repo,
    });
    await writeFile(
      join(repo, "README.md"),
      "Disposable native acceptance fixture. Only module.py is task scope. Do not use integrations or subagents for this small Python change.\n",
    );
    await writeFile(
      join(repo, "module.py"),
      "def total(values):\n    return sum(values)\n",
    );
    await writeFile(
      join(repo, "check.py"),
      `from module import total\nassert total([1, 3]) == 4\n${name === "review-repair" ? "" : "assert total([1, -2, 3]) == 4\n"}`,
    );
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["commit", "-m", "Acceptance base"], { cwd: repo });
    const file = `project-${name}.json`;
    projectFiles.push(file);
    await writeFile(
      join(configDir, file),
      JSON.stringify({
        id: name,
        name,
        enabled: true,
        provider: "native-codex",
        executionMode: "native",
        config: {
          repoPath: repo,
          repository: { mode: "local", branch: "main" },
          verificationCommands: ["python3 check.py"],
          maxWorkers: 1,
          policy: { targetBranch: "main", publish: false, autoMerge: false },
        },
      }),
    );
  }
  const nativeProfiles = { selected: profile };
  if (flags["real-repo"]) {
    for (const key of ["real-branch", "real-check", "real-envelope"])
      if (!flags[key]) throw Error(`Required with --real-repo: --${key}`);
    projectFiles.push("project-real.json");
    nativeProfiles["selected-real"] = {
      ...profile,
      requiredExecutables: ["node", "npm"],
      setupCommands: flags["real-setup"] ? [flags["real-setup"]] : [],
    };
    await writeFile(
      join(configDir, "project-real.json"),
      JSON.stringify({
        id: "real",
        name: "Real repository acceptance",
        enabled: true,
        provider: "native-codex-real",
        executionMode: "native",
        config: {
          repoPath: resolve(flags["real-repo"]),
          repository: { mode: "local", branch: flags["real-branch"] },
          verificationCommands: [flags["real-check"]],
          maxWorkers: 1,
          policy: {
            targetBranch: flags["real-branch"],
            publish: false,
            autoMerge: false,
          },
        },
      }),
    );
  }
  await writeFile(
    join(configDir, "host.json"),
    JSON.stringify({ id: "devbox", nativeProfiles }),
  );
  await writeFile(
    join(configDir, "provider.json"),
    JSON.stringify({
      id: "native-codex",
      enabled: true,
      backend: { kind: "codex", model: flags.model },
      executionContract: {
        harness: "codex",
        provider: "codex-subscription",
        execution: "native",
        authentication: { kind: "local", reference: "selected" },
        usagePolicy: { kind: "observed" },
      },
    }),
  );
  if (flags["real-repo"]) {
    const provider = JSON.parse(
      await readFile(join(configDir, "provider.json"), "utf8"),
    );
    provider.id = "native-codex-real";
    provider.executionContract.authentication.reference = "selected-real";
    await writeFile(
      join(configDir, "provider-real.json"),
      JSON.stringify(provider),
    );
  }
  const settings = JSON.parse(
    await readFile(join(configDir, "config.json"), "utf8"),
  );
  settings.server.port = port;
  settings.authority = {
    ...settings.authority,
    allowedProviders: flags["real-repo"]
      ? ["native-codex", "native-codex-real"]
      : ["native-codex"],
    allowedExecutionModes: ["native", "fake"],
    publish: false,
    autoMerge: false,
  };
  settings.storage.freeReserveBytes = 1048576; // Disposable fixture storage policy only.
  settings.files.projects = projectFiles;
  settings.files.providers = flags["real-repo"]
    ? ["provider.json", "provider-real.json"]
    : ["provider.json"];
  settings.files.hosts = ["host.json"];
  await writeFile(join(configDir, "config.json"), JSON.stringify(settings));
  token = (await readFile(join(secrets, "operator-token"), "utf8")).trim();
  await start();
  report.preflight = await request("/projects/ordinary/preflight");
  assert.equal(report.preflight.preflight.ready, true);
  await save("preflight.json", report.preflight);
  const draft = await request("/goal-drafts", {
    projectId: "ordinary",
    description: "Inspect unavailable prerequisite without inference",
  });
  const missing = draft.config;
  missing.admission.nativeProfile.requiredExecutables.push(
    "missioncontrol-acceptance-nonexistent-tool",
  );
  missing.admission.runtimeHash = nativeBinding(missing);
  report.prerequisiteFailure = await nativePreflight(missing);
  assert.equal(report.prerequisiteFailure.ready, false);
  await save("prerequisite-failure.json", report.prerequisiteFailure);
  const baseTask =
    "Update module.py so total(values) sums only values >= 0, preserving empty input as 0. Keep check.py unchanged. This is a small disposable Python fixture; return the normal worker handoff and let MissionControl run independent checks and review. Do not create a Git commit, use external integrations, or start subagents.";
  for (const name of [
    ...(flags["real-repo"] ? ["real"] : []),
    "ordinary",
    "check-repair",
    "review-repair",
    "cancellation",
    "restart",
  ]) {
    let description = baseTask;
    if (name.includes("repair"))
      description +=
        " This is deliberate fault injection: on your INITIAL invocation only, write a naive implementation that sums all values, including negative values. On a CONTINUATION after controller check or review feedback, implement the correct filtering. The independent reviewer must evaluate the final acceptance criterion, including negative inputs; fault injection is not a waiver of that criterion.";
    if (["cancellation", "restart"].includes(name))
      description =
        "This is a disposable lifecycle test. Do not alter any files. Run python3 -c 'import time; time.sleep(600)' and then report completion. Do not start subagents or use integrations.";
    const goal =
      name === "real"
        ? await request(
            "/reviewed-goals",
            JSON.parse(await readFile(resolve(flags["real-envelope"]), "utf8")),
            "real-repository",
          )
        : await admit(
            name,
            description,
            ["total([1, -2, 3]) == 4", "total([]) == 0"],
            name,
          );
    if (["cancellation", "restart"].includes(name)) {
      await wait(async () => {
        const invocations = await request(`/goals/${goal.id}/invocations`),
          current = await request(`/goals/${goal.id}`);
        return (
          invocations.some((row) => row.process && row.firstActivityAt) ||
          ["paused", "failed"].includes(current.status)
        );
      });
      const current = await request(`/goals/${goal.id}`);
      if (current.status === "running") {
        if (name === "cancellation")
          await request(`/goals/${goal.id}/state`, {
            status: "cancelled",
            revision: current.revision,
          });
        else {
          await stop("SIGKILL");
          await start();
        }
        await wait(async () =>
          (await request(`/goals/${goal.id}/tasks`)).every(
            (task) => task.workerId === null,
          ),
        );
      }
    } else
      await wait(async () =>
        ["completed", "paused", "failed", "cancelled"].includes(
          (await request(`/goals/${goal.id}`)).status,
        ),
      );
    const result = await inspect(goal);
    report.cases.push({ name, ...result });
    await save(`${name}.json`, result);
    await save("summary.json", report);
    if (
      result.recovery.blocker?.failure?.kind === "quota" ||
      result.runs.some((run) => run.failure === "quota")
    ) {
      report.gaps.push(
        "Subscription quota blocked remaining live acceptance cases; no login or billing changes attempted",
      );
      break;
    }
    if (!name.includes("restart") && !name.includes("cancellation"))
      assert.equal(result.status, "completed", `${name} did not complete`);
    if (name.includes("repair")) {
      assert.equal(result.tasks.length, 1);
      assert.ok(result.tasks[0].attempts >= 2);
    }
    if (name === "ordinary") {
      const direct = join(root, "direct");
      await exec("git", ["clone", "--local", join(root, "ordinary"), direct]);
      const startedAt = Date.now();
      const run = await nativeCommand(
        executable,
        [
          "exec",
          "--json",
          "--model",
          flags.model,
          "-c",
          'approval_policy="never"',
          "-c",
          'sandbox_mode="danger-full-access"',
          "-c",
          'forced_login_method="chatgpt"',
          "-c",
          'model_provider="openai"',
          baseTask,
        ],
        { cwd: direct, env: nativeEnvironment(profile) },
      );
      const events = run.stdout
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      const agentEndedAt = Date.now();
      await writeFile(join(root, "direct-events-tail.jsonl"), run.stdout, {
        mode: 0o600,
      });
      await writeFile(join(root, "direct-stderr-tail.txt"), run.stderr, {
        mode: 0o600,
      });
      const terminalError =
        events.findLast((e) => e.type === "turn.failed")?.error ??
        events.findLast((e) => e.type === "error")?.message;
      const quotaBlocked =
        terminalError && classifyFailure(terminalError).kind === "quota";
      const checkStartedAt = Date.now();
      const checks = await nativeCommand("python3", ["check.py"], {
        cwd: direct,
        env: nativeEnvironment(profile),
      });
      report.directComparison = {
        exitCode: run.exitCode,
        checkExitCode: checks.exitCode,
        startedAt,
        agentEndedAt,
        agentElapsedMs: agentEndedAt - startedAt,
        checkElapsedMs: Date.now() - checkStartedAt,
        elapsedMs: Date.now() - startedAt,
        quotaBlocked: Boolean(quotaBlocked),
        traceRetention:
          "Final 20,000 characters per stream; terminal usage may be unavailable",
        usage:
          events.findLast((e) => e.type === "turn.completed")?.usage ?? null,
        baseRevision: (
          await exec("git", ["rev-parse", "HEAD"], { cwd: direct })
        ).stdout.trim(),
        model: flags.model,
        differences:
          "Direct execution uses the same fixture base, model, profile and implementation task, with no MissionControl handoff envelope, task context, controller checks or separate review. Only the terminal usage from retained output is compared; no model-request counts or dollar costs are inferred.",
      };
      await save("direct-comparison.json", report.directComparison);
      if (quotaBlocked) {
        report.gaps.push(
          "Subscription quota blocked the direct comparison and remaining cases; no replay attempted",
        );
        break;
      }
      assert.equal(run.exitCode, 0, "Direct comparison agent failed");
      assert.equal(checks.exitCode, 0, "Direct comparison checks failed");
    }
  }
  // An unavailable prerequisite is checked without any inference.
  await save("summary.json", report);
  console.log(
    JSON.stringify({
      root,
      cases: report.cases.map((c) => ({
        name: c.name,
        status: c.status,
        invocations: c.metrics.invocations,
      })),
      gaps: report.gaps,
    }),
  );
} catch (error) {
  report.error = error.message;
  await save("summary.json", report);
  throw error;
} finally {
  await stop();
}
