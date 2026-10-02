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
