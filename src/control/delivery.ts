import { createHash } from "node:crypto";
import { z } from "zod";
import { ControlError } from "./schema.js";
import { sql } from "../sqlite.js";
import type { ControlStore } from "./store.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const observationSchema = z
  .object({
    candidateSha: sha,
    taskId: z.string().optional(),
    summary: z.string().min(1).max(4000),
    evidence: z.string().min(1).max(12000),
    blocking: z.boolean().default(true),
  })
  .strict();

export function observations(store: ControlStore, goalId: string) {
  store.getGoal(goalId);
  return store.db
    .query<{ record: string; id: string; status: string }>(
      `SELECT id,record,status FROM control_findings WHERE goal_id=${sql(goalId)} ORDER BY rowid`,
    )
    .map((row) => ({
      id: row.id,
      status: row.status,
      ...JSON.parse(row.record),
    }))
    .filter((row) => row.kind === "operator_observation");
}
export function recordObservation(
  store: ControlStore,
  goalId: string,
  input: unknown,
  actor: string,
) {
  const value = observationSchema.parse(input);
  const goal = store.getGoal(goalId);
  if (["completed", "cancelled"].includes(goal.status))
    throw new ControlError(
      "terminal_observation",
      "Use a successor goal for terminal source",
      409,
    );
  if (value.taskId && store.getTask(value.taskId).goalId !== goalId)
    throw new ControlError("observation_scope", "Task is outside goal", 409);
  const id = store.finding(
    goalId,
    value.taskId,
    { kind: "operator_observation", ...value, actor },
    actor,
  );
  return { id };
}
export function assertObservationsClosed(store: ControlStore, goalId: string) {
  if (
    observations(store, goalId).some((o) => o.blocking && o.status !== "closed")
  )
    throw new ControlError(
      "blocking_observation",
      "Unresolved operator observations block source integration",
      409,
    );
}
// Closing a source observation requires verifier and independent reviewer evidence
// for the same new candidate; an operator assertion or worker narrative is insufficient.
export function closeObservation(
  store: ControlStore,
  goalId: string,
  observationId: string,
  candidateSha: string,
  actor: string,
) {
  sha.parse(candidateSha);
  const prior = observations(store, goalId).find((o) => o.id === observationId);
  if (!prior)
    throw new ControlError(
      "observation_scope",
      "Observation is outside goal",
      404,
    );
  const tasks = store.tasks(goalId);
  const evidence = store.db
    .query<{
      task_id: string;
      kind: string;
      passed: number;
      commit_sha: string;
      data: string;
      created_at: string;
      generation: number;
    }>(
      `SELECT * FROM control_evidence WHERE commit_sha=${sql(candidateSha)} AND passed=1`,
    )
    .filter((e) =>
      tasks.some(
        (t) =>
          t.id === e.task_id &&
          t.generation === e.generation &&
          (!prior.taskId || prior.taskId === t.id),
      ),
    );
  const reviewed = evidence.find(
    (e) =>
      e.kind === "review" &&
      (JSON.parse(e.data).observations ?? []).includes(observationId),
  );
  if (
    !reviewed ||
    !evidence.some(
      (e) =>
        e.kind === "tests" &&
        e.task_id === reviewed.task_id &&
        e.generation === reviewed.generation,
    )
  )
    throw new ControlError(
      "observation_evidence",
      "Same-source passing tests and independent review are required",
      409,
    );
  store.db.transaction(() => {
    store.db.exec(
      `UPDATE control_findings SET status='closed' WHERE id=${sql(observationId)}`,
    );
    store.event(
      "OBSERVATION_CLOSED",
      actor,
      { observationId, candidateSha },
      goalId,
    );
  });
  return { id: observationId, status: "closed", candidateSha };
}

export function deliveryIncident(
  store: ControlStore,
  goalId: string,
  candidateSha: string,
  targetSha: string,
  code: string,
  reason: string,
) {
  const key = `delivery-incident:${goalId}:${candidateSha}:${targetSha}`;
  const prior = store.setting(key) as any;
  const signature = createHash("sha256")
    .update(`${code}:${reason}`)
    .digest("hex");
  if (prior?.signature === signature) return prior;
  const record = {
    candidateSha,
    targetSha,
    code,
    reason,
    signature,
    owner: "operator",
    firstSeenAt: prior?.firstSeenAt ?? store.clock(),
    changedAt: store.clock(),
    status: "blocked",
  };
  store.setting(key, record);
  store.finding(
    goalId,
    undefined,
    { kind: "delivery_failure", ...record },
    "delivery-supervisor",
  );
  store.event("DELIVERY_BLOCKED", "delivery-supervisor", record, goalId);
  store.outbox("delivery_failure", { goalId, ...record });
  return record;
}
