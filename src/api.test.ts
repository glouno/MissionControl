import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request } from "node:http";
import { createControlServer, openApi } from "./control/api.js";
import { ControlStore } from "./control/store.js";
import { SqliteStore } from "./sqlite.js";
import { CONTROL_HTML } from "./control/ui.js";
test("sensitive reads require authentication, browser sessions require CSRF and exact hosts/origins", async t => {
  const root = await mkdtemp(join(tmpdir(), "mc-session-")), db = new SqliteStore(join(root, "app.db")), store = new ControlStore(db);
  const token = "synthetic-operator-token-for-session-tests";
  const server = createControlServer(store, { token }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); db.close(); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  for (const path of ["/dashboard", "/goals", "/questions", "/workers", "/projects", "/storage"]) assert.equal((await fetch(url + "/api/v1" + path)).status, 401);
  assert.equal((await fetch(url + "/healthz")).status, 200);
  assert.equal((await fetch(url + "/goals", { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  assert.equal((await fetch(url + "/api/v1/dashboard", { headers: { Authorization: `Bearer ${token}`, Origin: "https://attacker.example.invalid" } })).status, 403);
  const wrongHost = await new Promise<number>(resolve => {
    const req = request(url + "/api/v1/dashboard", { headers: { Host: "attacker.example.invalid", Authorization: `Bearer ${token}` } }, res => { res.resume(); resolve(res.statusCode!); }); req.end();
  }); assert.equal(wrongHost, 403);
  const login = await fetch(url + "/api/v1/session", { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: url, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(login.status, 200); const cookie = login.headers.get("set-cookie")!; const { csrf } = await login.json() as {csrf: string};
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.equal((await fetch(url + "/api/v1/dashboard", { headers: { Cookie: cookie } })).status, 200);
  for (const headers of [{ Cookie: cookie, Origin: url }, { Cookie: cookie, "X-CSRF-Token": csrf }] as Record<string, string>[]) {
    assert.equal((await fetch(url + "/api/v1/session/logout", { method: "POST", headers, body: "{}" })).status, 403);
  }
  assert.equal((await fetch(url + "/api/v1/session/logout", { method: "POST", headers: { Cookie: cookie, Origin: url, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: "{}" })).status, 200);
  assert.equal((await fetch(url + "/api/v1/dashboard", { headers: { Cookie: cookie } })).status, 401);
  for (const view of ["Today", "Projects", "Work", "Agents", "History", "New work"]) assert.ok(CONTROL_HTML.includes(view));
  const script = /<script>([\s\S]*)<\/script>/.exec(CONTROL_HTML)![1]; assert.doesNotThrow(() => new Function(script));
});

test("OpenAPI includes shared connector/setup endpoints and excludes legacy settings",()=>{
 const contract=openApi();for(const path of ["/dashboard","/goal-drafts","/configuration","/backups","/session","/connector-auth","/human/commands","/connector-deliveries","/goals/{id}/attempts"]){assert.ok(contract.paths["/api/v1"+path]);}
 assert.equal(JSON.stringify(contract).includes("telegram-defaults"),false);assert.equal(JSON.stringify(contract).includes("telegram-settings"),false);
});

test("approved claim and completed result replay hooks retain registered worker identity", async t => {
 const root=await mkdtemp(join(tmpdir(),"mc-dispatch-http-")),db=new SqliteStore(join(root,"app.db")),store=new ControlStore(db);
 const owner=store.createToken("owned-worker","worker","owned-worker"),other=store.createToken("other-worker","worker","other-worker");
 let claims=0,replays=0;
 const server=createControlServer(store,{token:"synthetic-dispatch-operator-token",externalClaimsDisabled:true,claimTask:async(workerId)=>{assert.equal(workerId,"owned-worker");claims++;return null;},replayResult:(_task,workerId,generation,result)=>{assert.equal(workerId,"owned-worker");assert.equal(generation,4);assert.deepEqual(result,{commit:"a".repeat(40)});replays++;return {status:"accepted"};}});
 server.listen(0,"127.0.0.1");await once(server,"listening");t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));db.close();await rm(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v1`;
 const post=(path:string,token:string,body:unknown)=>fetch(base+path,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
 assert.equal((await post("/claims",owner,{workerId:"owned-worker"})).status,200);assert.equal(claims,1);
 assert.equal((await post("/claims",other,{workerId:"owned-worker"})).status,403);assert.equal(claims,1);
 assert.equal((await post("/tasks/task_completed/result",owner,{workerId:"owned-worker",generation:4,result:{commit:"a".repeat(40)}})).status,200);assert.equal(replays,1);
 assert.equal((await post("/tasks/task_completed/result",other,{workerId:"owned-worker",generation:4,result:{commit:"a".repeat(40)}})).status,403);assert.equal(replays,1);
});

test("project, goal and dashboard status share capability projections without runtime readiness grants", async (t) => {
  const { goalSchema } = await import("./control/schema.js");
  const { executionCapabilities } =
    await import("./control/executionCapabilities.js");
  const root = await mkdtemp(join(tmpdir(), "mc-capability-http-")),
    db = new SqliteStore(join(root, "app.db")),
    store = new ControlStore(db, Date.now, () => {});
  const token = "synthetic-capability-operator-token";
  const server = createControlServer(store, {
    token,
    validateGoal: () => {
      throw Error("private-native-diagnostic");
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const get = async (path: string) => {
    const res = await fetch(base + path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    return (await res.json()) as any;
  };
  const goals = [];
  for (const [id, kind, subscription] of [
    ["paid", "codex", false],
    ["subscription", "codex", true],
    ["portable", "azure", false],
  ] as const) {
    const config = goalSchema.parse({
      title: "Fixture",
      description: "Fixture",
      repoPath: root,
      repository: { mode: "local", branch: "main" },
      verificationCommands: ["true"],
      containerImage: "synthetic",
      backend:
        kind === "azure"
          ? {
              kind,
              model: "fixture",
              endpoint: "https://example.invalid",
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            }
          : { kind },
      maxCostUsd: subscription ? 0 : 1,
      estimatePerRunUsd: subscription ? 0 : 1,
      maxWorkers: 1,
      maxAttempts: 1,
      timeoutMs: 1000,
      executionContract: {
        harness: kind === "azure" ? "tool-loop" : kind,
        provider: subscription ? "codex-subscription" : "azure",
        authentication: {
          kind: subscription ? "session" : "controller",
          reference: "fixture",
        },
        execution: "isolated",
        usagePolicy: subscription
          ? {
              kind: "subscription",
              maxAttempts: 1,
              timeoutMs: 1000,
              maxConcurrency: 1,
            }
          : { kind: "metered", maxCostUsd: 1, estimatePerRunUsd: 1 },
      },
    });
    store.setProject(
      { id, name: "Fixture", family: "Fixture", enabled: true, config },
      "operator",
    );
    goals.push(store.createGoal(config));
  }
  const projects = await get("/projects"),
    list = await get("/goals"),
    dashboard = await get("/dashboard");
  for (const goal of goals) {
    const expected = executionCapabilities(goal.config);
    const project = projects.find(
      (p: any) => executionCapabilities(p.config).path === expected.path,
    );
    const dashboardProject = dashboard.projects.find(
      (p: any) => p.id === project.id,
    );
    assert.deepEqual(project.executionCapabilities, expected);
    assert.deepEqual(
      list.find((g: any) => g.id === goal.id).executionCapabilities,
      expected,
    );
    assert.deepEqual(
      (await get("/goals/" + goal.id)).executionCapabilities,
      expected,
    );
    assert.deepEqual(
      dashboard.goals.find((g: any) => g.id === goal.id).executionCapabilities,
      expected,
    );
    assert.deepEqual(dashboardProject.executionCapabilities, expected);
    assert.equal(dashboardProject.readiness.admissible, false);
    assert.equal(dashboardProject.readiness.liveQualified, false);
    assert.ok(dashboardProject.executionLimits);
    assert.ok(dashboard.executionLimits[goal.id]);
    assert.ok(!JSON.stringify(expected).includes(root));
  }
  assert.ok(!JSON.stringify(dashboard).includes("private-native-diagnostic"));
  const contract = openApi();
  assert.deepEqual(
    (contract.components.schemas.ExecutionCapabilities as any).properties
      .features.properties.tools.properties.state.enum,
    ["supported", "disabled_by_policy", "unavailable"],
  );
  for (const path of ["/projects", "/goals", "/goals/{id}"])
    assert.ok(contract.paths["/api/v1" + path].get.responses[200].content);
});


test("checked-in OpenAPI matches generated capability status contracts", async () => {
  const { readFile } = await import("node:fs/promises");
  const documented = JSON.parse(await readFile(new URL("../docs/openapi.json", import.meta.url), "utf8"));
  assert.deepEqual(documented, openApi());
});
