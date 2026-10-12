import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { Scheduler } from "./scheduler.js";
import { FakeBackend } from "./backends.js";
import { git } from "./git.js";
import { ProviderFailure, failureRecord } from "./reliability.js";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-scheduler-faults-")),
    db = new SqliteStore(join(root, "state.db")),
    store = new ControlStore(db);
  store.setting("storage-maintenance-at", Date.now());
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  async function goal(name: string) {
    const repo = join(root, name);
    await mkdir(repo);
    await git(repo, ["init", "-b", "main"]);
    await writeFile(join(repo, "README.md"), "Synthetic");
    await git(repo, ["add", "."]);
    await git(repo, [
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "-m",
      "Synthetic",
    ]);
    return store.createGoal({
      title: name,
      description: "Synthetic",
      repoPath: repo,
      repository: { mode: "local", branch: "main" },
      policy: { targetBranch: "main" },
      backend: { kind: "fake" },
      timeoutMs: 1000,
      maxCostUsd: 5,
      estimatePerRunUsd: 1,
    });
  }
  return { root, db, store, goal };
}
async function until(predicate: () => boolean, limit = 3000) {
  const deadline = Date.now() + limit;
  while (!predicate() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(predicate());
}

test("asynchronous planning permits independent repositories and avoids duplicate dispatch", async (t) => {
  const f = await fixture(t),
    slow = await f.goal("slow"),
    fast = await f.goal("fast");
  let started = 0;
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    asynchronousJobs: true,
    spawnWorkers: false,
    backend: (g) => ({
      run: async (c) => {
        if (g.id === slow.id) {
          started++;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 2000);
            c.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(c.signal.reason);
              },
              { once: true },
            );
          });
        }
        return new FakeBackend().run(c);
      },
    }),
  });
  t.after(() => scheduler.close());
  const startedAt = Date.now();
  await scheduler.tick();
  assert.ok(Date.now() - startedAt < 500);
  await scheduler.tick();
  await until(() => f.store.getGoal(fast.id).planRevision === 1);
  await until(() => started === 1);
  assert.equal(started, 1);
  await until(() =>
    f.store.attempts(slow.id).some((a) => a.outcome !== "active"),
  );
  assert.equal(
    f.store.reliability.page("reliability_incidents", slow.id)[0].failure.kind,
    "deadline",
  );
  assert.equal(f.store.getGoal(fast.id).status, "running");
});

test("controller refusal blocks unchanged jobs across restart", async (t) => {
  const f = await fixture(t),
    goal = await f.goal("refused");
  let calls = 0;
  const backend = () => ({
    run: async () => {
      calls++;
      throw new ProviderFailure(failureRecord("policy_refusal"));
    },
  });
  const scheduler = new Scheduler(f.store, f.root, "unused", {
    asynchronousJobs: true,
    spawnWorkers: false,
    backend,
  });
  await scheduler.tick();
  await until(() => f.store.getGoal(goal.id).status === "paused");
  await scheduler.close();
  const restarted = new Scheduler(f.store, f.root, "unused", {
    asynchronousJobs: true,
    spawnWorkers: false,
    backend,
  });
  t.after(() => restarted.close());
  await restarted.tick();
  assert.equal(calls, 1);
  assert.equal(
    f.store.reliability.page("reliability_incidents", goal.id).length,
    1,
  );
});
