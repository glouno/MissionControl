/** Disposable synthetic API/CLI acceptance; no provider credentials or dependencies. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../dist/sqlite.js";
const exec = promisify(execFile),
  root = await mkdtemp(join(tmpdir(), "mc-backlog-acceptance-"));
const config = join(root, "config"),
  state = join(root, "state"),
  secrets = join(root, "secrets"),
  repo = join(root, "repo");
const cli = (...args) =>
  exec(process.execPath, [
    resolve("dist/cli.js"),
    "--config-dir",
    config,
    ...args,
  ]);
let controller,
  diagnostic = "";
async function wait(check) {
  const end = Date.now() + 80000;
  while (Date.now() < end) {
    if (await check()) return;
    if (controller.exitCode !== null) throw Error("Controller exited");
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Synthetic acceptance timed out: " + diagnostic);
}
try {
  await cli("init", "--state-dir", state, "--secrets-dir", secrets);
  await mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "Synthetic fixture\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec(
    "git",
    [
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "-m",
      "Fixture",
    ],
    { cwd: repo },
  );
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const settings = JSON.parse(
    await readFile(join(config, "config.json"), "utf8"),
  );
  settings.server.port = port;
  settings.files.projects = ["project.json"];
  settings.storage = { ...settings.storage, freeReserveBytes: 1048576 };
  await writeFile(join(config, "config.json"), JSON.stringify(settings));
  await writeFile(
    join(config, "project.json"),
    JSON.stringify({
      id: "synthetic",
      name: "Synthetic backlog",
      enabled: true,
      executionMode: "fake",
      config: {
        repoPath: repo,
        repository: { mode: "local", branch: "main" },
        verificationCommands: ["test -f implement.txt"],
        maxWorkers: 1,
        maxAttempts: 2,
        timeoutMs: 60000,
        policy: { targetBranch: "main", publish: false, autoMerge: false },
      },
    }),
  );
  controller = spawn(
    process.execPath,
    [resolve("dist/cli.js"), "--config-dir", config, "serve"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  controller.stderr.on("data", (b) => {
    diagnostic += b.toString();
  });
  const base = `http://127.0.0.1:${port}/api/v1`;
  await wait(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
    } catch {
      return false;
    }
  });
  const token = (
    await readFile(join(secrets, "operator-token"), "utf8")
  ).trim();
  let sequence = 0;
  const request = (path, body, key) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "Idempotency-Key": key || "acceptance-" + ++sequence,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function api(path, body, key) {
    const r = await request(path, body, key);
    const value = await r.json();
    assert.equal(r.status, 200, JSON.stringify(value));
    return value;
  }
  await cli("config", "apply");
  const fields = {
    title: "Synthetic <img src=x onerror=alert(1)>",
    description: "Create deterministic artifact",
    priority: 7,
    dependencies: [],
    acceptanceCriteria: ["Configured check passes"],
  };
  const first = await api(
    "/backlog",
    { ...fields, projectId: "synthetic" },
    "create-first",
  );
  assert.deepEqual(
    await api(
      "/backlog",
      { ...fields, projectId: "synthetic" },
      "create-first",
    ),
    first,
  );
  const edited = await api("/backlog/" + first.id, {
    projectId: "synthetic",
    revision: 1,
    title: "Edited prerequisite",
  });
  assert.equal(
    (
      await request("/backlog/" + first.id, {
        projectId: "synthetic",
        revision: 1,
        title: "Stale",
      })
    ).status,
    409,
  );
  const input = join(root, "input.json");
  await writeFile(
    input,
    JSON.stringify({ ...fields, dependencies: [first.id] }),
  );
  const dependent = JSON.parse(
    (
      await cli(
        "backlog",
        "add",
        "--project",
        "synthetic",
        "--input",
        input,
        "--idempotency-key",
        "cli-add",
      )
    ).stdout,
  );
  await writeFile(input, JSON.stringify({ description: "Edited dependent" }));
  const changed = JSON.parse(
    (
      await cli(
        "backlog",
        "update",
        dependent.id,
        "--project",
        "synthetic",
        "--revision",
        "1",
        "--input",
        input,
      )
    ).stdout,
  );
  const archived = await api("/backlog", { ...fields, projectId: "synthetic" });
  await api("/backlog/" + archived.id + "/archive", {
    projectId: "synthetic",
    revision: 1,
  });
  await api("/dashboard");
  await api("/backlog?projectId=synthetic");
  // Let the running scheduler process multiple cycles while every record remains inert.
  await new Promise((r) => setTimeout(r, 2200));
  const snapshot = await api("/dashboard");
  assert.equal(snapshot.goals.length, 0);
  assert.equal(snapshot.tasks.length, 0);
  assert.equal(snapshot.attempts.length, 0);
  assert.equal(snapshot.executions.length, 0);
  const inertDb = new DatabaseSync(join(state, "mission-control.db"), {
    readOnly: true,
  });
  try {
    for (const table of [
      "control_goals",
      "control_tasks",
      "control_jobs",
      "control_attempts",
      "control_budgets",
      "execution_invocations",
      "sessions",
    ])
      assert.equal(
        inertDb.prepare("SELECT count(*) count FROM " + table).get().count,
        0,
        table,
      );
    const admitted = inertDb
      .prepare(
        "SELECT value FROM control_settings WHERE key='admitted-cost-usd'",
      )
      .get();
    assert.ok(!admitted || JSON.parse(admitted.value) === 0);
  } finally {
    inertDb.close();
  }
  const rejected = await request("/backlog/" + dependent.id + "/launch", {
    projectId: "synthetic",
    revision: changed.revision,
  });
  assert.equal(rejected.status, 409);
  const launched = await api(
    "/backlog/" + first.id + "/launch",
    { projectId: "synthetic", revision: edited.revision },
    "launch-first",
  );
  assert.equal(
    (
      await api(
        "/backlog/" + first.id + "/launch",
        { projectId: "synthetic", revision: edited.revision },
        "launch-first",
      )
    ).id,
    launched.id,
  );
  assert.equal(
    (
      await api("/backlog/" + first.id + "/launch", {
        projectId: "synthetic",
        revision: edited.revision,
      })
    ).id,
    launched.id,
  );
  assert.equal(launched.config.maxWorkers, 1);
  assert.equal(launched.config.maxAttempts, 2);
  assert.equal(launched.config.timeoutMs, 60000);
  assert.deepEqual(launched.config.verificationCommands, [
    "test -f implement.txt",
  ]);
  assert.equal(launched.config.admission.executionMode, "fake");
  assert.equal(launched.config.policy.publish, false);
  await wait(
    async () => (await api("/goals/" + launched.id)).status === "completed",
  );
  const second = JSON.parse(
    (
      await cli(
        "backlog",
        "launch",
        dependent.id,
        "--project",
        "synthetic",
        "--revision",
        String(changed.revision),
        "--idempotency-key",
        "cli-launch",
      )
    ).stdout,
  );
  assert.equal(
    JSON.parse(
      (
        await cli(
          "backlog",
          "launch",
          dependent.id,
          "--project",
          "synthetic",
          "--revision",
          String(changed.revision),
          "--idempotency-key",
          "cli-launch",
        )
      ).stdout,
    ).id,
    second.id,
  );
  await wait(
    async () => (await api("/goals/" + second.id)).status === "completed",
  );
  for (const goal of [launched, second]) {
    const tasks = await api("/goals/" + goal.id + "/tasks");
    assert.ok(tasks.length);
    assert.ok(tasks.every((t) => t.status === "accepted"));
    assert.ok(tasks.every((t) => t.result));
    const evidence = await api("/goals/" + goal.id + "/evidence");
    assert.ok(evidence.some((e) => e.passed));
    const attempts = await api("/goals/" + goal.id + "/attempts");
    assert.ok(attempts.length);
    assert.ok(attempts.some((a) => a.endedAt));
  }
  const records = await api("/backlog?projectId=synthetic");
  assert.equal(records.find((e) => e.id === first.id).goalId, launched.id);
  assert.equal(records.find((e) => e.id === dependent.id).goalId, second.id);
  assert.equal((await api("/dashboard")).goals.length, 2);
  // Apply a real external recurring schedule and let the running controller fire
  // its minimum interval; no clock or direct database mutation substitutes for it.
  settings.files.schedules = ["schedule.json"];
  await writeFile(
    join(config, "schedule.json"),
    JSON.stringify({
      id: "synthetic-recurring",
      projectId: "synthetic",
      description: "Scheduled synthetic installation check",
      intervalMs: 60000,
      enabled: true,
    }),
  );
  await writeFile(join(config, "config.json"), JSON.stringify(settings));
  await cli("config", "apply");
  const schedules = await api("/schedules");
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].id, "synthetic-recurring");
  await wait(async () => {
    const scheduled = (await api("/goals")).filter(
      (g) => ![launched.id, second.id].includes(g.id),
    );
    return scheduled.length === 1 && scheduled[0].status === "completed";
  });
  assert.equal((await api("/goals")).length, 3);
  assert.equal(
    (await api("/schedules"))[0].last_goal_id,
    (await api("/goals")).find((g) => ![launched.id, second.id].includes(g.id))
      .id,
  );
  // Stop the owning controller before reading persisted database evidence.
  controller.kill("SIGTERM");
  await once(controller, "exit");
  controller = undefined;
  const db = new SqliteStore(join(state, "mission-control.db"));
  try {
    assert.equal(db.query("SELECT * FROM control_goals").length, 3);
    assert.ok(
      db.query("SELECT * FROM control_jobs WHERE status='done'").length,
    );
    assert.ok(db.query("SELECT * FROM control_attempts").length);
  } finally {
    db.close();
  }
} finally {
  if (controller && controller.exitCode === null) {
    controller.kill("SIGTERM");
    await once(controller, "exit");
  }
  await rm(root, { recursive: true, force: true });
}
