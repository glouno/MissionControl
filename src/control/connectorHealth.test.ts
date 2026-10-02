import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { createControlServer } from "./api.js";
import { ControlClient } from "./client.js";
import { HumanCommandService } from "./human.js";
import { connectorHealth, recordConnectorHealth } from "./connectorHealth.js";
import { dashboardSnapshot } from "./dashboard.js";

test("connector observations remain scoped, bounded and stale after a crash without granting trust", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-health-"));
  const db = new SqliteStore(join(root, "app.db"));
  let now = Date.now();
  const store = new ControlStore(db, () => now);
  const descriptors = [
    { id: "matrix", kind: "matrix" as const, enabled: true },
    { id: "telegram", kind: "telegram" as const, enabled: false },
  ];
  const human = new HumanCommandService(store, [], () => {
    throw Error("No enabled bindings");
  });
  const token = "synthetic-operator-token-0123456789";
  const server = createControlServer(store, {
    token,
    humanService: () => human,
    connectors: () => descriptors,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const matrix = new ControlClient(
    url,
    store.createToken("matrix", "connector"),
  );
  const telegram = new ControlClient(
    url,
    store.createToken("telegram", "connector"),
  );
  const worker = new ControlClient(
    url,
    store.createToken("worker", "worker", "worker"),
  );
  const operator = new ControlClient(url, token);
  assert.equal(connectorHealth(store, descriptors)[0].state, "unavailable");
  await assert.rejects(
    worker.request("/human/health", "POST", { state: "healthy" }),
    /Scoped connector/,
  );
  await assert.rejects(
    operator.request("/human/health", "POST", { state: "healthy" }),
    /Scoped connector/,
  );
  await assert.rejects(matrix.request("/connectors"), /operator or worker/);
  await assert.rejects(
    telegram.request("/human/health", "POST", { state: "healthy" }),
    /disabled/,
  );
  await assert.rejects(
    matrix.request("/human/health", "POST", {
      state: "healthy",
      accessToken: "sensitive",
    }),
  );
  await assert.rejects(
    matrix.request("/human/health", "POST", {
      state: "healthy",
      fault: "trust",
    }),
  );
  await assert.rejects(
    matrix.request("/human/health", "POST", {
      state: "healthy",
      pendingInbox: 10001,
    }),
  );
  await matrix.request("/human/health", "POST", {
    state: "degraded",
    fault: "trust",
    lastSyncAt: now,
    pendingInbox: 2,
    exhaustedInbox: 1,
  });
  const initial = await operator.request<any[]>("/connectors");
  assert.equal(initial[0].state, "degraded");
  assert.match(initial[0].action, /verification/);
  assert.equal(initial[0].liveQualified, false);
  assert.equal(initial[1].state, "disabled");
  await assert.rejects(
    matrix.request("/human/health", "POST", {
      state: "healthy",
      lastSyncAt: now - 1,
    }),
    /backwards/,
  );
  await assert.rejects(
    matrix.request("/human/health", "POST", {
      state: "healthy",
      lastSyncAt: now + 300001,
    }),
    /future/,
  );
  await matrix.request("/human/health", "POST", {
    state: "degraded",
    fault: "transport",
  });
  assert.equal(connectorHealth(store, descriptors)[0].reported.lastSyncAt, now);
  now += 90001;
  const stale = connectorHealth(store, descriptors)[0];
  assert.equal(stale.state, "unavailable");
  assert.equal(stale.reported.state, "degraded");
  assert.equal(
    dashboardSnapshot(store, undefined, "", descriptors).connectors[0]
      .syncAgeMs,
    90001,
  );
  const reopened = new ControlStore(db, () => now);
  assert.equal(connectorHealth(reopened, descriptors)[0].state, "unavailable");
  recordConnectorHealth(reopened, "matrix", {
    state: "healthy",
    lastSyncAt: now,
  });
  assert.equal(connectorHealth(reopened, descriptors)[0].state, "healthy");
  await assert.rejects(
    matrix.request("/human/commands", "POST", {
      principal: {
        externalIdentity: "untrusted",
        destination: "unknown",
        trust: {
          encrypted: true,
          verifiedDevice: true,
          allowedMembership: true,
          deviceId: "fake",
        },
      },
      command: { eventId: "fake", timestamp: now, action: "status" },
    }),
    /authorized/,
  );
});
