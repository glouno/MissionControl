import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { ControlStore } from "./store.js";
import { sql } from "../sqlite.js";
import { ControlError, type GoalConfig } from "./schema.js";

const name = z.string().min(1).max(200);
export const humanBindingSchema = z.object({
  connectorId: name, kind: z.enum(["matrix", "telegram"]), operatorId: name, externalIdentity: name, destination: name,
  projectIds: z.array(name).max(100), permissions: z.array(z.enum(["projects", "status", "goal", "pause", "resume", "cancel", "decisions", "answer", "context"])),
  requireVerifiedDevice: z.boolean().default(true), enabled: z.boolean().default(false),
}).strict();
export type HumanBinding = z.output<typeof humanBindingSchema>;
export interface HumanPrincipal {
  connectorId: string; externalIdentity: string; destination: string;
  trust: { encrypted: boolean; verifiedDevice: boolean; allowedMembership: boolean; deviceId?: string };
}
export const humanCommandSchema = z.object({
  eventId: name, timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  action: z.enum(["projects", "status", "goal", "pause", "resume", "cancel", "decisions", "answer", "context"]),
  transportTimestamp:z.enum(["received"]).optional(),
  projectId: name.optional(), goalId: name.optional(), description: z.string().min(1).max(100000).optional(),
  questionId: name.optional(), revision: z.number().int().positive().optional(), option: name.optional(),
  context: z.string().min(1).max(16000).optional(), confirmationEventId: name.optional(), selectionToken: z.string().regex(/^[a-f0-9]{32}$/).optional(),
}).strict();
export type HumanCommand = z.output<typeof humanCommandSchema>;
const json = (value: unknown) => sql(JSON.stringify(value));
export interface ConnectorDelivery {
  id: string; notificationId: string; connectorId: string; destination: string; transactionId: string; kind: string; payload: unknown; attempts: number;
}
export class HumanCommandService {
  constructor(readonly store: ControlStore, readonly bindings: HumanBinding[], readonly admit: (projectId: string, description: string) => GoalConfig) {}
  binding(principal: HumanPrincipal): HumanBinding {
    const binding = this.bindings.find(b => b.enabled && b.connectorId === principal.connectorId && b.externalIdentity === principal.externalIdentity && b.destination === principal.destination);
    if (binding?.requireVerifiedDevice && (!principal.trust.verifiedDevice || !principal.trust.deviceId)) throw new ControlError("connector_trust", "Binding requires verified device evidence",403);
    if (!binding) throw new ControlError("connector_scope", "Identity or destination is not authorized", 403);
    if (binding.kind === "matrix" && (!principal.trust.encrypted || !principal.trust.allowedMembership || !principal.trust.verifiedDevice || !principal.trust.deviceId)) throw new ControlError("connector_trust", "Verified encrypted device and room membership evidence required", 403);
    return binding;
  }
  execute(principal: HumanPrincipal, input: unknown) {
    const command = humanCommandSchema.parse(input), binding = this.binding(principal);
    if(command.transportTimestamp){
      if(binding.kind !== "telegram")throw new ControlError("timestamp","Only Telegram callbacks lack a transport timestamp",403);
      const key=`human-received:${binding.connectorId}:${command.eventId}`,old=this.store.setting(key);
      if(old && (old.externalIdentity !== principal.externalIdentity || old.destination !== principal.destination))throw new ControlError("timestamp","Event already belongs to another identity",403);
      const received=old??{externalIdentity:principal.externalIdentity,destination:principal.destination,timestamp:this.store.clock()};
      if(!old)this.store.setting(key,received);
      command.timestamp=received.timestamp;
    }
    if (command.selectionToken && command.action !== "goal") throw new ControlError("selection", "Selection tokens can only submit goals", 403);
    if (command.selectionToken && command.confirmationEventId) throw new ControlError("selection", "A command cannot combine project selection and stale confirmation", 403);
    if (!binding.permissions.includes(command.action)) throw new ControlError("connector_permission", "Command permission is not granted", 403);
    if (command.timestamp > this.store.clock() + 300000) throw new ControlError("command_time", "Command timestamp is in the future");
    return this.store.idempotent(`human:${binding.connectorId}:${command.eventId}`, { principal, command }, () => {
      const mutable = !["projects", "status", "decisions", "answer"].includes(command.action);
      const actor = `human:${binding.operatorId}:${binding.connectorId}`;
      if (mutable && this.store.clock() - command.timestamp > 86400000) {
        this.store.setting(`human-stale:${binding.connectorId}:${command.eventId}`, { principal, command });
        const result = { confirmationRequired: true, eventId: command.eventId, message: "Send a fresh explicit confirmation of this event before applying it" };
        this.receipt(binding, command.eventId, result); return result;
      }
      let effective = command;
      if (command.confirmationEventId) {
        const old = this.store.setting(`human-stale:${binding.connectorId}:${command.confirmationEventId}`);
        if (!old || JSON.stringify(old.principal) !== JSON.stringify(principal) || old.command.action !== command.action) throw new ControlError("confirmation", "No matching stale command for this identity and destination");
        if (old.confirmedBy) throw new ControlError("confirmation", "Stale command already confirmed",409);
        effective = { ...old.command, timestamp: command.timestamp, eventId: command.eventId };
        this.store.setting(`human-stale:${binding.connectorId}:${command.confirmationEventId}`,{...old,confirmedBy:command.eventId});
      }
      if (command.selectionToken) {
        const draft = this.store.setting(`human-selection:${command.selectionToken}`);
        if (!draft || JSON.stringify(draft.principal) !== JSON.stringify(principal)) throw new ControlError("selection", "Project selection belongs to another identity or destination", 403);
        const original = this.store.setting(`human-draft:${binding.connectorId}:${draft.eventId}`);
        if (!original || original.selectedBy || this.store.clock() - original.command.timestamp > 86400000) throw new ControlError("selection", "Project selection is expired or already used; submit a new goal", 409);
        effective = {...original.command, projectId:draft.projectId, eventId:command.eventId, timestamp:command.timestamp};
        this.store.setting(`human-draft:${binding.connectorId}:${draft.eventId}`, {...original, selectedBy:command.eventId});
      }
      const scopedGoal = (goalId?: string) => {
        if (!goalId) throw new ControlError("goal_required", "Goal ID is required");
        const goal = this.store.getGoal(goalId);
        const route = this.store.setting(`human-route:${goalId}`);
        if (!goal.config.projectId || !binding.projectIds.includes(goal.config.projectId) || !route?.some((r: {connectorId: string; destination: string}) => r.connectorId === binding.connectorId && r.destination === binding.destination)) throw new ControlError("connector_scope", "Goal is outside this destination's authorized scope", 403);
        return goal;
      };
      let result: unknown;
      switch (effective.action) {
        case "projects": result = this.store.projects().filter(p => binding.projectIds.includes(p.id)).map(p => ({id:p.id,name:p.name,enabled:p.enabled})); break;
        case "status": result = this.store.goals(500).filter(g => { try { scopedGoal(g.id); return !effective.projectId || g.config.projectId === effective.projectId; } catch { return false; } }).map(g => ({id:g.id,title:g.config.title,status:g.status,result:g.result,budget:this.store.subscriptionCapacity(g.id) ?? this.store.canSpend(g.id),tasks:this.store.tasks(g.id).map(t=>({id:t.id,status:t.status}))})); break;
        case "goal": {
          if (!effective.projectId && effective.description) {
            const projects = this.store.projects().filter(p => p.enabled && binding.projectIds.includes(p.id)).map(p => {
              const selectionToken = randomUUID().replaceAll("-", "");
              this.store.setting(`human-selection:${selectionToken}`, {principal, eventId:command.eventId, projectId:p.id});
              return {id:p.id,name:p.name,selectionToken};
            });
            if (!projects.length) throw new ControlError("project_scope", "No enabled projects are authorized for this identity", 403);
            this.store.setting(`human-draft:${binding.connectorId}:${command.eventId}`,{principal,command});
            result = {selectionRequired:true, description:effective.description, projects}; break;
          }
          if (!effective.projectId || !effective.description || !binding.projectIds.includes(effective.projectId)) throw new ControlError("project_scope", "An authorized project and goal description are required",403);
          const goal = this.store.createGoal(this.admit(effective.projectId,effective.description),actor);
          this.store.setting(`human-route:${goal.id}`,[{connectorId:binding.connectorId,destination:binding.destination}]);
          result={goalId:goal.id,status:goal.status}; break;
        }
        case "pause": case "resume": case "cancel": {
          const goal=scopedGoal(effective.goalId);
          const updated=this.store.setGoalState(goal.id,{pause:"paused",resume:"running",cancel:"cancelled"}[effective.action] as "paused"|"running"|"cancelled",goal.revision,actor);
          result={goalId:goal.id,status:updated.status}; break;
        }
        case "decisions": result=this.store.questions().filter(q=>{try{scopedGoal(q.goalId);return !effective.projectId || this.store.getGoal(q.goalId).config.projectId === effective.projectId}catch{return false}}); break;
        case "answer": {
          if (!effective.questionId || !effective.revision || !effective.option) throw new ControlError("answer_required","Question ID, pending revision and option ID are required");
          const question=this.store.question(effective.questionId); scopedGoal(question.goalId);
          if (question.request.category === "spending" && effective.option === "approve") throw new ControlError("authority","Connector answers cannot increase installation spending");
          result=this.store.answer(question.id,effective.option,effective.revision,actor);break;
        }
        case "context": {const goal=scopedGoal(effective.goalId);if(!effective.context)throw new ControlError("context_required","Context text is required");this.store.decision(goal.id,undefined,"context",{note:effective.context},actor);result={goalId:goal.id,contextSaved:true};break;}
      }
      if(Buffer.byteLength(JSON.stringify(result))>48000)result={truncated:true,message:"Result exceeds connector message limit; inspect this instance's authenticated dashboard"};
      this.receipt(binding,command.eventId,result); return result;
    });
  }
  private receipt(binding: HumanBinding, eventId: string, result: unknown) { this.store.outbox("command_receipt",{eventId,result,destinations:[{connectorId:binding.connectorId,destination:binding.destination}]}); }
}

/** One destination owns each delivery. No connector consumes a shared row. */
export function enqueueDeliveries(store: ControlStore, notificationId: string, kind: string, payload: unknown) {
  const value=payload as {goalId?:string;destinations?:{connectorId:string;destination:string}[]};
  const destinations=value.destinations ?? (value.goalId ? store.setting(`human-route:${value.goalId}`) ?? [] : store.setting("human-system-routes") ?? []);
  for(const destination of destinations) {
    const deliveryId=`delivery_${randomUUID().replaceAll("-","")}`;
    store.db.exec(`INSERT OR IGNORE INTO connector_deliveries(id,notification_id,connector_id,destination,transaction_id,status,attempts,due_at,receipt,last_error) VALUES(${sql(deliveryId)},${sql(notificationId)},${sql(destination.connectorId)},${sql(destination.destination)},${sql(deliveryId)},'pending',0,${store.clock()},NULL,NULL)`);
  }
}
export function pendingDeliveries(store:ControlStore,connectorId:string):ConnectorDelivery[]{
  return store.db.query(`SELECT d.*,n.kind,n.payload FROM connector_deliveries d JOIN control_outbox n ON n.id=d.notification_id WHERE d.connector_id=${sql(connectorId)} AND d.status='pending' AND d.due_at<=${store.clock()} ORDER BY n.created_at,d.id LIMIT 50`).map(r=>({id:String(r.id),notificationId:String(r.notification_id),connectorId:String(r.connector_id),destination:String(r.destination),transactionId:String(r.transaction_id),kind:String(r.kind),payload:deliveryPayload(store,String(r.kind),JSON.parse(String(r.payload))),attempts:Number(r.attempts)}));
}
export function settleDelivery(store:ControlStore,connectorId:string,deliveryId:string,receipt:string){
  store.db.exec(`UPDATE connector_deliveries SET status='sent',receipt=${sql(receipt)},last_error=NULL WHERE id=${sql(deliveryId)} AND connector_id=${sql(connectorId)} AND status='pending'`);
}
export function retryDelivery(store:ControlStore,connectorId:string,deliveryId:string){
  store.db.exec(`UPDATE connector_deliveries SET attempts=attempts+1,due_at=${store.clock()+30000},last_error='delivery_failed' WHERE id=${sql(deliveryId)} AND connector_id=${sql(connectorId)} AND status='pending'`);
}

function deliveryPayload(store: ControlStore, kind: string, raw: Record<string, unknown>) {
  const {destinations, ...payload} = raw;
  if(kind === "question" && typeof payload.questionId === "string") {
    const question = store.question(payload.questionId);
    return {...payload, revision:question.revision, request:question.request, scope:{goalId:question.goalId,taskId:question.taskId}, status:question.status};
  }
  return payload;
}
