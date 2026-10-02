import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { SqliteStore } from "../sqlite.js";
import { InferenceGateway } from "./inferenceGateway.js";
import { StdioGateway } from "./stdioGateway.js";

test("Python stdio relay streams authenticated inference, denies foreign sessions, and revokes on closure",{timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),"mc-stdio-")),db=new SqliteStore(join(root,"test.db"));
 let calls=0;const gateway=new InferenceGateway(db,{synthetic:{protocol:"responses",endpoint:"https://example.invalid/v1",headers:async()=>({Authorization:"Bearer private-upstream"})}},()=>{},async()=>{calls++;return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',{headers:{"content-type":"text/event-stream"}})});
 const server=gateway.server();server.listen(0,"127.0.0.1");await once(server,"listening");
 const probe=createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));
 const script=fileURLToPath(new URL("../../environments/worker/gateway-relay.py",import.meta.url));
 // Same production Python framing/HTTP server, with a temporary loopback port.
 const launcher:typeof spawn=((_cmd:string,args:string[])=>spawn("python3",["-u","-c",args.at(-1)!.replace("('0.0.0.0', 8080)",`('127.0.0.1', ${port})`)],{stdio:["pipe","pipe","pipe"],env:{PATH:process.env.PATH}})) as typeof spawn;
 const bridge=new StdioGateway(gateway,`http://127.0.0.1:${(server.address() as {port:number}).port}`,launcher);
 t.after(async()=>{await bridge.stop("local");await new Promise<void>(r=>server.close(()=>r()));db.close();await rm(root,{recursive:true,force:true})});
 await bridge.start("local","synthetic",script);
 const cap={sessionId:"local",goalId:"synthetic",taskId:"test",generation:1,provider:"synthetic",protocol:"responses" as const,model:"fake",expiresAt:Date.now()+10000};
 const token=gateway.issue(cap),foreign=gateway.issue({...cap,sessionId:"foreign"});
 const request=async(credential:string)=>fetch(`http://127.0.0.1:${port}/v1/responses`,{method:"POST",headers:{Authorization:`Bearer ${credential}`,"content-type":"application/json"},body:JSON.stringify({model:"fake",input:"synthetic",stream:true}),signal:AbortSignal.timeout(5000)});
 let response:Response|undefined;for(let i=0;i<50;i++){try{response=await request(token);break}catch{await new Promise(r=>setTimeout(r,20))}}
 assert.equal(response?.status,200);assert.match(await response!.text(),/response.completed/);assert.equal(calls,1);
 assert.equal((await request(foreign)).status,403);assert.equal(calls,1);
 assert.equal((await request("invalid")).status,403);assert.equal(calls,1);
 await bridge.stop("local");assert.throws(()=>gateway.authenticate(token),/revoked/);
});
