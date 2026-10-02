import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { z } from "zod";
import type { InferenceGateway } from "./inferenceGateway.js";

const frameSchema=z.object({path:z.enum(["/v1/responses","/v1/messages"]),headers:z.record(z.string(),z.string()),body:z.string().max(6*1024*1024)}).strict();
const MAX_FRAME=6*1024*1024;
async function* frames(stream:NodeJS.ReadableStream){
 let pending=Buffer.alloc(0),size:number|undefined;
 for await(const value of stream){
  const chunk=Buffer.from(value);pending=Buffer.concat([pending,chunk]);
  while(true){
   if(size===undefined){if(pending.length<4)break;size=pending.readUInt32BE(0);pending=pending.subarray(4);if(size<1||size>MAX_FRAME)throw new Error("Invalid inference relay frame limit")}
   if(pending.length<size)break;
   const data=pending.subarray(0,size);pending=pending.subarray(size);size=undefined;yield JSON.parse(data.toString("utf8"));
  }
  if(pending.length>MAX_FRAME)throw new Error("Inference relay buffer exceeded");
 }
 if(pending.length||size!==undefined)throw new Error("Truncated inference relay frame");
}
async function send(child:ChildProcessWithoutNullStreams,value:unknown){
 const body=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);header.writeUInt32BE(body.length);
 if(body.length>MAX_FRAME)throw new Error("Inference relay output exceeded");
 if(!child.stdin.write(Buffer.concat([header,body])))await once(child.stdin,"drain");
}
/** Docker exec is the only relay channel. It grants no host/private-network path. */
export class StdioGateway {
 private channels=new Map<string,{child:ChildProcessWithoutNullStreams;done:Promise<void>;closed:Promise<unknown>}>();
 constructor(readonly gateway:InferenceGateway,readonly url:string,readonly launch:typeof spawn=spawn,readonly fetcher:typeof fetch=fetch) {
  const parsed=new URL(url);if(parsed.protocol!=="http:"||parsed.hostname!=="127.0.0.1"||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error("Gateway bridge requires fixed loopback HTTP");
 }
 async start(sessionId:string,container:string,relayScript:string){
  if(this.channels.has(sessionId))throw new Error("Session relay already has a writer");
  const script=await readFile(relayScript,"utf8");
  const child=this.launch("docker",["exec","-i",container,"python3","-u","-c",script],{stdio:["pipe","pipe","pipe"],env:{PATH:process.env.PATH}});
  child.stderr.resume();
  const closed=once(child,"close").catch(()=>undefined);
  const done=this.pump(sessionId,child).catch(()=>{this.gateway.revoke(sessionId);child.kill("SIGTERM")});
  this.channels.set(sessionId,{child,done,closed});
  child.once("error",()=>this.gateway.revoke(sessionId));
  child.once("exit",()=>{this.gateway.revoke(sessionId);this.channels.delete(sessionId)});
 }
 private async pump(sessionId:string,child:ChildProcessWithoutNullStreams){
  for await(const raw of frames(child.stdout)){
   const frame=frameSchema.parse(raw);
   const token=frame.headers.authorization?.replace(/^Bearer /,"")??frame.headers["x-api-key"]??"";
   let started=false;
   try{
    const cap=this.gateway.authenticate(token);
    if(cap.sessionId!==sessionId)throw new Error("Inference relay session differs");
    const body=Buffer.from(frame.body,"base64");if(body.length<1||body.length>4*1024*1024)throw new Error("Inference relay request exceeded");
    const headers=Object.fromEntries(Object.entries(frame.headers).filter(([key])=>["authorization","x-api-key","content-type","anthropic-beta"].includes(key)));
    const response=await this.fetcher(this.url+frame.path,{method:"POST",headers,body,redirect:"error",signal:AbortSignal.timeout(Math.min(3600000,Math.max(1,cap.expiresAt-Date.now())))});
    await send(child,{kind:"start",status:response.status,contentType:response.headers.get("content-type")??"application/json"});started=true;
    if(response.body)for await(const chunk of response.body)await send(child,{kind:"data",data:Buffer.from(chunk).toString("base64")});
    await send(child,{kind:"end"});
   }catch{
    if(started)throw new Error("Inference stream failed after response headers");
    await send(child,{kind:"start",status:403,contentType:"application/json"});
    await send(child,{kind:"data",data:Buffer.from('{"error":"Inference capability denied"}').toString("base64")});await send(child,{kind:"end"});
   }
  }
 }
 async stop(sessionId:string){const channel=this.channels.get(sessionId);if(!channel)return;this.gateway.revoke(sessionId);channel.child.kill("SIGTERM");channel.child.stdin.destroy();channel.child.stdout.destroy();await channel.done;await channel.closed;this.channels.delete(sessionId)}
}
