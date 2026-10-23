import { dirname, join } from "node:path";
import { OperationalLog } from "./operationalLog.js";
import { randomUUID } from "node:crypto";
import { sql } from "../sqlite.js";
import type { ControlStore } from "./store.js";
import type { AgentBackend, RunContext, BackendResult } from "./backend.js";
import { classifyFailure } from "./reliability.js";
import { executionUsage } from "./usage.js";

export interface Invocation {
  kind?: "agent" | "command";
  launchProtocol?: "framed-v1";
  id: string;
  goalId: string;
  taskId?: string;
  attemptId: string;
  generation: number;
  phase: string;
  environment: string;
  agent: string;
  model?: string;
  profile?: string;
  startedAt: number;
  endedAt?: number;
  firstActivityAt?: number;
  lastProgressAt?: number;
  outcome: string;
  sessionId?: string;
  candidate?: string;
  baseCommit?: string;
  workspace: string;
  turns: number;
  toolEvents: number;
  retryEvents: number;
  usage?: BackendResult["usage"];
  cachedInputTokens?: number;
  configurationVersion?: string;
  agentVersion?: string;
  failure?: string;
  process?: ProcessIdentity;
}
export interface ProcessIdentity {
  pid: number;
  pgid: number;
  startTime: string;
  bootId: string;
  executionId?: string;
}
export class InvocationStore {
  constructor(readonly store: ControlStore) {}
  save(record: Invocation) {
    const previous = this.store.db.one<{ record: string }>(
      `SELECT record FROM agent_invocations WHERE id=${sql(record.id)}`,
    );
    this.store.db.exec(
      `INSERT INTO agent_invocations VALUES(${sql(record.id)},${sql(record.goalId)},${sql(record.taskId)},${sql(record.attemptId)},${sql(this.store.redactor.json(record))}) ON CONFLICT(id) DO UPDATE SET record=excluded.record`,
    );
    if (!previous || JSON.parse(previous.record).outcome !== record.outcome) {
      const root = dirname(this.store.db.path);
      if (typeof root === "string")
        new OperationalLog(
          join(root, "logs", "operations.jsonl"),
          this.store.redactor,
        ).write("execution_invocation", {
          goalId: record.goalId,
          taskId: record.taskId,
          attemptId: record.attemptId,
          generation: record.generation,
          phase: record.phase,
          status: record.outcome,
          sessionId: record.sessionId,
          durationMs:
            record.endedAt === undefined
              ? undefined
              : record.endedAt - record.startedAt,
        });
    }
  }
  all(goalId?: string): Invocation[] {
    return this.store.db
      .query<{ record: string }>(
        `SELECT record FROM agent_invocations ${goalId ? `WHERE goal_id=${sql(goalId)}` : ""} ORDER BY rowid`,
      )
      .map((row) => JSON.parse(row.record));
  }
  bindCandidate(taskId: string, generation: number, candidate: string) {
    for (const record of this.all().filter(
      (r) =>
        r.taskId === taskId &&
        r.generation === generation &&
        r.phase === "implement" &&
        r.kind !== "command",
    )) {
      record.candidate = candidate;
      this.save(record);
    }
  }
  experiment(goalId: string) {
    const goal = this.store.getGoal(goalId),
      records = this.all(goalId);
    const phases = Object.fromEntries(
      [...new Set(records.map((r) => r.phase))].map((phase) => {
        const rows = records.filter((r) => r.phase === phase),
          durations = rows
            .filter((r) => r.endedAt !== undefined)
            .map((r) => r.endedAt! - r.startedAt);
        return [
          phase,
          {
            sampleSize: rows.length,
            completedMeasurements: durations.length,
            elapsedMs: durations.reduce((a, b) => a + b, 0),
            minimumMs: durations.length ? Math.min(...durations) : null,
            maximumMs: durations.length ? Math.max(...durations) : null,
            source: "controller wall clock",
          },
        ];
      }),
    );
    return {
      version: 1,
      goalId,
      status: goal.status,
      configurationHash: goal.config.admission?.configurationHash ?? null,
      metrics: this.metrics(goalId),
      phases,
      candidates: [...new Set(records.map((r) => r.candidate).filter(Boolean))],
      runs: records.map((r) => ({
        id: r.id,
        kind: r.kind ?? "agent",
        attemptId: r.attemptId,
        phase: r.phase,
        environment: r.environment,
        agent: r.agent,
        model: r.model ?? null,
        agentVersion: r.agentVersion ?? null,
        baseCommit: r.baseCommit ?? null,
        sessionId: r.sessionId ?? null,
        candidate: r.candidate ?? null,
        startedAt: r.startedAt,
        endedAt: r.endedAt ?? null,
        outcome: r.outcome,
        failure: r.failure ?? null,
        usage: r.usage ?? null,
      })),
      comparison:
        "No direct-run equivalence or model request counts are inferred",
    };
  }
  metrics(goalId: string) {
    const all = this.all(goalId);
    const records = all.filter((r) => r.kind !== "command");
    const measured = records.filter(
      (r) =>
        (r.usage?.kind === "subscription" || r.usage?.kind === "metered") &&
        r.usage.status === "reported",
    );
    const tokens = (key: "inputTokens" | "outputTokens") => ({
      value: measured.some((r) => r.usage && key in r.usage)
        ? measured.reduce((n, r) => n + Number((r.usage as any)?.[key] ?? 0), 0)
        : null,
      measuredInvocations: measured.filter(
        (r) => (r.usage as any)?.[key] !== undefined,
      ).length,
      source: "adapter-reported-per-invocation",
      completeness:
        measured.filter((r) => (r.usage as any)?.[key] !== undefined).length ===
          records.length && records.length > 0
          ? "complete"
          : "partial",
    });
    return {
      goalId,
      commandExecutions: all.filter((r) => r.kind === "command").length,
      invocations: records.length,
      invocationCountMeaning:
        "Adapter invocation records, including intent before launch",
      nativeProcessesWithIdentity: records.filter(
        (r) => r.environment === "native" && r.process,
      ).length,
      nativeProcessCountSource:
        "Persisted launcher process identity; model requests remain unavailable",
      attempts: new Set(records.map((r) => r.attemptId)).size,
      turns: records.some((r) => r.environment === "native")
        ? records
            .filter((r) => r.environment === "native")
            .reduce((n, r) => n + r.turns, 0)
        : null,
      turnsSource: "native-jsonl; unavailable for legacy adapters",
      modelRequests: { value: null, source: "not exposed by native CLI" },
      inputTokens: tokens("inputTokens"),
      outputTokens: tokens("outputTokens"),
      cachedInputTokens: {
        value: measured.some((r) => r.cachedInputTokens !== undefined)
          ? measured.reduce((n, r) => n + (r.cachedInputTokens ?? 0), 0)
          : null,
        measuredInvocations: measured.filter(
          (r) => r.cachedInputTokens !== undefined,
        ).length,
        completeness:
          measured.filter((r) => r.cachedInputTokens !== undefined).length ===
            records.length && records.length > 0
            ? "complete"
            : "partial",
        source:
          "agent-reported cached subset of input; never added to input total",
      },
      retryEvents: records.some((r) => r.environment === "native")
        ? records
            .filter((r) => r.environment === "native")
            .reduce((n, r) => n + r.retryEvents, 0)
        : null,
      retrySource: "exposed events only; hidden retries unavailable",
      elapsedMs: records.reduce(
        (n, r) => n + ((r.endedAt ?? this.store.clock()) - r.startedAt),
        0,
      ),
      outcomes: records.reduce(
        (n, r) => ({ ...n, [r.outcome]: (n[r.outcome] ?? 0) + 1 }),
        {} as Record<string, number>,
      ),
      ownerInterventions:
        this.store.db.one<{ n: number }>(
          `SELECT COUNT(*) n FROM control_events WHERE goal_id=${sql(goalId)} AND type='OWNER_OPERATION_REQUIRED'`,
        )?.n ?? 0,
      meteredDollarCost: {
        value: measured.some((r) => r.usage?.kind === "metered")
          ? measured.reduce(
              (n, r) =>
                n + (r.usage?.kind === "metered" ? (r.usage.costUsd ?? 0) : 0),
              0,
            )
          : null,
        source:
          "reported metered usage only; subscription usage has no dollar conversion",
      },
      dollarCost: null,
      dollarCostMeaning:
        "Subscription usage does not establish a dollar charge",
    };
  }
}
/** One observation boundary for synthetic, native and container agent runs. */
export function observedBackend(
  store: ControlStore,
  backend: AgentBackend,
): AgentBackend {
  return {
    async run(context: RunContext) {
      const ledger = new InvocationStore(store),
        config = context.claim.goal.config;
      const attemptId =
        context.operationReservationId ??
        `${context.claim.task.id}:${context.claim.generation}`;
      const record: Invocation = {
        id: `inv_${randomUUID()}`,
        goalId: context.claim.goal.id,
        taskId:
          context.claim.generation > 0 ? context.claim.task.id : undefined,
        attemptId,
        generation: context.claim.generation,
        launchProtocol:
          config.executionContract?.execution === "native"
            ? "framed-v1"
            : undefined,
        phase: context.mode,
        workspace: context.workspace,
        environment: config.executionContract?.execution ?? "fake",
        agent: config.backend.kind,
        model: config.backend.model,
        profile: config.admission?.nativeProfile?.profile,
        startedAt: store.clock(),
        outcome: "active",
        turns: 0,
        toolEvents: 0,
        retryEvents: 0,
      };
      ledger.save(record);
      const observe = (patch: Partial<Invocation>) => {
        Object.assign(record, patch);
        ledger.save(record);
      };
      try {
        const result = await backend.run({
          ...context,
          invocationId: record.id,
          observe,
          onProgress: (kind) => {
            const now = store.clock();
            observe({
              firstActivityAt: record.firstActivityAt ?? now,
              lastProgressAt: now,
            });
            context.onProgress?.(kind);
          },
        });
        observe({
          sessionId: result.sessionId,
          usage: executionUsage(result, config),
          outcome: "completed",
          endedAt: store.clock(),
        });
        return result;
      } catch (error) {
        observe({
          outcome:
            classifyFailure(error).kind === "cleanup_blocked"
              ? "cleanup_blocked"
              : context.signal.aborted
                ? "interrupted"
                : "failed",
          endedAt: store.clock(),
          failure:
            (error as any)?.failure?.kind ??
            (error as any)?.code ??
            "execution_failed",
          usage:
            (error as any)?.usage ??
            (config.executionContract?.execution === "native"
              ? { kind: "subscription", status: "unknown" }
              : undefined),
        });
        throw error;
      }
    },
  };
}
