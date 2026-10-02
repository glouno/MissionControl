import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repairWorktreeLinks } from "./worktreeLinks.js";
import { createBackup, restoreBackup } from "../backup.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createControlServer } from "./api.js";
import { Scheduler } from "./scheduler.js";
import { once } from "node:events";
import { initializeState } from "../instance.js";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import { git } from "./git.js";
test("unfinished local goal state and Git worktrees relocate without using the old checkout metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-relocate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "project"),
    state = join(root, "state");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "base"), "synthetic");
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  await initializeState(state);
  let db = new SqliteStore(join(state, "mission-control.db"), {
      mustExist: true,
    }),
    store = new ControlStore(db),
    workspaces = new WorkspaceManager(state, db, {
      mergedRetentionMs: 0,
      archiveRetentionMs: 0,
      archiveBudgetBytes: 1e9,
      cacheBudgetBytes: 1e9,
      freeReserveBytes: 0,
    });
  const g = store.createGoal({
    title: "Synthetic",
    description: "Synthetic",
    repoPath: repo,
    repository: { mode: "local", branch: "main" },
    policy: { targetBranch: "main" },
    backend: { kind: "fake" },
  });
  store.installPlan(
    g.id,
    {
      tasks: [
        {
          key: "one",
          title: "one",
          description: "one",
          allowedPaths: ["**"],
          acceptanceCriteria: ["artifact"],
          verificationCommands: ["test -f one"],
        },
      ],
    },
    g.revision,
  );
  const claim = store.claimNextTask("worker")!;
  await workspaces.prepareTask(claim.goal, claim.task);
  await writeFile(join(workspaces.taskPath(claim.task), "one"), "unfinished");
  await workspaces.checkpoint(claim.task, "Synthetic progress");
  store.release(
    claim.task.id,
    "worker",
    claim.generation,
    "retry_wait",
    "restart",
    0,
  );
  const records = db.query<{ record: string }>(
    "SELECT record FROM bases UNION ALL SELECT record FROM workspaces",
  );
  assert.ok(records.every((r) => !JSON.parse(r.record).path.startsWith("/")));
  assert.ok(!records.some((r) => JSON.parse(r.record).repositoryPath === repo));
  assert.ok(
    !(
      await readFile(join(workspaces.taskPath(claim.task), ".git"), "utf8")
    ).includes(state),
  );
  const identity = join(root, "age.key"),
    recipient = join(root, "recipient"),
    bundle = join(root, "backup.age");
  await promisify(execFile)("age-keygen", ["-o", identity]);
  await writeFile(
    recipient,
    (await promisify(execFile)("age-keygen", ["-y", identity])).stdout,
  );
  await createBackup(db, state, bundle, recipient, true);
  db.close();
  const moved = join(root, "moved");
  await restoreBackup(bundle, identity, moved);
  await rename(state, join(root, "old-state-offline"));
  await rename(repo, join(root, "offline-project"));
  db = new SqliteStore(join(moved, "mission-control.db"), { mustExist: true });
  t.after(() => db.close());
  store = new ControlStore(db);
  workspaces = new WorkspaceManager(moved, db);
  const goal = store.getGoal(g.id);
  await repairWorktreeLinks(
    moved,
    workspaces.storage.workspaces().map((w) => w.path),
  );
  assert.equal(
    await workspaces.prepareGoal(goal),
    join(moved, "goals", g.id, "integration"),
  );
  const task = store.getTask(claim.task.id);
  assert.equal(
    await readFile(join(workspaces.taskPath(task), "one"), "utf8"),
    "unfinished",
  );
  assert.ok(await git(workspaces.taskPath(task), ["rev-parse", "HEAD"]));
  const candidate = await workspaces.candidate(goal, task);
  await workspaces.advance(goal, candidate);
  assert.equal(
    await readFile(join(workspaces.goalPath(goal), "one"), "utf8"),
    "unfinished",
  );
  const scheduler = new Scheduler(store, moved, "unused");
  const server = createControlServer(store, {
    token: "synthetic-operator-token-0123456789",
    onResult: (...args) => scheduler.result(...args),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  (scheduler as any).url = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => {
    await scheduler.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  db.exec("UPDATE control_tasks SET retry_at=0");
  const deadline = Date.now() + 5000;
  while (store.getGoal(g.id).status !== "completed" && Date.now() < deadline) {
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(store.getGoal(g.id).status, "completed");
});
