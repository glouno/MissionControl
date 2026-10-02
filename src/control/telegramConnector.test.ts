import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {once} from "node:events";
import {SqliteStore} from "../sqlite.js";
import {ControlStore} from "./store.js";
import {ControlClient} from "./client.js";
import {createControlServer} from "./api.js";
import {goalSchema} from "./schema.js";
import {HumanCommandService,pendingDeliveries,type HumanBinding} from "./human.js";
import {TelegramConnector} from "./telegramConnector.js";
test("API-only Telegram retries without duplicate effects and cannot read operator endpoints",async t=>{
 const root=await mkdtemp(join(tmpdir(),"mc-telegram-v1-")),db=new SqliteStore(join(root,"app.db")),store=new ControlStore(db);
 const binding:HumanBinding={connectorId:"telegram",kind:"telegram",operatorId:"example",externalIdentity:"1",destination:"2",projectIds:["sample"],permissions:["goal","projects","status"],requireVerifiedDevice:false,enabled:true};
 const human=new HumanCommandService(store,[binding],(_p,description)=>goalSchema.parse({title:description,description,repoPath:root,backend:{kind:"fake"},projectId:"sample"}));
 const server=createControlServer(store,{token:"synthetic-operator-token-0123456789",humanService:()=>human});server.listen(0,"127.0.0.1");await once(server,"listening");t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));db.close();await rm(root,{recursive:true,force:true})});
 const client=new ControlClient(`http://127.0.0.1:${(server.address() as {port:number}).port}`,store.createToken("telegram","connector"));
 await assert.rejects(client.request("/goals"),/operator or worker/);
 store.setProject({id:"sample",name:"Sample",family:"Example",enabled:false,config:goalSchema.parse({title:"Fixture",description:"Fixture",repoPath:root,projectId:"sample",backend:{kind:"fake"}})},"test");
 const updates=[{update_id:10,message:{from:{id:1},chat:{id:2},date:Math.floor(Date.now()/1000),text:"/goal sample Synthetic"}}];
 let fail=true,sends=0;const fetcher:typeof fetch=async(url,init)=>{
  if(String(url).endsWith("getUpdates")){const body=JSON.parse(String(init?.body));return Response.json({ok:true,result:updates.filter(u=>u.update_id>=body.offset)})}
  if(fail)return new Response("",{status:503});sends++;return Response.json({ok:true,result:{message_id:sends}});
 };
 const connector=new TelegramConnector(client,"synthetic",["1"],["2"],fetcher);await connector.poll();assert.equal(store.goals().length,1);assert.equal(pendingDeliveries(store,"telegram").length,0); // retry is delayed
 fail=false;store.db.exec("UPDATE connector_deliveries SET due_at=0");await connector.poll();assert.equal(store.goals().length,1);assert.equal(sends,2);assert.equal(store.setting("connector-transport:telegram").offset,11);
 await connector.handle({update_id:12,message:{from:{id:999},chat:{id:2},date:Math.floor(Date.now()/1000),text:"/goal sample Unauthorized"}});assert.equal(store.goals().length,1);
});

test("project picker survives connector restart and competing callbacks cannot submit twice",async t=>{
 const root=await mkdtemp(join(tmpdir(),"mc-telegram-picker-")),db=new SqliteStore(join(root,"app.db")),store=new ControlStore(db);
 const bindings:HumanBinding[]=[{connectorId:"telegram",kind:"telegram",operatorId:"example",externalIdentity:"1",destination:"2",projectIds:["one","two"],permissions:["goal","projects","status","answer","decisions"],requireVerifiedDevice:false,enabled:true}];
 for(const id of ["one","two"])store.setProject({id,name:id,family:"Example",enabled:true,config:goalSchema.parse({title:"Fixture",description:"Fixture",repoPath:root,projectId:id,backend:{kind:"fake"},repository:{mode:"local",branch:"main"},verificationCommands:["true"]})},"test");
 const human=new HumanCommandService(store,bindings,(id,description)=>({...store.projects().find(p=>p.id===id)!.config,description}));
 const server=createControlServer(store,{token:"synthetic-operator-token-0123456789",humanService:()=>human});server.listen(0,"127.0.0.1");await once(server,"listening");t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));db.close();await rm(root,{recursive:true,force:true})});
 const client=new ControlClient(`http://127.0.0.1:${(server.address() as {port:number}).port}`,store.createToken("telegram","connector"));
 const sent:any[]=[];const fetcher:typeof fetch=async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return Response.json({ok:true,result:{message_id:sent.length}})};
 let connector=new TelegramConnector(client,"synthetic",["1"],["2"],fetcher);
 await connector.handle({update_id:10,message:{from:{id:1},chat:{id:2},date:Math.floor(Date.now()/1000),text:"/goal Add synthetic export"}});await connector.flush();
 const picker=sent.find(p=>p.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("goal "));
 assert.ok(picker);assert.equal(store.goals().length,0);
 connector=new TelegramConnector(client,"synthetic",["1"],["2"],fetcher);
 const callback=(update_id:number,data:string,user=1)=>({update_id,callback_query:{id:String(update_id),from:{id:user},data,message:{chat:{id:2}}}});
 await connector.handle(callback(11,picker.reply_markup.inline_keyboard[0][0].callback_data,999));assert.equal(store.goals().length,0);
 await connector.handle(callback(12,picker.reply_markup.inline_keyboard[0][0].callback_data));
 await connector.handle(callback(12,picker.reply_markup.inline_keyboard[0][0].callback_data));
 await connector.handle(callback(13,picker.reply_markup.inline_keyboard[1][0].callback_data));assert.equal(store.goals().length,1);assert.equal(store.goals()[0].config.description,"Add synthetic export");
 const goal=store.goals()[0],q=store.requestGoalHuman(goal.id,{question:"Proceed?",reason:"Synthetic",options:[{id:"yes",label:"Yes"},{id:"no",label:"No"}]});
 await connector.flush();const decision=sent.find(p=>p.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("answer "));
 assert.ok(decision);await connector.handle(callback(14,decision.reply_markup.inline_keyboard[0][0].callback_data));assert.equal(store.question(q.id).status,"answered");
 await connector.handle(callback(15,decision.reply_markup.inline_keyboard[1][0].callback_data));assert.equal(store.question(q.id).answer.option,"yes");
 const quiet=new TelegramConnector(client,"synthetic",["1"],["2"],fetcher,{start:22,end:7,timezone:"UTC"});
 assert.equal(quiet.quiet(new Date("2026-01-01T23:00:00Z")),true);assert.equal(quiet.quiet(new Date("2026-01-01T12:00:00Z")),false);
});
