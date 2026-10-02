import { ControlClient } from "./client.js";
import type { HumanCommand } from "./human.js";
import type { ConnectorHealthReport } from "./connectorHealth.js";

/** API-only transport. Its credential can access only scoped human services. */
export class TelegramConnector {
  constructor(readonly client:ControlClient,readonly token:string,readonly users:string[],readonly destinations:string[],readonly fetcher:typeof fetch=fetch, readonly quietHours?:{start:number;end:number;timezone:string}){
    if(!users.length||!destinations.length)throw new Error("Telegram requires explicit user and destination allowlists");
  }
  async call(method:string,body:unknown,signal?:AbortSignal){
    const response=await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(35000)]):AbortSignal.timeout(35000)});
    if(!response.ok)throw new Error("Telegram transport request failed");const data=await response.json() as any;if(!data.ok)throw new Error("Telegram transport rejected request");return data.result;
  }
  async health(report: ConnectorHealthReport) {
    try { await this.client.request("/human/health", "POST", report, undefined, 3000); } catch { /* Stale reports remain visible. Raw diagnostics are not persisted. */ }
  }
  async poll(signal?:AbortSignal){
    const state=await this.client.request<{offset?:number}>("/human/transport-state"),offset=state.offset??0;
    const updates=await this.call("getUpdates",{offset,timeout:20,allowed_updates:["message","callback_query"]},signal);
    for(const update of updates){
      if(update.update_id<offset)continue;
      await this.handle(update);
      await this.client.request("/human/transport-state","POST",{offset:update.update_id+1});
    }
    const delivered = await this.flush();
    await this.health({state:delivered ? "healthy" : "degraded", ...(delivered ? {} : {fault:"delivery"}),lastSyncAt:Date.now()});
  }
  async handle(update:any){
    const callback=update.callback_query,message=callback?.message??update.message,user=callback?.from??message?.from;
    if(!message||!user||user.is_bot||!this.users.includes(String(user.id))||!this.destinations.includes(String(message.chat.id)))return;
    const principal={externalIdentity:String(user.id),destination:String(message.chat.id),trust:{encrypted:false,verifiedDevice:false,allowedMembership:true}};
    let command:HumanCommand|undefined;
    const timestamp=Number(message.date??Math.floor(Date.now()/1000))*1000,eventId=String(update.update_id);
    if(callback){
      const parts=String(callback.data).split(" ");
      if(parts[0]==="goal"&&parts.length===2)command={eventId,timestamp:0,transportTimestamp:"received",action:"goal",selectionToken:parts[1]};
      else if(parts[0]==="answer"&&parts.length===4)command={eventId,timestamp:0,transportTimestamp:"received",action:"answer",questionId:parts[1],revision:Number(parts[2]),option:parts[3]};
    }else{
      const text=String(message.text??"").replace(/^\/(\w+)@\w+/,"/$1"),space=text.indexOf(" "),verb=(space<0?text:text.slice(0,space)).slice(1),args=space<0?"":text.slice(space+1).trim();
      if(!text.startsWith("/")||message.edit_date)return;
      if(["start","help"].includes(verb)){
        await this.call("sendMessage",{chat_id:message.chat.id,text:"MissionControl\n/projects\n/goal PROJECT DESCRIPTION\n/status\n/pause GOAL /resume GOAL /cancel GOAL\n/decisions\n/answer QUESTION REVISION OPTION\n/reply GOAL CONTEXT\n/confirm EVENT ACTION"});return;
      }
      if(["projects","status","decisions"].includes(verb))command={eventId,timestamp,action:verb as "projects"|"status"|"decisions",...(args?{projectId:args}:{})};
      else if(["pause","resume","cancel"].includes(verb))command={eventId,timestamp,action:verb as "pause"|"resume"|"cancel",goalId:args};
      else if(verb==="goal"){const split=args.indexOf(" ");if(args){
        const result=await this.client.request<any>("/human/commands","POST",{principal,command:{eventId:`${eventId}:projects`,timestamp,action:"projects"}});
        const selected=Array.isArray(result)&&result.some((p:any)=>p.id===args.slice(0,split));
        command={eventId,timestamp,action:"goal",...(selected?{projectId:args.slice(0,split),description:args.slice(split+1)}:{description:args})};
      }}
      else if(verb==="reply"){const split=args.indexOf(" ");if(split>0)command={eventId,timestamp,action:"context",goalId:args.slice(0,split),context:args.slice(split+1)};}
      else if(verb==="answer"){const [questionId,revision,option]=args.split(/\s+/);if(questionId&&revision&&option)command={eventId,timestamp,action:"answer",questionId,revision:Number(revision),option};}
      else if(verb==="confirm"){const [confirmationEventId,action]=args.split(/\s+/);if(confirmationEventId&&["goal","pause","resume","cancel","context"].includes(action))command={eventId,timestamp,action:action as HumanCommand["action"],confirmationEventId};}
    }
    if(!command){await this.call("sendMessage",{chat_id:message.chat.id,text:"Command unavailable. Use /help for explicit commands."});return;}
    try{await this.client.request("/human/commands","POST",{principal,command});}
    catch(error){if(!(error as any).status || (error as any).status>=500)throw error;await this.call("sendMessage",{chat_id:message.chat.id,text:"Command was rejected. Check identity, project, permissions and current decision revision."});}
    if(callback)await this.call("answerCallbackQuery",{callback_query_id:callback.id,text:"Command processed"});
  }
  quiet(now = new Date()) {
    const q=this.quietHours;if(!q)return false;
    const hour=Number(new Intl.DateTimeFormat("en",{hour:"numeric",hourCycle:"h23",timeZone:q.timezone}).format(now));
    return q.start===q.end || (q.start<q.end?hour>=q.start&&hour<q.end:hour>=q.start||hour<q.end);
  }
  async flush(){
    let delivered = true;
    const deliveries=await this.client.request<any[]>("/connector-deliveries");
    for(const delivery of deliveries){
      if(this.quiet() && delivery.kind !== "command_receipt") continue;
      if(!this.destinations.includes(delivery.destination))throw new Error("Recorded Telegram destination is outside configured scope");
      try{
        const payload=delivery.payload;
        const text=delivery.kind==="command_receipt"?`MissionControl durably accepted event ${payload.eventId}\n${JSON.stringify(payload.result,null,2)}`:`MissionControl — ${delivery.kind}\n${JSON.stringify(payload,null,2)}`;
        const result=payload.result;
        const questions=delivery.kind==="question"?[{id:payload.questionId,revision:payload.revision,request:payload.request}]:Array.isArray(result)?result.filter((q:any)=>q.request?.options):[];
        const buttons=questions.flatMap((q:any)=>q.request.options.map((o:any)=>({text:o.label,callback_data:`answer ${q.id} ${q.revision} ${o.id}`}))).filter((b:any)=>Buffer.byteLength(b.callback_data)<=64);
        if(result?.selectionRequired)for(const p of result.projects)buttons.push({text:p.name,callback_data:`goal ${p.selectionToken}`});
        const receipt=await this.call("sendMessage",{chat_id:delivery.destination,text:text.slice(0,4000),...(buttons.length?{reply_markup:{inline_keyboard:buttons.map((b:any)=>[b])}}:{})});
        await this.client.request(`/connector-deliveries/${delivery.id}`,"POST",{status:"sent",receipt:String(receipt.message_id)});
      }catch{delivered = false; await this.client.request(`/connector-deliveries/${delivery.id}`,"POST",{status:"retry"});}
    }
    return delivered;
  }
}
