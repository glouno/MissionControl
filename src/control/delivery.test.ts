import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import {
  recordObservation,
  observations,
  assertObservationsClosed,
  closeObservation,
  deliveryIncident,
} from "./delivery.js";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-delivery-"));
  const db = new SqliteStore(join(root, "state.db"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const store = new ControlStore(db);
  const goal = store.createGoal({
    title: "Synthetic goal",
    description: "Synthetic",
    repoPath: root,
    backend: { kind: "fake" },
  });
  return { root, store, goal };
}
test("operator observations are durable, deduplicated, scope-bound and fail closed without verifier review", async (t) => {
  const { store, goal } = await fixture(t);
  const value = {
    candidateSha: "a".repeat(40),
    summary: "Standalone effect",
    evidence: "Synthetic reproduction",
    blocking: true,
  };
  const first = recordObservation(store, goal.id, value, "operator");
  assert.deepEqual(recordObservation(store, goal.id, value, "operator"), first);
  assert.equal(observations(store, goal.id).length, 1);
  assert.throws(() => assertObservationsClosed(store, goal.id), /Unresolved/);
  assert.throws(
    () =>
      closeObservation(store, goal.id, first.id, "b".repeat(40), "operator"),
    /passing tests/,
  );
  assert.throws(() =>
    recordObservation(
      store,
      goal.id,
      { ...value, taskId: "outside" },
      "operator",
    ),
  );
  assert.throws(() =>
    recordObservation(store, goal.id, { ...value, extra: true }, "operator"),
  );
});
test("unchanged delivery failure creates one durable incident and notification", async (t) => {
  const { store, goal } = await fixture(t);
  const args = [
    goal.id,
    "a".repeat(40),
    "b".repeat(40),
    "checks_failed",
    "Dependency preflight",
  ] as const;
  deliveryIncident(store, ...args);
  deliveryIncident(store, ...args);
  assert.equal(
    store.events(0, goal.id).filter((e: any) => e.type === "DELIVERY_BLOCKED")
      .length,
    1,
  );
  assert.equal(
    store.db.query("SELECT * FROM control_outbox WHERE kind='delivery_failure'")
      .length,
    1,
  );
  deliveryIncident(
    store,
    goal.id,
    "c".repeat(40),
    "b".repeat(40),
    "checks_pending",
    "Current candidate pending",
  );
  assert.equal(
    store.db.query("SELECT * FROM control_outbox WHERE kind='delivery_failure'")
      .length,
    2,
  );
});
test("reopening the store resumes the same incident and unresolved observation", async t => {
  const {store, goal} = await fixture(t);
  const value = {candidateSha:"a".repeat(40), summary:"Synthetic unresolved", evidence:"Exact synthetic fixture"};
  recordObservation(store, goal.id, value, "operator");
  deliveryIncident(store, goal.id, "a".repeat(40), "b".repeat(40), "checks_failed", "Setup failure");
  const restarted = new ControlStore(store.db);
  assert.equal(observations(restarted, goal.id).length, 1);
  assert.throws(() => assertObservationsClosed(restarted, goal.id));
  deliveryIncident(restarted, goal.id, "a".repeat(40), "b".repeat(40), "checks_failed", "Setup failure");
  assert.equal(restarted.db.query("SELECT * FROM control_outbox WHERE kind='delivery_failure'").length, 1);
});
test("operator observation API accepts no worker lease and passes context to the next reader", async t => {
  const {store, goal} = await fixture(t);
  const {createControlServer} = await import("./api.js");
  const {once} = await import("node:events");
  const token = "synthetic-operator-token-0123456789";
  const server = createControlServer(store,{token});
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/v1/goals/${goal.id}/observations`;
  const headers = {Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
  const input = {candidateSha:"a".repeat(40),summary:"Synthetic API observation",evidence:"Synthetic reproduction"};
  const result = await fetch(url,{method:"POST",headers,body:JSON.stringify(input)});
  assert.equal(result.status,200); const saved = await result.json() as any;
  const rows = await (await fetch(url,{headers})).json() as any[];
  assert.equal(rows[0].id,saved.id);
  const close = await fetch(`${url}/${saved.id}/close`,{method:"POST",headers,body:JSON.stringify({candidateSha:"b".repeat(40)})});
  assert.equal(close.status,409);
  assert.throws(() => store.setGoalState(goal.id,"completed",store.getGoal(goal.id).revision,"operator"),/Unresolved/);
});
