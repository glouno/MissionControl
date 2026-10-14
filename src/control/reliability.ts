import { OperationalLog } from "./operationalLog.js";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SqliteStore, sql } from "../sqlite.js";
import { z } from "zod";
import { Redactor } from "../privacy.js";

export type FailureKind =
  | "policy_refusal"
  | "authentication"
  | "quota"
  | "invalid_request"
  | "deployment_missing"
  | "rate_limit"
  | "service"
  | "transport"
  | "deadline"
  | "interrupted"
  | "incomplete_stream"
  | "cleanup_blocked"
  | "unknown";
export interface FailureRecord {
  version: 1;
  kind: FailureKind;
  message: string;
  retryable: boolean;
  providerCode?: string;
  httpStatus?: number;
  requestIds?: Record<string, string>;
  diagnosticId?: string;
  retryAfterMs?: number;
  fingerprint: string;
}
export const failureSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum([
      "policy_refusal",
      "authentication",
      "quota",
      "invalid_request",
      "deployment_missing",
      "rate_limit",
      "service",
      "transport",
      "deadline",
      "interrupted",
      "incomplete_stream",
      "cleanup_blocked",
      "unknown",
    ]),
    message: z.string().max(2048),
    retryable: z.boolean(),
    providerCode: z.string().max(128).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    requestIds: z.record(z.string(), z.string().max(256)).optional(),
    diagnosticId: z.string().max(200).optional(),
    retryAfterMs: z.number().nonnegative().max(300000).optional(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const timestampSchema = z.number().finite().nonnegative();
export const attemptRuntimeSchema = z.object({
  version: z.literal(1),
  attemptId: z.string(),
  phase: z.string(),
  phaseStartedAt: timestampSchema,
  deadlineAt: timestampSchema,
  lastHeartbeatAt: timestampSchema,
  lastProgressAt: timestampSchema,
  progressKind: z.string(),
  cleanupState: z.enum(["none", "stopping", "stopped", "blocked"]),
  cleanupStartedAt: timestampSchema.optional(),
  cleanupDeadlineAt: timestampSchema.optional(),
  retryCount: z.number().int().nonnegative(),
  nextRetryAt: timestampSchema.optional(),
  failure: failureSchema.optional(),
});
export const inferenceDiagnosticSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  attemptId: z.string().optional(),
  goalId: z.string().optional(),
  taskId: z.string().optional(),
  generation: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
  provider: z.string(),
  endpoint: z.string(),
  model: z.string(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  durationMs: timestampSchema.optional(),
  phase: z.string(),
  status: z.enum(["active", "completed", "failed", "interrupted"]),
  failure: failureSchema.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  requestIds: failureSchema.shape.requestIds,
  usageStatus: z.enum(["reported", "unknown"]).optional(),
});
export const incidentSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  goalId: z.string(),
  attemptId: z.string().optional(),
  failure: failureSchema,
  recordedAt: timestampSchema,
  status: z.enum(["open", "resolved"]),
  nextAction: z.string(),
});
export const pauseRecordSchema = z.object({
  version: z.literal(1),
  actor: z.string(),
  reason: z.string(),
  category: z.string(),
  incidentId: z.string().optional(),
  recordedAt: timestampSchema,
  nextAction: z.string(),
});
export const recoveryDecisionSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  attemptId: z.string(),
  actor: z.string(),
  recordedAt: timestampSchema,
  action: z.string(),
  explanation: z.string().max(4096),
});
export class ProviderFailure extends Error {
  constructor(readonly failure: FailureRecord) {
    super(failure.message);
    this.name = "ProviderFailure";
  }
}
export interface AttemptRuntime {
  version: 1;
  attemptId: string;
  phase: string;
  phaseStartedAt: number;
  deadlineAt: number;
  lastHeartbeatAt: number;
  lastProgressAt: number;
  progressKind: string;
  cleanupState: "none" | "stopping" | "stopped" | "blocked";
  cleanupStartedAt?: number;
  cleanupDeadlineAt?: number;
  retryCount: number;
  nextRetryAt?: number;
  failure?: FailureRecord;
}
export interface InferenceDiagnostic {
  version: 1;
  id: string;
  attemptId?: string;
  goalId?: string;
  taskId?: string;
  generation?: number;
  sessionId?: string;
  provider: string;
  endpoint: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  phase: string;
  status: "active" | "completed" | "failed" | "interrupted";
  failure?: FailureRecord;
  httpStatus?: number;
  requestIds?: Record<string, string>;
  usageStatus?: "reported" | "unknown";
}
export interface PauseRecord {
  version: 1;
  actor: string;
  reason: string;
  category: string;
  incidentId?: string;
  recordedAt: number;
  nextAction: string;
}
export interface Incident {
  version: 1;
  id: string;
  goalId: string;
  attemptId?: string;
  failure: FailureRecord;
  recordedAt: number;
  status: "open" | "resolved";
  nextAction: string;
}
export interface RecoveryDecision {
  version: 1;
  id: string;
  attemptId: string;
  actor: string;
  recordedAt: number;
  action: string;
  explanation: string;
}
const fallback: Record<FailureKind, string> = {
  policy_refusal:
    "Provider policy refused this request; inspect the serving provider policy and obtain authorized access or revise the task before resuming.",
  authentication:
    "Provider authentication failed; repair the configured credential before resuming.",
  quota:
    "Provider quota is exhausted; inspect quota and billing before resuming.",
  invalid_request:
    "Provider rejected the request; repair the request configuration before resuming.",
  deployment_missing:
    "Provider deployment or model was not found; verify the exact serving endpoint and deployment before resuming.",
  rate_limit:
    "Provider rate limit reached; a bounded retry may proceed after backoff.",
  service: "Provider service is temporarily unavailable.",
  transport:
    "Provider transport failed; inspect uncertain effects before retrying.",
  deadline:
    "Execution deadline expired; reconcile owned resources and uncertain effects before retrying.",
  interrupted:
    "Execution was interrupted; inspect retained work and uncertain effects.",
  incomplete_stream:
    "Provider stream ended without a complete result; usage remains uncertain.",
  cleanup_blocked:
    "Owned resources could not be confirmed stopped; replacement admission remains blocked.",
  unknown: "Execution failed; inspect diagnostic evidence before retrying.",
};
export function safeDiagnosticText(value: string, redactor = new Redactor()) {
  return redactor
    .text(value)
    .replace(/(?:Bearer\s+)[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:sk-(?:proj-)?[\w-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g,
      "[REDACTED]",
    )
    .replace(
      /((?:api[-_]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 2048);
}
export function failureRecord(
  kind: FailureKind,
  details: Partial<FailureRecord> = {},
): FailureRecord {
  const message = safeDiagnosticText(details.message ?? fallback[kind]);
  const providerCode =
    details.providerCode &&
    /^[a-zA-Z0-9_.:-]{1,128}$/.test(details.providerCode)
      ? safeDiagnosticText(details.providerCode)
      : undefined;
  return {
    version: 1,
    kind,
    providerCode,
    httpStatus: details.httpStatus,
    diagnosticId: details.diagnosticId,
    retryAfterMs: details.retryAfterMs,
    requestIds: details.requestIds
      ? requestIds(new Headers(details.requestIds))
      : undefined,
    retryable: ["rate_limit", "service", "transport", "unknown"].includes(kind),
    message,
    fingerprint: createHash("sha256")
      .update(JSON.stringify([kind, providerCode, details.httpStatus, message]))
      .digest("hex"),
  };
}
export function classifyFailure(
  input: unknown,
  status?: number,
  diagnosticId?: string,
): FailureRecord {
  if (input instanceof ProviderFailure) return input.failure;
  const raw = input as any;
  const error = raw?.error ?? raw?.response?.error ?? raw;
  const code =
    typeof error?.innererror?.code === "string"
      ? error.innererror.code
      : typeof error?.inner_error?.code === "string"
        ? error.inner_error.code
        : typeof error?.code === "string"
          ? error.code
          : typeof error?.type === "string"
            ? error.type
            : typeof raw?.code === "string"
              ? raw.code
              : "";
  const message =
    typeof error?.message === "string"
      ? error.message
      : input instanceof Error
        ? input.message
        : "";
  const text = `${code} ${message}`;
  let kind: FailureKind = "unknown";
  if (
    /content.?filter|policy.?violation|cyber.*(policy|safety|reject)|safety.*reject|refusal|ResponsibleAIPolicyViolation/i.test(
      text,
    )
  )
    kind = "policy_refusal";
  else if (
    /insufficient.?quota|quota.?exhaust|billing.?limit|credits?.?(exhaust|insufficient)/i.test(
      text,
    )
  )
    kind = "quota";
  else if (
    status === 401 ||
    /invalid.?api.?key|authentication|unauthorized|AccessDenied|UnrecognizedClient|ExpiredToken/i.test(
      text,
    )
  )
    kind = "authentication";
  else if (status === 404 || /DeploymentNotFound|model.?not.?found/i.test(text))
    kind = "deployment_missing";
  else if (status === 429 || /throttl|rate.?limit/i.test(text))
    kind = "rate_limit";
  else if (
    status === 400 ||
    status === 422 ||
    /invalid.?request|validation.?exception/i.test(text)
  )
    kind = "invalid_request";
  else if (status === 403) kind = "authentication";
  else if (status && status >= 500) kind = "service";
  else if (/timeout|deadline|TimeoutError/i.test(text + raw?.name))
    kind = "deadline";
  else if (/abort|shutdown|interrupt|cancel/i.test(text + raw?.name))
    kind = "interrupted";
  else if (
    code === "protocol" ||
    /incomplete|without.*complet|truncat|duplicate.*complet/i.test(text)
  )
    kind = "incomplete_stream";
  else if (/ECONN|ENOTFOUND|socket|fetch failed|network|transport/i.test(text))
    kind = "transport";
  // Provider prose can contain prompt excerpts. Store generic advice and allowlisted codes, not arbitrary provider messages.
  return failureRecord(kind, {
    httpStatus: status,
    providerCode: /^[a-zA-Z0-9_.:-]{1,128}$/.test(code) ? code : undefined,
    diagnosticId,
  });
}
export function requestIds(headers: Headers) {
  return Object.fromEntries(
    [
      "x-request-id",
      "request-id",
      "apim-request-id",
      "x-ms-request-id",
      "x-ms-correlation-request-id",
      "x-amzn-requestid",
    ].flatMap((k) => {
      const v = headers.get(k);
      return v && /^[a-zA-Z0-9_.:/-]{1,256}$/.test(v) ? [[k, v]] : [];
    }),
  );
}
export function sanitizedEndpoint(endpoint: string) {
  try {
    const u = new URL(endpoint);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "invalid-endpoint";
  }
}
export async function boundedErrorBody(
  response: Response,
  signal: AbortSignal,
) {
  if (!response.body) return {};
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const v = await abortable(reader.read(), signal);
      if (v.done) break;
      size += v.value.length;
      if (size > 65536) break;
      chunks.push(v.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return {};
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new Error("Execution interrupted"));
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new Error("Execution interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export function deadlineSignal(deadlineAt: number, parent?: AbortSignal) {
  const signal = AbortSignal.timeout(
    Math.max(1, Math.min(2147483647, deadlineAt - Date.now())),
  );
  return parent ? AbortSignal.any([signal, parent]) : signal;
}
export class ReliabilityStore {
  constructor(
    readonly db: SqliteStore,
    readonly clock = Date.now,
  ) {}
  migrate() {
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS attempt_runtime(attempt_id TEXT PRIMARY KEY REFERENCES control_attempts(id),record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inference_diagnostics(id TEXT PRIMARY KEY,attempt_id TEXT,goal_id TEXT,record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS inference_diagnostic_attempt ON inference_diagnostics(attempt_id,id);
CREATE TABLE IF NOT EXISTS reliability_incidents(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES control_goals(id),attempt_id TEXT,fingerprint TEXT NOT NULL,record TEXT NOT NULL,UNIQUE(goal_id,fingerprint));
CREATE TABLE IF NOT EXISTS recovery_decisions(id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS goal_lineage(goal_id TEXT PRIMARY KEY REFERENCES control_goals(id),parent_id TEXT NOT NULL REFERENCES control_goals(id),root_id TEXT NOT NULL REFERENCES control_goals(id),allowance REAL NOT NULL CHECK(allowance>=0));`);
  }
  runtime(attemptId: string): AttemptRuntime | undefined {
    const r = this.db.one<{ record: string }>(
      `SELECT record FROM attempt_runtime WHERE attempt_id=${sql(attemptId)}`,
    );
    return r ? JSON.parse(r.record) : undefined;
  }
  saveRuntime(r: AttemptRuntime) {
    this.db.exec(
      `INSERT INTO attempt_runtime VALUES(${sql(r.attemptId)},${sql(this.db.redactor.json(r))}) ON CONFLICT(attempt_id) DO UPDATE SET record=excluded.record`,
    );
    return r;
  }
  /** Cleanup belongs to the admitted attempt; restart cannot replenish its allowance. */
  beginCleanup(attemptId: string) {
    const runtime = this.runtime(attemptId);
    if (!runtime) throw new Error("Cleanup requires an admitted attempt");
    runtime.cleanupStartedAt ??= this.clock();
    runtime.cleanupDeadlineAt ??= runtime.cleanupStartedAt + 60000;
    if (runtime.cleanupState === "none") runtime.cleanupState = "stopping";
    return this.saveRuntime(runtime);
  }
  cleanupSignal(attemptId: string) {
    const runtime = this.beginCleanup(attemptId);
    const remaining = runtime.cleanupDeadlineAt! - this.clock();
    return remaining > 0
      ? AbortSignal.timeout(remaining)
      : AbortSignal.abort(
          new ProviderFailure(failureRecord("cleanup_blocked")),
        );
  }
  start(attemptId: string, timeoutMs: number, phase: string) {
    const now = this.clock();
    return this.saveRuntime({
      version: 1,
      attemptId,
      phase,
      phaseStartedAt: now,
      deadlineAt: now + timeoutMs,
      lastHeartbeatAt: now,
      lastProgressAt: now,
      progressKind: "admitted",
      cleanupState: "none",
      retryCount: 0,
    });
  }
  progress(attemptId: string, kind: string, heartbeat = false) {
    const r = this.runtime(attemptId);
    if (!r) return;
    if (
      this.db.one(
        "SELECT name FROM sqlite_master WHERE name='control_attempts'",
      )
    ) {
      const attempt = this.db.one<{ outcome: string }>(
        `SELECT outcome FROM control_attempts WHERE id=${sql(attemptId)}`,
      );
      if (!attempt || attempt.outcome !== "active") return;
    }
    const now = this.clock();
    if (heartbeat) r.lastHeartbeatAt = now;
    else {
      r.lastProgressAt = now;
      r.progressKind = kind;
    }
    this.saveRuntime(r);
  }
  diagnostic(d: InferenceDiagnostic) {
    d = {
      ...d,
      endpoint: sanitizedEndpoint(d.endpoint),
      model: safeDiagnosticText(d.model, this.db.redactor),
      provider: safeDiagnosticText(d.provider, this.db.redactor),
      requestIds: d.requestIds
        ? Object.fromEntries(
            Object.entries(d.requestIds).filter(
              ([k, v]) =>
                /^[a-zA-Z0-9-]{1,64}$/.test(k) &&
                /^[a-zA-Z0-9_.:/-]{1,256}$/.test(v),
            ),
          )
        : undefined,
    };
    this.db.exec(
      `INSERT INTO inference_diagnostics VALUES(${sql(d.id)},${sql(d.attemptId)},${sql(d.goalId)},${sql(this.db.redactor.json(d))}) ON CONFLICT(id) DO UPDATE SET record=excluded.record`,
    );
    try {
      new OperationalLog(
        join(dirname(this.db.path), "logs", "operations.jsonl"),
        this.db.redactor,
      ).write(d.endedAt ? "inference_end" : "inference_start", {
        goalId: d.goalId,
        attemptId: d.attemptId,
        diagnosticId: d.id,
        sessionId: d.sessionId,
        generation: d.generation,
        phase: d.phase,
        status: d.status,
        httpStatus: d.httpStatus,
        durationMs: d.durationMs,
        kind: d.failure?.kind,
      });
    } catch {
      /* Durable database evidence remains authoritative. */
    }
  }
  latestFailure(
    goalId: string,
    attemptId: string,
    sessionId?: string,
  ): InferenceDiagnostic | undefined {
    const row = this.db.one<{ record: string }>(
      `SELECT record FROM inference_diagnostics WHERE goal_id=${sql(goalId)} AND attempt_id=${sql(attemptId)} AND json_extract(record,'$.failure') IS NOT NULL ${sessionId ? `AND json_extract(record,'$.sessionId')=${sql(sessionId)}` : ""} ORDER BY id DESC LIMIT 1`,
    );
    return row ? JSON.parse(row.record) : undefined;
  }
  page(
    table: "inference_diagnostics" | "reliability_incidents",
    goalId?: string,
    attemptId?: string,
    limit = 100,
    after = "",
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw Error("Invalid diagnostic page limit");
    return this.db
      .query<{ record: string }>(
        `SELECT record FROM ${table} WHERE id>${sql(after)} ${goalId ? `AND goal_id=${sql(goalId)}` : ""} ${attemptId ? `AND attempt_id=${sql(attemptId)}` : ""} ORDER BY id LIMIT ${limit}`,
      )
      .map((r) => JSON.parse(r.record));
  }
  incident(
    goalId: string,
    failure: FailureRecord,
    attemptId?: string,
  ): Incident {
    const fp = createHash("sha256")
      .update(JSON.stringify([failure.fingerprint, attemptId]))
      .digest("hex");
    const prior = this.db.one<{ record: string }>(
      `SELECT record FROM reliability_incidents WHERE goal_id=${sql(goalId)} AND fingerprint=${sql(fp)}`,
    );
    if (prior) return JSON.parse(prior.record);
    const record: Incident = {
      version: 1,
      id: `incident_${String(this.clock()).padStart(13, "0")}_${randomUUID()}`,
      goalId,
      attemptId,
      failure,
      recordedAt: this.clock(),
      status: "open",
      nextAction: failure.message,
    };
    this.db.exec(
      `INSERT INTO reliability_incidents VALUES(${sql(record.id)},${sql(goalId)},${sql(attemptId)},${sql(fp)},${sql(this.db.redactor.json(record))})`,
    );
    return record;
  }
}

export async function boundedCleanup(
  operation: (signal: AbortSignal) => Promise<void>,
  timeoutMs = 60000,
  sharedSignal?: AbortSignal,
) {
  const signal = sharedSignal ?? AbortSignal.timeout(timeoutMs);
  try {
    signal.throwIfAborted();
    await abortable(operation(signal), signal);
  } catch (error) {
    throw new ProviderFailure(failureRecord("cleanup_blocked"));
  }
}

/** Only explicit rejected HTTP outcomes are eligible. Transport/stream failures are never replayed. */
export async function retryProvider<T>(
  run: () => Promise<T>,
  signal: AbortSignal,
  runtime: AttemptRuntime | undefined,
  save: (r: AttemptRuntime) => void,
  clock = Date.now,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  while (true) {
    signal.throwIfAborted();
    if (runtime?.nextRetryAt && runtime.nextRetryAt > clock())
      await abortable(sleep(runtime.nextRetryAt - clock()), signal);
    try {
      const result = await run();
      if (runtime) {
        runtime.nextRetryAt = undefined;
        runtime.failure = undefined;
        save(runtime);
      }
      return result;
    } catch (error) {
      if (
        !(error instanceof ProviderFailure) ||
        !["rate_limit", "service"].includes(error.failure.kind) ||
        !runtime ||
        runtime.retryCount >= 3 ||
        !error.failure.httpStatus
      )
        throw error;
      const delay = Math.min(
        300000,
        Math.max(
          error.failure.retryAfterMs ?? 0,
          10000 * 2 ** runtime.retryCount,
        ) + Math.floor(Math.random() * 1000),
      );
      if (clock() + delay >= runtime.deadlineAt) throw error;
      runtime.retryCount++;
      runtime.nextRetryAt = clock() + delay;
      runtime.failure = error.failure;
      save(runtime);
    }
  }
}
