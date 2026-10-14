import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor } from "./privacy.js";
import { SqliteStore } from "./sqlite.js";
import { ControlStore } from "./control/store.js";
import { randomUUID } from "node:crypto";
test("instance redaction removes known secret values and sensitive fields before persistence", async (t) => {
  const redactor = new Redactor();
  redactor.register("synthetic-private-credential");
  assert.deepEqual(
    redactor.value({
      token: "private",
      credential: { kind: "file", path: "provider" },
      content: "contains synthetic-private-credential",
      nested: [{ refresh_token: "private" }],
    }),
    {
      token: "[REDACTED]",
      credential: { kind: "file", path: "provider" },
      content: "contains [REDACTED]",
      nested: [{ refresh_token: "[REDACTED]" }],
    },
  );
  const root = await mkdtemp(join(tmpdir(), "mc-redact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new SqliteStore(join(root, "app.db")),
    store = new ControlStore(db);
  t.after(() => db.close());
  store.redactor.register("synthetic-private-credential");
  store.event("OUTPUT", "test", {
    body: "contains synthetic-private-credential",
    api_key: "private",
  });
  const event = store.events()[0];
  assert.deepEqual(event.payload, {
    body: "contains [REDACTED]",
    api_key: "[REDACTED]",
  });
  store.outbox("synthetic", { body: "synthetic-private-credential" });
  assert.equal(
    JSON.stringify(db.query("SELECT payload FROM control_outbox")).includes(
      "synthetic-private-credential",
    ),
    false,
  );
  const other = new Redactor();
  assert.equal(
    other.text("synthetic-private-credential"),
    "synthetic-private-credential",
  );
});

test("retired worker credentials remain redacted after restart without growing redaction work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-token-churn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new SqliteStore(join(root, "state.db")),
    store = new ControlStore(db);
  t.after(() => db.close());
  const issued = store.createToken("synthetic", "worker", "synthetic");
  assert.equal(store.authenticate(issued)?.role, "worker");
  store.revokeToken(issued);
  assert.equal(store.authenticate(issued), null);
  const legacy = randomUUID() + randomUUID();
  const restarted = new Redactor();
  assert.equal(
    restarted.text(`tokens ${issued} ${legacy}`),
    "tokens [REDACTED] [REDACTED]",
  );
  // More retired idle-dispatch tokens than an hour of polling. This exercises
  // the former long-running slowdown while preserving redaction for all tokens.
  for (let i = 0; i < 100000; i++)
    store.redactor.register(randomUUID() + randomUUID());
  const start = performance.now();
  const payload = Array.from({ length: 300 }, () => ({
    message: `synthetic ${issued}`,
    phase: "completed",
  }));
  assert.ok(!store.redactor.json(payload).includes(issued));
  assert.ok(
    performance.now() - start < 1000,
    "credential churn must not stall status serialization",
  );
});
