import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "./store.js";
import { SqliteStore } from "../sqlite.js";
import { pathsOverlap } from "./projectContext.js";
test("declared path ownership detects nested and wildcard overlaps deterministically", () => {
  assert.equal(pathsOverlap("src/**", "src/a.ts"), true);
  assert.equal(pathsOverlap("**/*.ts", "docs/a.md"), true);
  assert.equal(pathsOverlap("src/a.ts", "src/b.ts"), false);
  assert.equal(pathsOverlap("../escape", "docs/**"), true);
});
test("overlapping goals wait durably for coordination while independent work proceeds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-context-"));
  const db = new SqliteStore(join(root, "state.db"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true });
  });
  const store = new ControlStore(db);
  store.setting("scheduler-limits", {
    workers: 4,
    cpu: 16,
    memoryMiB: 16384,
    providerWorkers: 4,
    repositoryWorkers: 4,
  });
  const goal = (title: string, path: string) => {
    const g = store.createGoal({
      title,
      description: title,
      repoPath: root,
      backend: { kind: "fake" },
    });
    store.installPlan(
      g.id,
      {
        tasks: [
          {
            key: title,
            title,
            description: title,
            allowedPaths: [path],
            acceptanceCriteria: ["done"],
          },
        ],
      },
      g.revision,
    );
    return store.getGoal(g.id);
  };
  const first = goal("first", "src/**"),
    later = goal("later", "src/a.ts"),
    independent = goal("independent", "docs/**");
  assert.ok(store.claimNextTask("a", { goalId: first.id }));
  assert.equal(store.claimNextTask("b", { goalId: later.id }), null);
  const question = store.questions().find((q) => q.goalId === later.id)!;
  assert.ok(question);
  assert.equal(store.claimNextTask("b", { goalId: later.id }), null);
  assert.equal(
    store.questions().filter((q) => q.goalId === later.id).length,
    1,
  );
  assert.ok(store.claimNextTask("c", { goalId: independent.id }));
  const restarted = new ControlStore(db);
  restarted.answer(question.id, "coordinate", question.revision, "operator");
  assert.ok(restarted.claimNextTask("b", { goalId: later.id }));
  const context = restarted.projectContext(later.id);
  assert.ok(context.relatedGoals.some((g) => g.id === first.id));
  assert.equal(context.repository, root);
});
test("owner operations checkpoint and release only affected work, reconcile intent, and resume with result artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-ops-"));
  const db = new SqliteStore(join(root, "state.db"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true });
  });
  let store = new ControlStore(db);
  store.setting("scheduler-limits", {
    workers: 4,
    cpu: 16,
    memoryMiB: 16384,
    providerWorkers: 4,
    repositoryWorkers: 4,
  });
  const g = store.createGoal({
    title: "Owner ops",
    description: "Owner ops",
    repoPath: root,
    backend: { kind: "fake" },
  });
  store.installPlan(
    g.id,
    {
      tasks: ["infra", "coding"].map((key) => ({
        key,
        title: key,
        description: key,
        allowedPaths: [key],
        acceptanceCriteria: ["done"],
      })),
    },
    g.revision,
  );
  const claim = store.claimNextTask("infra-worker")!;
  assert.throws(
    () =>
      store.requestOperation(claim.task.id, claim.workerId, claim.generation, {
        action: "VM",
        scope: "test",
        reason: "test",
        idempotencyKey: "vm-1",
      }),
    /Checkpoint/,
  );
  store.checkpoint(claim.task.id, claim.workerId, claim.generation, {
    summary: "saved work",
  });
  const operation = store.requestOperation(
    claim.task.id,
    claim.workerId,
    claim.generation,
    { action: "VM", scope: "test", reason: "test", idempotencyKey: "vm-1" },
  );
  assert.equal(store.getTask(claim.task.id).workerId, null);
  assert.ok(store.claimNextTask("other-worker"));
  store.respondOperation(
    String(operation.id),
    {
      status: "executing",
      explanation: "Creating tagged VM; reconcile before retry",
    },
    "owner",
  );
  store = new ControlStore(db);
  assert.equal(store.operations()[0].status, "executing");
  assert.throws(
    () =>
      store.respondOperation(
        String(operation.id),
        { status: "completed", explanation: "done" },
        "owner",
      ),
    /artifact/,
  );
  store.respondOperation(
    String(operation.id),
    {
      status: "completed",
      explanation: "done",
      resultArtifact: "artifact://scoped-endpoint",
    },
    "owner",
  );
  const resumed = store.claimNextTask("resumed")!;
  assert.equal(resumed.task.id, claim.task.id);
  assert.match(resumed.task.checkpoint!.summary, /scoped-endpoint/);
  assert.equal(store.operations().length, 0);
});
