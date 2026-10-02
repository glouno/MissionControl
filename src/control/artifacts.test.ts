import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { initializeState } from "../instance.js";
import { SqliteStore, sql } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { createControlServer } from "./api.js";
import { readArtifact } from "./artifacts.js";
test("artifact downloads require operator authority and reject redirected, external, missing or oversized evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state");
  await initializeState(state);
  await mkdir(join(state, "evidence"));
  await writeFile(join(state, "evidence/check.txt"), "synthetic evidence");
  const db = new SqliteStore(join(state, "mission-control.db"), {
      mustExist: true,
    }),
    store = new ControlStore(db);
  t.after(() => db.close());
  const goal = store.createGoal({
      title: "Synthetic",
      description: "Synthetic",
      repoPath: root,
      backend: { kind: "fake" },
    }),
    id = store.artifact(
      goal.id,
      undefined,
      "check",
      join(state, "evidence/check.txt"),
    );
  const token = "synthetic-operator-token-0123456789",
    server = createControlServer(store, { token, stateRoot: state });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/v1/artifacts/${id}/content`;
  assert.equal((await fetch(url)).status, 401);
  const worker = store.createToken("worker", "worker", "worker"),
    connector = store.createToken("matrix", "connector");
  for (const credential of [worker, connector])
    assert.equal(
      (await fetch(url, { headers: { Authorization: `Bearer ${credential}` } }))
        .status,
      403,
    );
  const result = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), "synthetic evidence");
  assert.match(result.headers.get("content-disposition")!, /attachment/);
  await writeFile(join(root, "private.txt"), "outside");
  await symlink(join(root, "private.txt"), join(state, "evidence/redirect"));
  await assert.rejects(readArtifact(state, "evidence/redirect"), /canonical/);
  await assert.rejects(readArtifact(state, "../private.txt"), /relative/);
  await assert.rejects(readArtifact(state, "evidence/check.txt", 2), /bounded/);
  db.exec(
    `UPDATE control_artifacts SET location='evidence/redirect' WHERE id=${sql(id)}`,
  );
  assert.equal(
    (await fetch(url, { headers: { Authorization: `Bearer ${token}` } }))
      .status,
    409,
  );
});
