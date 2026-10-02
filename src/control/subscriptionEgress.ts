import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {connect,type Socket} from "node:net";
import {readFile} from "node:fs/promises";
import {once} from "node:events";
import {z} from "zod";
import {clientHelloServerName} from "./tlsSni.js";
import {egressPolicySchema,resolveEgress,type EgressPolicy} from "./egressPolicy.js";
const frameSchema=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("connect"),id:z.string().regex(/^[a-f0-9]{32}$/),host:z.string().max(253),port:z.number().int()}).strict(),
 z.object({kind:z.literal("data"),id:z.string().regex(/^[a-f0-9]{32}$/),data:z.string().max(90000)}).strict(),
 z.object({kind:z.literal("close"),id:z.string().regex(/^[a-f0-9]{32}$/)}).strict(),
]);
/** Dedicated auth-runtime egress; no wildcard targets or host TCP listener. */
export async function subscriptionEgress(container:string,scriptPath:string,input:EgressPolicy,token:string,assertAuthority:()=>void,launch:typeof spawn=spawn){
 const policy=egressPolicySchema.parse(input),script=await readFile(scriptPath,"utf8");
 assertAuthority();
 const child=launch("docker",["exec","-i",container,"python3","-u","-c",script],{stdio:["pipe","pipe","pipe"],env:{PATH:process.env.PATH}});
 const closed=once(child,"close").catch(()=>undefined),sockets=new Map<string,Socket>(),hellos=new Map<string,{host:string;bytes:Buffer;verified:boolean}>();let spent=0,stopped=false;
 const send=(value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);if(!child.stdin.write(Buffer.concat([header,bytes])))return once(child.stdin,"drain").then(()=>undefined);return Promise.resolve()};
 const stop=()=>{if(stopped)return;stopped=true;for(const socket of sockets.values())socket.destroy();child.kill("SIGTERM");child.stdin.destroy();child.stdout.destroy()};
 const expiry=setTimeout(stop,policy.timeoutMs);expiry.unref();child.stderr.resume();child.once("error",stop);child.once("exit",stop);
 await send({token,maxConnections:policy.maxConnections,timeoutMs:policy.timeoutMs});
 const done=(async()=>{
  let pending=Buffer.alloc(0);
  for await(const chunk of child.stdout){pending=Buffer.concat([pending,Buffer.from(chunk)]);
   while(pending.length>=4){const length=pending.readUInt32BE(0);if(length<1||length>1024*1024)throw new Error("Invalid egress frame limit");if(pending.length<length+4)break;
    const frame=frameSchema.parse(JSON.parse(pending.subarray(4,length+4).toString()));pending=pending.subarray(length+4);assertAuthority();
    if(frame.kind==="connect"){
     if(sockets.size>=policy.maxConnections||sockets.has(frame.id)){await send({kind:"error",id:frame.id});continue;}
     try{
      const address=await resolveEgress(policy,frame.host,frame.port);assertAuthority();
      const socket=connect({host:address,port:443});sockets.set(frame.id,socket);hellos.set(frame.id,{host:frame.host,bytes:Buffer.alloc(0),verified:false});socket.setTimeout(15000,()=>socket.destroy());
      socket.once("connect",()=>{socket.setTimeout(policy.timeoutMs,()=>socket.destroy());void send({kind:"opened",id:frame.id}).catch(stop)});
      socket.on("data",data=>{try{assertAuthority();spent+=data.length;if(spent>policy.maxBytes)throw new Error("Egress byte limit");socket.pause();void send({kind:"data",id:frame.id,data:data.toString("base64")}).then(()=>socket.resume()).catch(stop)}catch{stop()}});
      socket.once("error",()=>{void send({kind:"error",id:frame.id}).catch(stop)});socket.once("close",()=>{sockets.delete(frame.id);hellos.delete(frame.id);void send({kind:"close",id:frame.id}).catch(stop)});
     }catch{await send({kind:"error",id:frame.id});}
    }else if(frame.kind==="data"){
     const socket=sockets.get(frame.id);if(!socket)throw new Error("Unknown egress connection");let data:Buffer=Buffer.from(frame.data,"base64");spent+=data.length;if(spent>policy.maxBytes)throw new Error("Egress byte limit");const hello=hellos.get(frame.id)!;
     if(!hello.verified){hello.bytes=Buffer.concat([hello.bytes,data]);if(hello.bytes.length>20000)throw new Error("TLS ClientHello byte limit");const parsed=clientHelloServerName(hello.bytes);if(!parsed.complete)continue;if(parsed.host!==hello.host)throw new Error("TLS server name differs from admitted egress host");hello.verified=true;data=hello.bytes;hello.bytes=Buffer.alloc(0);}
     if(!socket.write(data))await once(socket,"drain");
    }else sockets.get(frame.id)?.destroy();
   }
  }
 })().catch(stop).finally(()=>{clearTimeout(expiry);stop()});
 return {stop:async()=>{stop();await done;await closed},child};
}
