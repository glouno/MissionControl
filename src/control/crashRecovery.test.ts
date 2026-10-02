import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { SqliteStore } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { goalSchema } from "./schema.js";
import { HumanCommandService, pendingDeliveries } from "./human.js";
const binding = {
  connectorId: "matrix-test",
  kind: "matrix" as const,
  operatorId: "synthetic",
  externalIdentity: "@synthetic:example.invalid",
  destination: "!synthetic:example.invalid",
  projectIds: ["synthetic"],
  permissions: ["goal" as const],
  requireVerifiedDevice: true,
  enabled: true,
};
const principal = {
  connectorId: binding.connectorId,
  externalIdentity: binding.externalIdentity,
  destination: binding.destination,
  trust: {
    encrypted: true,
    verifiedDevice: true,
    allowedMembership: true,
    deviceId: "VERIFIED",
  },
};
test("SIGKILL after durable connector intake retains one goal, reservation and acknowledgement on replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-intake-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "db");
  const command = {
    eventId: "$synthetic",
    timestamp: Date.now(),
    action: "goal",
    projectId: "synthetic",
    description: "Synthetic restart",
  };
  const storeUrl = new URL("./store.js", import.meta.url).href,
    sqlUrl = new URL("../sqlite.js", import.meta.url).href,
    humanUrl = new URL("./human.js", import.meta.url).href,
    schemaUrl = new URL("./schema.js", import.meta.url).href;
  const script = `import {SqliteStore} from ${JSON.stringify(sqlUrl)};import {ControlStore} from ${JSON.stringify(storeUrl)};import {HumanCommandService} from ${JSON.stringify(humanUrl)};import {goalSchema} from ${JSON.stringify(schemaUrl)};
 const db=new SqliteStore(${JSON.stringify(path)}),store=new ControlStore(db),config=goalSchema.parse({title:'Synthetic',description:'Synthetic',repoPath:${JSON.stringify(root)},backend:{kind:'fake'},maxCostUsd:5,estimatePerRunUsd:1,projectId:'synthetic'});new HumanCommandService(store,[${JSON.stringify(binding)}],(_id,description)=>({...config,description})).execute(${JSON.stringify(principal)},${JSON.stringify(command)});process.stdout.write('COMMITTED\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH },
  });
  const exited = once(child, "exit");
  await new Promise<void>((yes, no) => {
    child.stdout.once("data", () => yes());
    child.once("error", no);
    child.once("exit", () => no(Error("Child exited before commit")));
  });
  child.kill("SIGKILL");
  await exited;
  const db = new SqliteStore(path, { mustExist: true });
  t.after(() => db.close());
  const store = new ControlStore(db),
    config = goalSchema.parse({
      title: "Synthetic",
      description: "Synthetic",
      repoPath: root,
      backend: { kind: "fake" },
      maxCostUsd: 5,
      estimatePerRunUsd: 1,
      projectId: "synthetic",
    });
  const service = new HumanCommandService(
      store,
      [binding],
      (_id, description) => ({ ...config, description }),
    ),
    result = service.execute(principal, command) as any;
  assert.equal(store.goals().length, 1);
  assert.equal(result.goalId, store.goals()[0].id);
  assert.equal(pendingDeliveries(store, binding.connectorId).length, 1);
  assert.equal(db.integrityCheck()[0], "ok");
});
test("SIGKILL before SQLite transaction commit rolls back all intake-like effects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-rollback-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "db");
  let db = new SqliteStore(path);
  db.exec("CREATE TABLE effects(id TEXT)");
  db.close();
  const script = `import {SqliteStore} from ${JSON.stringify(new URL("../sqlite.js", import.meta.url).href)};const db=new SqliteStore(${JSON.stringify(path)});db.exec("BEGIN IMMEDIATE; INSERT INTO effects VALUES('unacknowledged')");process.stdout.write('STAGED\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await exited;
  db = new SqliteStore(path, { mustExist: true });
  t.after(() => db.close());
  assert.equal(db.query("SELECT * FROM effects").length, 0);
  assert.equal(db.integrityCheck()[0], "ok");
});
