import { createHash, randomUUID } from "node:crypto";
import { availableParallelism, totalmem } from "node:os";
import { projectIdentity, overlapEvidence } from "./projectContext.js";
import { relative, resolve, dirname, isAbsolute } from "node:path";
import { existsSync, realpathSync, lstatSync } from "node:fs";
import { SqliteStore, sql } from "../sqlite.js";
import { StatePaths } from "./statePaths.js";
import {
  validateBackendContract,
  validateExecutionLimits,
} from "./executionContract.js";
import {
  usageSchema,
  knownCost,
  executionUsage,
  usageReconciliationSchema,
  type Usage,
  type UsageReconciliation,
} from "./usage.js";
import { enqueueDeliveries } from "./human.js";
import {
  checkpointSchema,
  backendSchema,
  scheduleSchema,
  projectSchema,
  ControlError,
  goalSchema,
  questionSchema,
  ownerOperationSchema,
  validatePlan,
  type Claim,
  type Goal,
  type GoalInput,
  type Task,
  type TaskState,
  type QuestionInput,
} from "./schema.js";

const id = (kind: string) => `${kind}_${randomUUID().replaceAll("-", "")}`;
interface Row extends Record<string, unknown> {}
export interface Principal {
  actor: string;
  role: "operator" | "worker" | "connector" | "automation";
  workerId?: string;
}
export class ControlStore {
  get redactor() {
    return this.db.redactor;
  }
  private encode(value: unknown) {
    return sql(this.redactor.json(value));
  }

  constructor(
    readonly db: SqliteStore,
    readonly clock: () => number = Date.now,
  ) {
    this.migrate();
  }
  migrate() {
    const version = Number(
      this.db.one<{ user_version: number }>("PRAGMA user_version")
        ?.user_version ?? 0,
    );
    const tables = this.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    if (version > 6)
      throw new Error("Database schema is newer than this release");
    if (version === 0 && tables.length)
      throw new Error(
        "Pre-v1 state is unsupported; initialize fresh state and retain the legacy database privately",
      );
    if (version >= 1) {
      if (
        !this.db.one(
          "SELECT name FROM sqlite_master WHERE name='schema_migrations'",
        )
      )
        throw new Error("Missing v1 migration ledger");
      const ledger = this.db
        .query<{ version: number }>(
          "SELECT version FROM schema_migrations ORDER BY version",
        )
        .map((r) => Number(r.version));
      if (
        JSON.stringify(ledger) !==
        JSON.stringify(Array.from({ length: version }, (_, i) => i + 1))
      )
        throw new Error("Migration ledger differs from schema version");
      this.migrateDeliveries();
      this.migrateRegistries();
      this.migrateStatePaths();
      this.migrateAttempts();
      this.migrateUsageReconciliation();
      return;
    }
    this.db.transaction(() => {
      this.db.exec(`
 CREATE TABLE IF NOT EXISTS control_goals(id TEXT PRIMARY KEY,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,plan_revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,config TEXT NOT NULL,result TEXT);
 CREATE TABLE IF NOT EXISTS control_tasks(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES control_goals(id),key TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,worker_id TEXT,lease_until INTEGER,retry_at INTEGER,created_at TEXT NOT NULL,spec TEXT NOT NULL,checkpoint TEXT,result TEXT,UNIQUE(goal_id,key));
 CREATE TABLE IF NOT EXISTS control_dependencies(task_id TEXT NOT NULL REFERENCES control_tasks(id),depends_on_id TEXT NOT NULL REFERENCES control_tasks(id),PRIMARY KEY(task_id,depends_on_id));
 CREATE TABLE IF NOT EXISTS control_workers(id TEXT PRIMARY KEY,last_seen INTEGER NOT NULL,capabilities TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS control_events(id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id TEXT,task_id TEXT,type TEXT NOT NULL,actor TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS control_events_no_update BEFORE UPDATE ON control_events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS control_events_no_delete BEFORE DELETE ON control_events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;
 CREATE TABLE IF NOT EXISTS control_questions(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,task_id TEXT,status TEXT NOT NULL,request TEXT NOT NULL,answer TEXT,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS control_decisions(id TEXT PRIMARY KEY,goal_id TEXT,task_id TEXT,category TEXT NOT NULL,record TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE VIRTUAL TABLE IF NOT EXISTS control_memory USING fts5(id UNINDEXED,goal_id UNINDEXED,category UNINDEXED,text);
 CREATE TABLE IF NOT EXISTS control_budgets(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,task_id TEXT,amount REAL NOT NULL,actual REAL,status TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS control_resources(name TEXT PRIMARY KEY,task_id TEXT NOT NULL,generation INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS control_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,due_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS control_outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS control_evidence(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,commit_sha TEXT NOT NULL,kind TEXT NOT NULL,passed INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS control_artifacts(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,task_id TEXT,kind TEXT NOT NULL,location TEXT NOT NULL,metadata TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS control_findings(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,task_id TEXT,fingerprint TEXT NOT NULL UNIQUE,record TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open');
 CREATE TABLE IF NOT EXISTS control_tokens(hash TEXT PRIMARY KEY,actor TEXT NOT NULL,role TEXT NOT NULL,worker_id TEXT,expires_at INTEGER);
 CREATE TABLE IF NOT EXISTS control_idempotency(key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,response TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS control_operations(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,task_id TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,request TEXT NOT NULL,response TEXT,result_artifact TEXT,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS control_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS control_schedules(id TEXT PRIMARY KEY,config TEXT NOT NULL,interval_ms INTEGER NOT NULL,timezone TEXT NOT NULL,next_at INTEGER NOT NULL,last_goal_id TEXT);
 CREATE INDEX IF NOT EXISTS control_ready ON control_tasks(status,retry_at);
 CREATE INDEX IF NOT EXISTS control_goal_events ON control_events(goal_id,id);

 CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
 INSERT INTO schema_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 PRAGMA user_version=1;
      `);
    });
    this.migrateDeliveries();
    this.migrateRegistries();
    this.migrateStatePaths();
    this.migrateAttempts();
    this.migrateUsageReconciliation();
  }
  private migrateUsageReconciliation() {
    if (
      Number(
        this.db.one<{ user_version: number }>("PRAGMA user_version")
          ?.user_version,
      ) >= 6
    )
      return;
    this.db.transaction(() =>
      this.db.exec(`
      CREATE TABLE usage_reconciliations(attempt_id TEXT PRIMARY KEY REFERENCES control_attempts(id),record TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TRIGGER usage_reconciliation_no_update BEFORE UPDATE ON usage_reconciliations BEGIN SELECT RAISE(ABORT,'usage reconciliation is immutable'); END;
      CREATE TRIGGER usage_reconciliation_no_delete BEFORE DELETE ON usage_reconciliations BEGIN SELECT RAISE(ABORT,'usage reconciliation is immutable'); END;
      INSERT INTO schema_migrations VALUES(6,strftime('%Y-%m-%dT%H:%M:%fZ','now')); PRAGMA user_version=6;
    `),
    );
  }
  private migrateAttempts() {
    if (
      Number(
        this.db.one<{ user_version: number }>("PRAGMA user_version")
          ?.user_version,
      ) >= 5
    )
      return;
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE control_attempts(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES control_goals(id),task_id TEXT REFERENCES control_tasks(id),generation INTEGER NOT NULL,operation TEXT,worker_id TEXT,configuration_hash TEXT NOT NULL,configuration TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,outcome TEXT NOT NULL DEFAULT 'active',usage TEXT,execution_session_id TEXT,checkpoint TEXT,result TEXT);
        CREATE UNIQUE INDEX control_attempt_task ON control_attempts(task_id,generation) WHERE task_id IS NOT NULL;
        CREATE INDEX control_attempt_goal ON control_attempts(goal_id,started_at);
        CREATE TRIGGER control_attempt_admission BEFORE UPDATE OF configuration,configuration_hash,goal_id,task_id,generation,started_at ON control_attempts BEGIN SELECT RAISE(ABORT,'attempt admission is immutable'); END;
        INSERT INTO schema_migrations VALUES(5,strftime('%Y-%m-%dT%H:%M:%fZ','now')); PRAGMA user_version=5;
      `);
      // Alpha history remains events. Active work cannot acquire a new admission
      // retroactively; retain that private alpha and initialize clean v1 state.
      if (
        this.db.one(
          "SELECT id FROM control_tasks WHERE worker_id IS NOT NULL LIMIT 1",
        ) ||
        this.db.one(
          "SELECT id FROM control_budgets WHERE task_id IS NULL AND status='reserved' LIMIT 1",
        )
      )
        throw new Error(
          "Active earlier-alpha work lacks admitted attempts; retain it privately and initialize fresh state",
        );
    });
  }
  private startAttempt(
    attemptId: string,
    goal: Goal,
    generation: number,
    taskId?: string,
    workerId?: string,
    operation?: string,
    completedInvocation?: string,
  ) {
    if (goal.config.executionContract?.usagePolicy.kind === "subscription") {
      const limits = this.subscriptionCapacity(goal.id, completedInvocation);
      if (!limits?.admissionAllowed)
        throw new ControlError(
          "subscription_capacity",
          "Subscription identity, attempts or usage require recovery/inspection before admission",
          409,
        );
    }
    const config = this.redactor.json(goal.config);
    const hash = createHash("sha256").update(config).digest("hex");
    this.db.exec(
      `INSERT INTO control_attempts(id,goal_id,task_id,generation,operation,worker_id,configuration_hash,configuration,started_at) VALUES(${sql(attemptId)},${sql(goal.id)},${sql(taskId)},${generation},${sql(operation)},${sql(workerId)},${sql(hash)},${sql(config)},${sql(this.now())})`,
    );
  }
  attempts(goalId?: string, limit = 100, after = "") {
    const cursor = after
      ? this.db.one<{ started_at: string; id: string }>(
          `SELECT started_at,id FROM control_attempts WHERE id=${sql(after)} ${goalId ? `AND goal_id=${sql(goalId)}` : ""}`,
        )
      : undefined;
    if (after && !cursor)
      throw new ControlError(
        "invalid_cursor",
        "Attempt cursor does not belong to this query",
        400,
      );
    return this.db
      .query<Row>(
        `SELECT * FROM control_attempts WHERE 1=1 ${cursor ? `AND (started_at<${sql(cursor.started_at)} OR (started_at=${sql(cursor.started_at)} AND id<${sql(cursor.id)}))` : ""} ${goalId ? `AND goal_id=${sql(goalId)}` : ""} ORDER BY started_at DESC,id DESC LIMIT ${boundedLimit(limit)}`,
      )
      .map((r) => ({
        id: String(r.id),
        goalId: String(r.goal_id),
        taskId: r.task_id,
        generation: Number(r.generation),
        operation: r.operation,
        workerId: r.worker_id,
        configurationHash: String(r.configuration_hash),
        configuration: JSON.parse(String(r.configuration)),
        startedAt: r.started_at,
        endedAt: r.ended_at,
        outcome: r.outcome,
        usage: r.usage ? JSON.parse(String(r.usage)) : undefined,
        executionSessionId: r.execution_session_id,
        checkpoint: r.checkpoint ? JSON.parse(String(r.checkpoint)) : undefined,
        result: r.result ? JSON.parse(String(r.result)) : undefined,
        usageReconciliation: this.usageReconciliation(String(r.id)),
        evidence: r.task_id
          ? this.db.query(
              `SELECT id,kind,commit_sha,passed FROM control_evidence WHERE task_id=${sql(String(r.task_id))} AND generation=${Number(r.generation)}`,
            )
          : [],
      }));
  }
  usageReconciliation(attemptId: string) {
    const row = this.db.one<{ record: string }>(
      `SELECT record FROM usage_reconciliations WHERE attempt_id=${sql(attemptId)}`,
    );
    return row ? JSON.parse(row.record) : undefined;
  }
  unresolvedUsage() {
    return this.db.query(
      `SELECT b.id attemptId,b.goal_id goalId,b.task_id taskId,b.amount reservedUsd,a.outcome,a.ended_at endedAt FROM control_budgets b JOIN control_attempts a ON a.id=b.id WHERE b.status='unresolved' ORDER BY a.started_at,b.id`,
    );
  }
  reconcileUsage(
    attemptId: string,
    input: UsageReconciliation,
    evidenceSha256: string,
    actor: string,
  ) {
    const parsed = usageReconciliationSchema.parse(input);
    if (!/^[a-f0-9]{64}$/.test(evidenceSha256))
      throw new ControlError("usage_evidence", "Invalid evidence hash", 409);
    const request = this.redactor.json({ ...parsed, evidenceSha256 });
    return this.db.transaction(() => {
      if (this.setting("instance-maintenance"))
        throw new ControlError(
          "maintenance",
          "Usage reconciliation paused during complete backup",
          409,
        );
      const previous = this.usageReconciliation(attemptId);
      if (previous) {
        if (previous.request !== request)
          throw new ControlError(
            "usage_conflict",
            "Usage has already been reconciled from different evidence",
            409,
          );
        return previous;
      }
      const attempt = this.db.one<{
        goal_id: string;
        outcome: string;
        configuration: string;
        ended_at: string | null;
      }>(
        `SELECT goal_id,outcome,configuration,ended_at FROM control_attempts WHERE id=${sql(attemptId)}`,
      );
      const budget = this.db.one<{ status: string }>(
        `SELECT status FROM control_budgets WHERE id=${sql(attemptId)}`,
      );
      if (!attempt || !budget)
        throw new ControlError(
          "not_found",
          "Attempt reservation not found",
          404,
        );
      if (
        !attempt.ended_at ||
        ["active", "recovering"].includes(attempt.outcome) ||
        budget.status !== "unresolved"
      )
        throw new ControlError(
          "usage_state",
          "Only closed unresolved metered attempts can be reconciled",
          409,
        );
      const configuration = JSON.parse(attempt.configuration);
      if (
        configuration.backend.kind === "fake" ||
        configuration.executionContract?.usagePolicy.kind === "subscription"
      )
        throw new ControlError(
          "usage_policy",
          "Dollar reconciliation requires metered usage",
          409,
        );
      const artifact = this.db.one<{ goal_id: string }>(
        `SELECT goal_id FROM control_artifacts WHERE id=${sql(parsed.evidenceArtifactId)}`,
      );
      if (artifact?.goal_id !== attempt.goal_id)
        throw new ControlError(
          "usage_evidence",
          "Evidence must belong to the attempt's goal",
          409,
        );
      const record = {
        attemptId,
        request,
        ...parsed,
        evidenceSha256,
        actor,
        createdAt: this.now(),
      };
      this.db.exec(
        `INSERT INTO usage_reconciliations VALUES(${sql(attemptId)},${this.encode(record)},${sql(this.now())}); UPDATE control_budgets SET actual=${parsed.costUsd},status='settled' WHERE id=${sql(attemptId)} AND status='unresolved';`,
      );
      this.event("USAGE_RECONCILED", actor, record, attempt.goal_id);
      if (
        ["completed", "failed", "cancelled"].includes(
          this.getGoal(attempt.goal_id).status,
        )
      )
        this.queueGoalReport(attempt.goal_id);
      return this.usageReconciliation(attemptId);
    });
  }
  private closeAttempt(
    attemptId: string,
    outcome: string,
    usage?: Usage,
    result?: unknown,
  ) {
    this.db.exec(
      `UPDATE control_attempts SET ended_at=${sql(this.now())},outcome=${sql(outcome)},usage=COALESCE(${usage ? this.encode(usageSchema.parse(usage)) : "NULL"},usage),result=COALESCE(${result ? this.encode(result) : "NULL"},result),execution_session_id=COALESCE(${sql((result as { executionSessionId?: string } | undefined)?.executionSessionId)},execution_session_id) WHERE id=${sql(attemptId)} AND outcome IN ('active','recovering')`,
    );
  }
  private settleReservation(attemptId: string, cost?: number) {
    if (cost !== undefined && (!Number.isFinite(cost) || cost < 0))
      throw new ControlError("invalid_cost", "Invalid usage");
    this.db.exec(
      `UPDATE control_budgets SET status=${sql(cost === undefined ? "unresolved" : "settled")},actual=${sql(cost)} WHERE id=${sql(attemptId)} AND status='reserved'`,
    );
  }
  private migrateStatePaths() {
    if (
      Number(
        this.db.one<{ user_version: number }>("PRAGMA user_version")
          ?.user_version,
      ) >= 4
    )
      return;
    this.db.transaction(() => {
      // Earlier private alphas are disposable. Never interpret absolute state
      // records under a new root or import their old live work implicitly.
      if (this.setting("instance-identity"))
        for (const table of [
          "bases",
          "workspaces",
          "sessions",
          "execution_invocations",
        ]) {
          for (const row of this.db.query<{ record: string }>(
            `SELECT record FROM ${table}`,
          )) {
            const record = JSON.parse(row.record);
            if (typeof record.path === "string" && isAbsolute(record.path))
              throw new Error(
                "Earlier alpha state has absolute workspace paths; retain it privately and initialize fresh v1 state",
              );
          }
        }
      this.db.exec(
        "INSERT INTO schema_migrations VALUES(4,strftime('%Y-%m-%dT%H:%M:%fZ','now')); PRAGMA user_version=4;",
      );
    });
  }
  private migrateRegistries() {
    if (
      Number(
        this.db.one<{ user_version: number }>("PRAGMA user_version")
          ?.user_version,
      ) >= 3
    )
      return;
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS bases(owner TEXT PRIMARY KEY,record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY,token TEXT NOT NULL,expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY,record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS maintenance(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,generation INTEGER NOT NULL,record TEXT NOT NULL,UNIQUE(task_id,generation));
        CREATE TABLE IF NOT EXISTS execution_invocations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,generation INTEGER NOT NULL,record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS environment_images(id TEXT PRIMARY KEY,record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS environment_maintenance(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS inference_capabilities(hash TEXT PRIMARY KEY,record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inference_usage(id INTEGER PRIMARY KEY AUTOINCREMENT,capability_hash TEXT NOT NULL,record TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS gateway_networks(session_id TEXT PRIMARY KEY,record TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
        PRAGMA user_version=3;
      `);
    });
  }
  private migrateDeliveries() {
    if (
      Number(
        this.db.one<{ user_version: number }>("PRAGMA user_version")
          ?.user_version,
      ) >= 2
    )
      return;
    this.db.transaction(() => {
      this.db.exec(
        `CREATE TABLE connector_deliveries(id TEXT PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES control_outbox(id),connector_id TEXT NOT NULL,destination TEXT NOT NULL,transaction_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,attempts INTEGER NOT NULL,due_at INTEGER NOT NULL,receipt TEXT,last_error TEXT,UNIQUE(notification_id,connector_id,destination)); CREATE INDEX connector_delivery_pending ON connector_deliveries(connector_id,status,due_at); INSERT INTO schema_migrations VALUES(2,strftime('%Y-%m-%dT%H:%M:%fZ','now')); PRAGMA user_version=2;`,
      );
    });
  }

  now() {
    return new Date(this.clock()).toISOString();
  }
  event(
    type: string,
    actor: string,
    payload: unknown,
    goalId?: string,
    taskId?: string,
  ) {
    this.db.exec(
      `INSERT INTO control_events(goal_id,task_id,type,actor,payload,created_at) VALUES(${sql(goalId)},${sql(taskId)},${sql(type)},${sql(actor)},${this.encode(payload)},${sql(this.now())});`,
    );
  }
  getGoal(goalId: string): Goal {
    const r = this.db.one<Row>(
      `SELECT * FROM control_goals WHERE id=${sql(goalId)}`,
    );
    if (!r) throw new ControlError("not_found", "Goal not found", 404);
    return {
      id: String(r.id),
      status: r.status as Goal["status"],
      revision: Number(r.revision),
      planRevision: Number(r.plan_revision),
      createdAt: String(r.created_at),
      config: JSON.parse(String(r.config)),
      result: r.result ? JSON.parse(String(r.result)) : undefined,
    };
  }
  goals(limit = 50, after = "", projectIds?: string[]) {
    const scope = projectIds
      ? projectIds.length
        ? `json_extract(config,'$.projectId') IN (${projectIds.map(sql).join(",")})`
        : "0"
      : "1";
    const cursor = after
      ? this.db.one<{ id: string; created_at: string }>(
          `SELECT id,created_at FROM control_goals WHERE id=${sql(after)} AND ${scope}`,
        )
      : undefined;
    if (after && !cursor)
      throw new ControlError(
        "invalid_cursor",
        "Goal cursor does not belong to this instance",
        400,
      );
    return this.db
      .query<Row>(
        `SELECT id FROM control_goals WHERE ${scope} ${cursor ? `AND (created_at<${sql(cursor.created_at)} OR (created_at=${sql(cursor.created_at)} AND id<${sql(cursor.id)}))` : ""} ORDER BY created_at DESC,id DESC LIMIT ${boundedLimit(limit)}`,
      )
      .map((r) => this.getGoal(String(r.id)));
  }
  getTask(taskId: string): Task {
    const r = this.db.one<Row>(
      `SELECT * FROM control_tasks WHERE id=${sql(taskId)}`,
    );
    if (!r) throw new ControlError("not_found", "Task not found", 404);
    return {
      id: String(r.id),
      goalId: String(r.goal_id),
      key: String(r.key),
      status: r.status as TaskState,
      generation: Number(r.generation),
      attempts: Number(r.attempts),
      revision: Number(r.revision),
      workerId: r.worker_id as string | null,
      leaseUntil: r.lease_until as number | null,
      retryAt: r.retry_at as number | null,
      createdAt: String(r.created_at),
      spec: JSON.parse(String(r.spec)),
      checkpoint: r.checkpoint ? JSON.parse(String(r.checkpoint)) : undefined,
      result: r.result ? JSON.parse(String(r.result)) : undefined,
    };
  }
  tasks(goalId: string) {
    return this.db
      .query<Row>(
        `SELECT id FROM control_tasks WHERE goal_id=${sql(goalId)} ORDER BY created_at,id`,
      )
      .map((r) => this.getTask(String(r.id)));
  }
  projectContext(goalId: string) {
    const goal = this.getGoal(goalId);
    const rows = this.db.query<Row>(
      "SELECT id FROM control_goals ORDER BY rowid DESC LIMIT 500",
    );
    const related = rows
      .map((r) => this.getGoal(String(r.id)))
      .filter(
        (g) => g.id !== goalId && projectIdentity(g) === projectIdentity(goal),
      );
    return {
      repository: projectIdentity(goal),
      targetBranch: goal.config.policy.targetBranch,
      relatedGoals: related.slice(0, 20).map((g) => ({
        id: g.id,
        title: g.config.title,
        status: g.status,
        tasks: this.tasks(g.id)
          .slice(0, 100)
          .map((t) => ({
            id: t.id,
            title: t.spec.title,
            status: t.status,
            paths: t.spec.allowedPaths.slice(0, 50),
            result: t.result,
          })),
      })),
      unfinishedWork: this.setting(`unfinished:${projectIdentity(goal)}`) ?? [],
      openPullRequests: this.setting(
        `pull-requests:${projectIdentity(goal)}`,
      ) ?? { status: "not_discovered" },
    };
  }
  coordinate(goal: Goal) {
    // Goal insertion order chooses which goal waits. Transactional claims fence concurrent dispatch.
    const earlier = this.db.query<Row>(
      `SELECT id FROM control_goals WHERE rowid<(SELECT rowid FROM control_goals WHERE id=${sql(goal.id)}) AND status IN ('planning','running','paused','publishing') ORDER BY rowid`,
    );
    for (const row of earlier) {
      const other = this.getGoal(String(row.id));
      const overlap = overlapEvidence(
        goal,
        this.tasks(goal.id),
        other,
        this.tasks(other.id),
      );
      if (!overlap.length) continue;
      const reason = JSON.stringify({
        otherGoal: other.id,
        planRevision: goal.planRevision,
        otherPlanRevision: other.planRevision,
        overlap,
      });
      const approved = this.db
        .query<Row>(
          `SELECT request,answer FROM control_questions WHERE goal_id=${sql(goal.id)} AND task_id IS NULL AND status='answered'`,
        )
        .some((r) => {
          const request = JSON.parse(String(r.request)),
            answer = JSON.parse(String(r.answer));
          return request.reason === reason && answer.option === "coordinate";
        });
      if (approved) continue;
      this.requestGoalHuman(goal.id, {
        question: `Coordinate overlapping work with ${other.config.title}?`,
        reason,
        category: "policy",
        options: [
          { id: "wait", label: "Wait until the earlier goal finishes" },
          {
            id: "coordinate",
            label:
              "Authorize coordinated parallel work for these declared paths",
          },
        ],
        recommendedOption: "wait",
      });
      return false;
    }
    return true;
  }
  createGoal(input: GoalInput, actor = "operator"): Goal {
    const config = this.validateGoalConfiguration(input);
    if (config.scheduledAt)
      config.scheduledAt = new Date(config.scheduledAt).toISOString();
    return this.db.transaction(() => {
      const installation = this.setting("configuration-snapshot")?.settings;
      if (installation) {
        if (this.setting("instance-maintenance"))
          throw new ControlError(
            "maintenance",
            "Admissions paused during complete backup",
            409,
          );
        const admitted = Number(this.setting("admitted-cost-usd") ?? 0);
        if (
          admitted + config.maxCostUsd >
          installation.authority.maxTotalAdmittedCostUsd
        )
          throw new ControlError(
            "intake_budget",
            "Cumulative configured admission allowance is exhausted",
            409,
          );
        this.setting("admitted-cost-usd", admitted + config.maxCostUsd);
      }
      const goalId = id("goal");
      this.db.exec(
        `INSERT INTO control_goals(id,status,created_at,config) VALUES(${sql(goalId)},'planning',${sql(this.now())},${this.encode(config)});`,
      );
      this.event("GOAL_CREATED", actor, { config }, goalId);
      this.job(
        "plan",
        { goalId },
        config.scheduledAt ? Date.parse(config.scheduledAt) : this.clock(),
      );
      return this.getGoal(goalId);
    });
  }
  projects() {
    return (this.setting("projects") ?? []) as import("zod").infer<
      typeof projectSchema
    >[];
  }
  setProject(input: unknown, actor: string) {
    const project = projectSchema.parse(input);
    if (project.config.scheduledAt)
      throw new ControlError(
        "policy",
        "Project defaults cannot schedule a one-time start",
      );
    project.config.projectId = project.id;
    if (project.enabled) {
      this.validateGoalConfiguration(project.config);
      if (!project.config.repository)
        throw new ControlError(
          "repository_policy",
          "Enabled projects require audited repository policy",
        );
      if (!project.config.verificationCommands.length)
        throw new ControlError(
          "policy",
          "Enable a project only with explicit verification checks",
        );
      if (
        project.config.backend.kind !== "fake" &&
        !project.config.containerImage
      )
        throw new ControlError(
          "policy",
          "Enabled projects require a project-specific verification image",
        );
    }
    return this.db.transaction(() => {
      const projects = this.projects().filter((p) => p.id !== project.id);
      projects.push(project);
      this.setting("projects", projects);
      this.event("PROJECT_CONFIGURED", actor, {
        projectId: project.id,
        enabled: project.enabled,
      });
      return project;
    });
  }
  validateGoalConfiguration(input: GoalInput) {
    const config = goalSchema.parse(input);
    try {
      validateExecutionLimits(config);
    } catch (error) {
      throw new ControlError(
        "execution_contract",
        (error as Error).message,
        409,
      );
    }
    if (config.executionContract) {
      const contract = validateBackendContract(
        config.backend,
        config.executionContract,
      );
      if (contract.usagePolicy.kind === "subscription")
        throw new ControlError(
          "subscription_unqualified",
          "Subscription coding admission requires qualified isolated execution",
        );
      if (
        contract.usagePolicy.kind === "metered" &&
        (config.maxCostUsd > contract.usagePolicy.maxCostUsd ||
          config.estimatePerRunUsd > contract.usagePolicy.estimatePerRunUsd)
      )
        throw new ControlError(
          "usage_policy",
          "Goal exceeds provider usage policy",
        );
    }
    if (
      config.policy.autoMerge &&
      (!config.policy.publish || !config.policy.productionDeploymentExcluded)
    )
      throw new ControlError(
        "policy",
        "Automatic merge requires publication and explicit production exclusion",
      );
    if (
      ["azure", "bedrock", "claude-code"].includes(config.backend.kind) &&
      (config.maxCostUsd <= 0 || config.estimatePerRunUsd <= 0)
    )
      throw new ControlError(
        "budget",
        "Paid providers require a positive authorized budget and run estimate",
      );
    return config;
  }
  createSchedule(input: unknown, actor: string) {
    const v = scheduleSchema.parse(input);
    new Intl.DateTimeFormat("en", { timeZone: v.timezone });
    const config = this.validateGoalConfiguration(v.config);
    if (config.scheduledAt)
      throw new ControlError(
        "invalid_schedule",
        "Recurring templates cannot include a one-time scheduledAt",
      );
    return this.db.transaction(() => {
      const scheduleId = id("schedule");
      this.db.exec(
        `INSERT INTO control_schedules VALUES(${sql(scheduleId)},${this.encode(config)},${v.intervalMs},${sql(v.timezone)},${this.clock()},NULL)`,
      );
      this.event("SCHEDULE_CREATED", actor, {
        id: scheduleId,
        intervalMs: v.intervalMs,
        timezone: v.timezone,
      });
      return { id: scheduleId, intervalMs: v.intervalMs, timezone: v.timezone };
    });
  }
  schedules() {
    return this.db.query<Row>(
      "SELECT id,interval_ms,timezone,next_at,last_goal_id FROM control_schedules ORDER BY id",
    );
  }
  switchBackend(
    goalId: string,
    input: unknown,
    expectedRevision: number,
    actor = "operator",
  ) {
    const backend = backendSchema.parse(input);
    return this.db.transaction(() => {
      const g = this.getGoal(goalId);
      if (g.config.admission)
        throw new ControlError(
          "admitted_configuration",
          "Admitted goals retain their provider and execution configuration; submit a new goal",
          409,
        );
      if (g.revision !== expectedRevision)
        throw new ControlError("revision_conflict", "Goal changed", 409);
      if (g.status !== "paused")
        throw new ControlError(
          "invalid_transition",
          "Pause the goal before switching its backend",
          409,
        );
      if (
        this.tasks(goalId).some((t) => t.workerId) ||
        this.db.one<Row>(
          `SELECT id FROM control_budgets WHERE goal_id=${sql(goalId)} AND status='reserved' UNION ALL SELECT id FROM control_attempts WHERE goal_id=${sql(goalId)} AND outcome IN ('active','recovering') LIMIT 1`,
        )
      )
        throw new ControlError(
          "active_work",
          "Wait for active workers, planning and integration to drain before switching",
          409,
        );
      if (
        ["azure", "bedrock", "claude-code"].includes(backend.kind) &&
        (g.config.maxCostUsd <= 0 || g.config.estimatePerRunUsd <= 0)
      )
        throw new ControlError(
          "budget",
          "Paid backends require a positive authorized budget and run estimate",
        );
      const tasks = this.tasks(goalId);
      if (tasks.some((t) => t.checkpoint?.pendingTool))
        throw new ControlError(
          "pending_tool",
          "Reconcile interrupted tools before switching the backend",
          409,
        );
      for (const t of tasks.filter(
        (t) => !["accepted", "superseded", "cancelled"].includes(t.status),
      )) {
        const saved = t.checkpoint;
        // Native messages are not portable; keep the authoritative continuation and commit.
        const checkpoint = saved
          ? {
              commit: saved.commit,
              summary: saved.summary,
              costUsd: saved.costUsd,
            }
          : undefined;
        this.db
          .exec(`UPDATE control_tasks SET checkpoint=${checkpoint ? this.encode(checkpoint) : "NULL"},
          status=${sql(["waiting_provider", "retry_wait"].includes(t.status) ? "pending" : t.status)},
          retry_at=NULL,revision=revision+1 WHERE id=${sql(t.id)}`);
      }
      const config = { ...g.config, backend };
      this.validateGoalConfiguration(config);
      this.db.exec(
        `UPDATE control_goals SET config=${this.encode(config)},revision=revision+1 WHERE id=${sql(goalId)}`,
      );
      this.event(
        "BACKEND_SWITCHED",
        actor,
        { from: g.config.backend, to: backend },
        goalId,
      );
      return this.getGoal(goalId);
    });
  }
  installPlan(
    goalId: string,
    input: unknown,
    expectedRevision: number,
    actor = "planner",
  ) {
    const specs = validatePlan(input);
    return this.db.transaction(() => {
      const g = this.getGoal(goalId);
      if (g.revision !== expectedRevision)
        throw new ControlError("revision_conflict", "Goal changed", 409);
      if (g.planRevision > g.config.maxReplans)
        throw new ControlError("replan_limit", "Replanning limit reached", 409);
      if (this.tasks(goalId).some((t) => t.workerId))
        throw new ControlError(
          "active_work",
          "Checkpoint active tasks before replacing the plan",
          409,
        );
      const old = this.tasks(goalId);
      const accepted = old.filter((t) => t.status === "accepted");
      for (const t of accepted) {
        const proposed = specs.find((s) => s.key === t.key);
        if (!proposed || JSON.stringify(proposed) !== JSON.stringify(t.spec))
          throw new ControlError(
            "accepted_work",
            "Plan must preserve accepted task contracts",
            409,
          );
      }
      for (const t of old.filter((t) => t.status !== "accepted")) {
        this.db.exec(
          `DELETE FROM control_dependencies WHERE task_id=${sql(t.id)}`,
        );
        this.db.exec(
          `UPDATE control_tasks SET status='superseded',revision=revision+1 WHERE id=${sql(t.id)}`,
        );
      }
      const mapping = new Map(accepted.map((t) => [t.key, t.id]));
      for (const spec of specs) {
        if (mapping.has(spec.key)) continue;
        const prior = old.find((t) => t.key === spec.key);
        const taskId = prior?.id ?? id("task");
        if (prior)
          this.db.exec(
            `UPDATE control_tasks SET status='pending',spec=${this.encode(spec)},result=NULL,attempts=0,revision=revision+1 WHERE id=${sql(taskId)}`,
          );
        else
          this.db.exec(
            `INSERT INTO control_tasks(id,goal_id,key,status,created_at,spec) VALUES(${sql(taskId)},${sql(goalId)},${sql(spec.key)},'pending',${sql(this.now())},${this.encode(spec)});`,
          );
        mapping.set(spec.key, taskId);
      }
      for (const spec of specs)
        for (const dep of spec.dependencies)
          this.db.exec(
            `INSERT OR IGNORE INTO control_dependencies VALUES(${sql(mapping.get(spec.key))},${sql(mapping.get(dep))});`,
          );
      this.db.exec(
        `UPDATE control_goals SET status='running',plan_revision=plan_revision+1,revision=revision+1 WHERE id=${sql(goalId)}`,
      );
      this.event(
        "PLAN_CREATED",
        actor,
        { tasks: specs, revision: g.planRevision + 1 },
        goalId,
      );
      this.ready(goalId);
      return this.getGoal(goalId);
    });
  }
  ready(goalId?: string) {
    this.db.exec(
      `UPDATE control_tasks SET status='ready',revision=revision+1 WHERE status IN ('pending','retry_wait','waiting_provider') AND (retry_at IS NULL OR retry_at<=${this.clock()}) ${goalId ? `AND goal_id=${sql(goalId)}` : ""} AND goal_id IN(SELECT id FROM control_goals WHERE status='running' AND (json_extract(config,'$.scheduledAt') IS NULL OR json_extract(config,'$.scheduledAt')<=${sql(this.now())})) AND NOT EXISTS(SELECT 1 FROM control_dependencies d JOIN control_tasks p ON p.id=d.depends_on_id WHERE d.task_id=control_tasks.id AND p.status!='accepted');`,
    );
  }
  registerWorker(workerId: string, capabilities = ["developer"]) {
    this.db.exec(
      `INSERT INTO control_workers VALUES(${sql(workerId)},${this.clock()},${this.encode(capabilities)}) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,capabilities=excluded.capabilities`,
    );
  }
  claimNextTask(
    workerId: string,
    options: {
      goalId?: string;
      globalLimit?: number;
      capabilities?: string[];
    } = {},
  ): Claim | null {
    return this.db.transaction(() => {
      this.registerWorker(workerId, options.capabilities);
      this.ready(options.goalId);
      const limits = this.setting("scheduler-limits") ?? {
        workers: 4,
        cpu: availableParallelism(),
        memoryMiB: Math.floor((totalmem() / 1048576) * 0.75),
        providerWorkers: 4,
        repositoryWorkers: 4,
      };
      const occupied = this.db
        .query<Row>("SELECT id FROM control_tasks WHERE worker_id IS NOT NULL")
        .map((r) => this.getTask(String(r.id)));
      const orchestration = Number(
        this.db.one<Row>(
          "SELECT COUNT(*) n FROM control_attempts WHERE task_id IS NULL AND outcome IN ('active','recovering') AND operation!='review'",
        )?.n,
      );
      const active = Number(
        this.db.one<Row>(
          `SELECT COUNT(*) AS n FROM control_tasks WHERE worker_id IS NOT NULL`,
        )?.n,
      );
      if (active + orchestration >= (options.globalLimit ?? limits.workers))
        return null;
      const candidates = this.db.query<Row>(
        `SELECT t.id FROM control_tasks t JOIN control_goals g ON g.id=t.goal_id WHERE t.status='ready' AND g.status='running' ${options.goalId ? `AND t.goal_id=${sql(options.goalId)}` : ""} ORDER BY CAST(json_extract(t.spec,'$.priority') AS INTEGER) DESC,t.created_at,t.rowid`,
      );
      for (const row of candidates) {
        const task = this.getTask(String(row.id)),
          goal = this.getGoal(task.goalId);
        if (!this.coordinate(goal)) continue;
        if (
          occupied.reduce((n, t) => n + t.spec.cpuUnits, 0) +
            task.spec.cpuUnits >
            limits.cpu ||
          occupied.reduce((n, t) => n + t.spec.memoryMiB, 0) +
            task.spec.memoryMiB >
            limits.memoryMiB
        )
          continue;
        if (
          occupied.filter(
            (t) =>
              this.getGoal(t.goalId).config.backend.kind ===
              goal.config.backend.kind,
          ).length >= limits.providerWorkers
        )
          continue;
        if (
          occupied.filter(
            (t) =>
              this.getGoal(t.goalId).config.repoPath === goal.config.repoPath,
          ).length >= limits.repositoryWorkers
        )
          continue;
        if (
          options.capabilities &&
          !options.capabilities.includes(task.spec.capability)
        )
          continue;
        if (
          this.tasks(goal.id).filter((t) => t.workerId).length >=
          goal.config.maxWorkers
        )
          continue;
        if (
          task.spec.resources.some((name) =>
            this.db.one<Row>(
              `SELECT * FROM control_resources WHERE name=${sql(name)}`,
            ),
          )
        )
          continue;
        const reserved = Number(
          this.db.one<Row>(
            `SELECT COALESCE(SUM(CASE WHEN status='settled' THEN actual ELSE amount END),0) AS n FROM control_budgets WHERE goal_id=${sql(goal.id)} AND status!='released'`,
          )?.n,
        );
        if (reserved + goal.config.estimatePerRunUsd > goal.config.maxCostUsd)
          continue;
        if (
          goal.config.executionContract?.usagePolicy.kind === "subscription" &&
          !this.subscriptionCapacity(goal.id)?.admissionAllowed
        )
          continue;
        const generation = task.generation + 1;
        this.db.exec(
          `UPDATE control_tasks SET status='claimed',generation=${generation},worker_id=${sql(workerId)},lease_until=${this.clock() + 120000},attempts=attempts+1,revision=revision+1 WHERE id=${sql(task.id)};`,
        );
        for (const name of task.spec.resources)
          this.db.exec(
            `INSERT INTO control_resources VALUES(${sql(name)},${sql(task.id)},${generation})`,
          );
        if (
          goal.config.executionContract?.usagePolicy.kind !== "subscription"
        ) {
          this.db.exec(
            `INSERT INTO control_budgets VALUES(${sql(`${task.id}:${generation}`)},${sql(goal.id)},${sql(task.id)},${goal.config.estimatePerRunUsd},NULL,'reserved')`,
          );
        }
        this.startAttempt(
          `${task.id}:${generation}`,
          goal,
          generation,
          task.id,
          workerId,
        );
        this.event("TASK_CLAIMED", workerId, { generation }, goal.id, task.id);
        return { task: this.getTask(task.id), goal, generation, workerId };
      }
      return null;
    });
  }
  assertLease(taskId: string, workerId: string, generation: number): Task {
    const t = this.getTask(taskId);
    if (
      t.workerId !== workerId ||
      t.generation !== generation ||
      !t.leaseUntil ||
      t.leaseUntil <= this.clock()
    )
      throw new ControlError(
        "stale_lease",
        "Task lease is no longer valid",
        409,
      );
    return t;
  }
  heartbeat(taskId: string, workerId: string, generation: number) {
    return this.db.transaction(() => {
      this.assertLease(taskId, workerId, generation);
      this.db.exec(
        `UPDATE control_tasks SET lease_until=${this.clock() + 120000} WHERE id=${sql(taskId)}`,
      );
      this.registerWorker(workerId);
      return this.getTask(taskId);
    });
  }
  transition(
    taskId: string,
    workerId: string,
    generation: number,
    status: "running" | "verifying" | "integrating",
    result?: unknown,
  ) {
    return this.db.transaction(() => {
      const t = this.assertLease(taskId, workerId, generation);
      const allowed = {
        running: ["claimed"],
        verifying: ["running"],
        integrating: ["verifying"],
      };
      if (!allowed[status].includes(t.status))
        throw new ControlError(
          "invalid_transition",
          `${t.status} cannot become ${status}`,
          409,
        );
      this.db.exec(
        `UPDATE control_tasks SET status=${sql(status)},result=${this.encode(result ?? t.result ?? null)},revision=revision+1 WHERE id=${sql(taskId)}`,
      );
      if (result && typeof result === "object") {
        const r = result as { usage?: Usage; executionSessionId?: string };
        if (r.usage) executionUsage(r, this.getGoal(t.goalId).config);
        this.db.exec(
          `UPDATE control_attempts SET result=${this.encode(result)},usage=COALESCE(${r.usage ? this.encode(r.usage) : "NULL"},usage),execution_session_id=COALESCE(${sql(r.executionSessionId)},execution_session_id) WHERE task_id=${sql(taskId)} AND generation=${generation} AND outcome='active'`,
        );
      }
      this.event(
        `TASK_${status.toUpperCase()}`,
        workerId,
        { generation },
        t.goalId,
        t.id,
      );
      return this.getTask(taskId);
    });
  }
  checkpoint(
    taskId: string,
    workerId: string,
    generation: number,
    input: unknown,
  ) {
    const c = checkpointSchema.parse(input);
    return this.db.transaction(() => {
      const t = this.assertLease(taskId, workerId, generation);
      if (c.usage) executionUsage(c, this.getGoal(t.goalId).config);
      this.db.exec(
        `UPDATE control_tasks SET checkpoint=${this.encode(c)},revision=revision+1 WHERE id=${sql(taskId)}`,
      );
      this.db.exec(
        `UPDATE control_attempts SET checkpoint=${this.encode(c)},usage=COALESCE(${c.usage ? this.encode(c.usage) : "NULL"},usage) WHERE task_id=${sql(taskId)} AND generation=${generation} AND outcome='active'`,
      );
      this.event("CHECKPOINT", workerId, c, t.goalId, t.id);
      return c;
    });
  }
  release(
    taskId: string,
    workerId: string,
    generation: number,
    status: "retry_wait" | "waiting_provider" | "blocked" | "failed",
    reason: string,
    actualCost?: number,
    usage?: Usage,
  ) {
    return this.db.transaction(() => {
      const t = this.assertLease(taskId, workerId, generation);
      if (usage)
        executionUsage(
          { usage, costUsd: actualCost },
          this.getGoal(t.goalId).config,
        );
      if (usage)
        this.db.exec(
          `UPDATE control_attempts SET usage=${this.encode(usageSchema.parse(usage))} WHERE task_id=${sql(taskId)} AND generation=${generation} AND outcome='active'`,
        );
      const g = this.getGoal(t.goalId);
      if (
        actualCost !== undefined &&
        (!Number.isFinite(actualCost) || actualCost < 0)
      )
        throw new ControlError("invalid_cost", "Invalid actual cost");
      const next =
        status === "retry_wait" && t.attempts >= g.config.maxAttempts
          ? "failed"
          : status;
      const delay = Math.min(300000, 10000 * 2 ** Math.min(t.attempts - 1, 6));
      this.free(t, actualCost, next);
      this.db.exec(
        `UPDATE control_tasks SET status=${sql(next)},retry_at=${this.clock() + delay},attempts=attempts-${status === "waiting_provider" ? 1 : 0},result=${this.encode({ reason })},revision=revision+1 WHERE id=${sql(taskId)}`,
      );
      this.event(
        "TASK_RELEASED",
        workerId,
        { status: next, reason },
        t.goalId,
        t.id,
      );
      return this.getTask(taskId);
    });
  }
  free(t: Task, cost?: number, outcome = "stopped") {
    const goal = this.getGoal(t.goalId),
      attemptId = `${t.id}:${t.generation}`;
    const stored = this.db.one<{ usage: string | null }>(
      `SELECT usage FROM control_attempts WHERE id=${sql(attemptId)}`,
    );
    const usage = stored?.usage
      ? executionUsage({ usage: JSON.parse(stored.usage) }, goal.config)
      : undefined;
    const known = usage
      ? knownCost(usage)
      : goal.config.backend.kind === "fake"
        ? (cost ?? 0)
        : cost;
    this.db.exec(
      `UPDATE control_tasks SET worker_id=NULL,lease_until=NULL WHERE id=${sql(t.id)}; DELETE FROM control_resources WHERE task_id=${sql(t.id)} AND generation=${t.generation};`,
    );
    this.settleReservation(attemptId, known);
    this.closeAttempt(
      attemptId,
      outcome,
      usage ?? executionUsage({ costUsd: known }, goal.config),
    );
  }
  fenceStartup() {
    return this.db.transaction(() => {
      const prior = this.setting("startup-recovery") as
        { tasks: string[]; operations: string[] } | undefined;
      const tasks = new Set(prior?.tasks ?? []),
        operations = new Set(prior?.operations ?? []);
      for (const r of this.db.query<Row>(
        "SELECT id FROM control_tasks WHERE worker_id IS NOT NULL",
      ))
        tasks.add(String(r.id));
      for (const r of this.db.query<Row>(
        "SELECT id FROM control_attempts WHERE task_id IS NULL AND outcome IN ('active','recovering')",
      ))
        operations.add(String(r.id));
      this.db.exec(
        `UPDATE control_tasks SET lease_until=${this.clock() - 1} WHERE worker_id IS NOT NULL; DELETE FROM control_tokens WHERE role='worker'; UPDATE control_attempts SET outcome='recovering' WHERE outcome='active';`,
      );
      // Running inference may have advanced since a partial checkpoint. Preserve
      // its reservation until operator reconciliation rather than settle a prefix.
      for (const taskId of tasks) {
        const task = this.getTask(taskId);
        if (
          ["claimed", "running"].includes(task.status) &&
          this.getGoal(task.goalId).config.backend.kind !== "fake"
        )
          this.db.exec(
            `UPDATE control_attempts SET usage=${this.encode(executionUsage({}, this.getGoal(task.goalId).config))} WHERE task_id=${sql(taskId)} AND generation=${task.generation} AND outcome='recovering'`,
          );
      }
      for (const r of this.db.query<{ hash: string; record: string }>(
        "SELECT hash,record FROM inference_capabilities",
      ))
        this.db.exec(
          `UPDATE inference_capabilities SET record=${this.encode({ ...JSON.parse(r.record), revoked: true })} WHERE hash=${sql(r.hash)}`,
        );
      this.setting("startup-recovery", {
        tasks: [...tasks],
        operations: [...operations],
      });
    });
  }
  finishStartupRecovery() {
    return this.db.transaction(() => {
      const prior = this.setting("startup-recovery") as
        { tasks: string[]; operations: string[] } | undefined;
      for (const taskId of prior?.tasks ?? []) {
        const task = this.getTask(taskId),
          attemptId = `${task.id}:${task.generation}`;
        this.free(task, undefined, "interrupted");
        this.db.exec(
          `UPDATE control_tasks SET status='waiting_human',retry_at=NULL,revision=revision+1 WHERE id=${sql(task.id)} AND status NOT IN ('accepted','cancelled','superseded')`,
        );
        if (this.getTask(task.id).status !== "waiting_human") continue;
        const qid = id("question"),
          request = questionSchema.parse({
            question: "Inspect interrupted work before a fresh attempt?",
            reason:
              "The prior controller stopped. Execution was fenced and owned containers stopped; source/checkpoints are retained. Tool effects and unreported usage may be uncertain. Inspect retained evidence before continuing.",
            category: "policy",
            recoveryAttemptId: attemptId,
            options: [
              { id: "inspect", label: "Inspected; authorize a fresh attempt" },
              { id: "defer", label: "Keep pending" },
            ],
          });
        if (
          !this.questions().some(
            (q) =>
              q.taskId === task.id && q.request.recoveryAttemptId === attemptId,
          )
        ) {
          this.db.exec(
            `INSERT INTO control_questions VALUES(${sql(qid)},${sql(task.goalId)},${sql(task.id)},'pending',${this.encode(request)},NULL,1,${sql(this.now())})`,
          );
          this.outbox("question", {
            questionId: qid,
            revision: 1,
            goalId: task.goalId,
            request,
          });
          this.event(
            "RUNTIME_RECOVERED",
            "controller",
            { attemptId, questionId: qid },
            task.goalId,
            task.id,
          );
        }
      }
      for (const attemptId of prior?.operations ?? []) {
        this.settleOperation(attemptId, undefined, undefined, "interrupted");
        const r = this.db.one<Row>(
          `SELECT goal_id FROM control_attempts WHERE id=${sql(attemptId)}`,
        );
        if (r) {
          const goal = this.getGoal(String(r.goal_id));
          if (!["completed", "cancelled", "failed"].includes(goal.status))
            this.db.exec(
              `UPDATE control_goals SET status='paused',revision=revision+1 WHERE id=${sql(goal.id)}`,
            );
          this.requestGoalHuman(goal.id, {
            question:
              "Inspect interrupted controller operation before resuming?",
            reason: `Operation ${attemptId} may have incomplete effects or unreported usage. Inspect preserved execution evidence; resume explicitly after review.`,
            category: "policy",
            options: [
              { id: "inspect", label: "Inspect recovery evidence" },
              { id: "defer", label: "Keep paused" },
            ],
          });
        }
      }
      this.setting("startup-recovery", { tasks: [], operations: [] });
      this.setting("startup-recovery-fault", null);
    });
  }
  expired() {
    return this.db
      .query<Row>(
        `SELECT id FROM control_tasks WHERE worker_id IS NOT NULL AND lease_until<=${this.clock()}`,
      )
      .map((r) => this.getTask(String(r.id)));
  }
  reconcileExpired(taskId: string, generation: number, actor = "scheduler") {
    return this.db.transaction(() => {
      const t = this.getTask(taskId);
      if (
        t.generation !== generation ||
        !t.leaseUntil ||
        t.leaseUntil > this.clock()
      )
        throw new ControlError("stale_recovery", "Lease is not expired", 409);
      this.free(t, undefined, "interrupted");
      this.db.exec(
        `UPDATE control_tasks SET status='retry_wait',retry_at=${this.clock()},revision=revision+1 WHERE id=${sql(t.id)}`,
      );
      this.event("LEASE_RECOVERED", actor, { generation }, t.goalId, t.id);
    });
  }
  evidence(
    taskId: string,
    workerId: string,
    generation: number,
    commit: string,
    kind: "tests" | "review" | "integration",
    passed: boolean,
    data: unknown,
  ) {
    return this.db.transaction(() => {
      const t = this.assertLease(taskId, workerId, generation);
      const evidenceId = id("evidence");
      this.db.exec(
        `INSERT INTO control_evidence(id,task_id,commit_sha,kind,passed,data,created_at,generation) VALUES(${sql(evidenceId)},${sql(taskId)},${sql(commit)},${sql(kind)},${passed ? 1 : 0},${this.encode(data)},${sql(this.now())},${generation})`,
      );
      this.event(
        "EVIDENCE",
        workerId,
        { evidenceId, commit, kind, passed },
        t.goalId,
        t.id,
      );
      return evidenceId;
    });
  }
  accept(
    taskId: string,
    workerId: string,
    generation: number,
    commit: string,
    integrationCommit: string,
    actualCost?: number,
  ) {
    return this.db.transaction(() => {
      const t = this.assertLease(taskId, workerId, generation);
      if (t.status !== "integrating")
        throw new ControlError(
          "invalid_transition",
          "Task is not integrating",
          409,
        );
      for (const [kind, sha] of [
        ["tests", commit],
        ["review", commit],
        ["integration", integrationCommit],
      ]) {
        if (
          this.db.one<Row>(
            `SELECT passed FROM control_evidence WHERE task_id=${sql(taskId)} AND generation=${generation} AND kind=${sql(kind)} AND commit_sha=${sql(sha)} ORDER BY rowid DESC LIMIT 1`,
          )?.passed !== 1
        )
          throw new ControlError(
            "missing_evidence",
            `Missing ${kind} evidence for ${sha}`,
            409,
          );
      }
      this.free(t, actualCost, "accepted");
      this.db.exec(
        `UPDATE control_tasks SET status='accepted',result=${this.encode({ commit, integrationCommit })},revision=revision+1 WHERE id=${sql(taskId)}`,
      );
      this.event(
        "TASK_ACCEPTED",
        workerId,
        { commit, integrationCommit },
        t.goalId,
        t.id,
      );
      this.ready(t.goalId);
      if (
        this.tasks(t.goalId).every((x) =>
          ["accepted", "superseded"].includes(x.status),
        )
      ) {
        this.db.exec(
          `UPDATE control_goals SET status=CASE WHEN status='paused' THEN 'paused' ELSE 'publishing' END,revision=revision+1 WHERE id=${sql(t.goalId)}`,
        );
        this.job("publish", { goalId: t.goalId });
      }
      return this.getTask(taskId);
    });
  }
  requestHuman(
    taskId: string,
    workerId: string,
    generation: number,
    input: QuestionInput,
  ) {
    const request = questionSchema.parse(input);
    return this.db.transaction(() => {
      const t = this.assertLease(taskId, workerId, generation);
      if (!t.checkpoint)
        throw new ControlError(
          "checkpoint_required",
          "Save continuation before waiting for a human",
        );
      const qid = id("question");
      this.db.exec(
        `INSERT INTO control_questions VALUES(${sql(qid)},${sql(t.goalId)},${sql(taskId)},'pending',${this.encode(request)},NULL,1,${sql(this.now())})`,
      );
      this.free(t, t.checkpoint?.costUsd, "waiting_human");
      this.db.exec(
        `UPDATE control_tasks SET status='waiting_human',attempts=MAX(0,attempts-1),revision=revision+1 WHERE id=${sql(taskId)}`,
      );
      this.event(
        "HUMAN_INPUT_REQUIRED",
        workerId,
        { questionId: qid, request },
        t.goalId,
        taskId,
      );
      this.outbox("question", { questionId: qid, goalId: t.goalId, request });
      return this.question(qid);
    });
  }
  requestOperation(
    taskId: string,
    workerId: string,
    generation: number,
    input: {
      action: string;
      scope: string;
      reason: string;
      idempotencyKey: string;
    },
  ) {
    input = ownerOperationSchema.parse(input);
    return this.db.transaction(() => {
      const task = this.assertLease(taskId, workerId, generation);
      if (!task.checkpoint)
        throw new ControlError(
          "checkpoint_required",
          "Checkpoint before requesting owner operations",
        );
      const key = `${taskId}:${input.idempotencyKey}`;
      const existing = this.db.one<Row>(
        `SELECT * FROM control_operations WHERE idempotency_key=${sql(key)}`,
      );
      if (existing) {
        if (existing.request !== JSON.stringify(input))
          throw new ControlError(
            "idempotency_conflict",
            "Operation key reused with another request",
            409,
          );
        const operation = this.operation(String(existing.id));
        this.free(task, task.checkpoint.costUsd, "waiting_owner");
        const terminal = ["completed", "rejected"].includes(
          String(operation.status),
        );
        // Replayed handoffs still finish this invocation. Never leave a worker
        // claimed after its harness has stopped. Terminal retries retain normal
        // attempt bounds; repeating a result must not become an infinite free loop.
        this.db.exec(
          `UPDATE control_tasks SET status=${sql(terminal ? "retry_wait" : "waiting_human")},retry_at=${terminal ? this.clock() + 1000 : "NULL"},checkpoint=${this.encode({ ...task.checkpoint, summary: `${task.checkpoint.summary}\nOwner operation ${operation.id} (${operation.status}): ${JSON.stringify(operation.response)}. Continue using this recorded result; do not repeat the same operation.` })},attempts=${terminal ? "attempts" : "MAX(0,attempts-1)"},revision=revision+1 WHERE id=${sql(taskId)}`,
        );
        this.event(
          "OWNER_OPERATION_REPLAYED",
          workerId,
          { operationId: operation.id, status: operation.status },
          task.goalId,
          taskId,
        );
        return operation;
      }
      const operationId = id("operation");
      this.db.exec(
        `INSERT INTO control_operations VALUES(${sql(operationId)},${sql(task.goalId)},${sql(task.id)},${sql(key)},'requested',${this.encode(input)},NULL,NULL,${sql(this.now())})`,
      );
      this.free(task, task.checkpoint.costUsd, "waiting_owner");
      this.db.exec(
        `UPDATE control_tasks SET status='waiting_human',attempts=MAX(0,attempts-1),revision=revision+1 WHERE id=${sql(taskId)}`,
      );
      this.event(
        "OWNER_OPERATION_REQUESTED",
        workerId,
        { operationId, request: input },
        task.goalId,
        taskId,
      );
      this.requestGoalHuman(task.goalId, {
        question: `Owner operation: ${input.action}`,
        reason: `${input.scope}: ${input.reason}. Operation ${operationId} requires a trusted owner to execute or reject and record the result.`,
        category: "policy",
        options: [
          { id: "inspect", label: "Inspect owner operation request" },
          { id: "defer", label: "Leave operation pending" },
        ],
      });
      return this.operation(operationId);
    });
  }
  operation(operationId: string): Row & { request: any; response: any } {
    const row = this.db.one<Row>(
      `SELECT * FROM control_operations WHERE id=${sql(operationId)}`,
    );
    if (!row)
      throw new ControlError("not_found", "Owner operation not found", 404);
    return {
      ...row,
      request: JSON.parse(String(row.request)),
      response: row.response ? JSON.parse(String(row.response)) : null,
    };
  }
  operations() {
    return this.db
      .query<Row>(
        "SELECT id FROM control_operations WHERE status IN ('requested','executing') ORDER BY created_at",
      )
      .map((r) => this.operation(String(r.id)));
  }
  respondOperation(
    operationId: string,
    response: {
      status: "executing" | "completed" | "rejected";
      explanation: string;
      resultArtifact?: string;
    },
    actor: string,
  ) {
    return this.db.transaction(() => {
      const operation = this.operation(operationId);
      if (!["requested", "executing"].includes(String(operation.status))) {
        if (JSON.stringify(operation.response) === JSON.stringify(response))
          return operation;
        throw new ControlError(
          "operation_complete",
          "Operation already has a terminal result",
          409,
        );
      }
      if (response.status === "completed" && !response.resultArtifact)
        throw new ControlError(
          "operation_result",
          "Completed operations require a result artifact",
        );
      this.db.exec(
        `UPDATE control_operations SET status=${sql(response.status)},response=${this.encode(response)},result_artifact=${sql(response.resultArtifact)} WHERE id=${sql(operationId)}`,
      );
      this.event(
        "OWNER_OPERATION_RESPONSE",
        actor,
        { operationId, response },
        String(operation.goal_id),
        String(operation.task_id),
      );
      if (response.status !== "executing") {
        const task = this.getTask(String(operation.task_id));
        this.db.exec(
          `UPDATE control_tasks SET status='pending',checkpoint=${this.encode({ ...task.checkpoint, summary: `${task.checkpoint?.summary ?? ""}\nOwner operation ${operationId}: ${JSON.stringify(response)}` })},revision=revision+1 WHERE id=${sql(task.id)} AND status='waiting_human'`,
        );
        if (response.resultArtifact)
          this.artifact(
            task.goalId,
            task.id,
            "owner-operation",
            response.resultArtifact,
            { operationId, response },
          );
        this.ready(task.goalId);
      }
      return this.operation(operationId);
    });
  }
  question(qid: string) {
    const r = this.db.one<Row>(
      `SELECT * FROM control_questions WHERE id=${sql(qid)}`,
    );
    if (!r) throw new ControlError("not_found", "Question not found", 404);
    return {
      id: String(r.id),
      goalId: String(r.goal_id),
      taskId: r.task_id as string | null,
      status: String(r.status),
      revision: Number(r.revision),
      request: JSON.parse(String(r.request)),
      answer: r.answer ? JSON.parse(String(r.answer)) : null,
    };
  }
  questions() {
    return this.db
      .query<Row>(
        `SELECT id FROM control_questions WHERE status='pending' ORDER BY created_at`,
      )
      .map((r) => this.question(String(r.id)));
  }
  answer(
    qid: string,
    option: string,
    revision: number,
    actor: string,
    explanation?: string,
  ) {
    return this.db.transaction(() => {
      if (this.setting("instance-maintenance"))
        throw new ControlError(
          "maintenance",
          "Decisions paused during complete backup",
          409,
        );
      const q = this.question(qid);
      if (q.status !== "pending" || q.revision !== revision)
        throw new ControlError(
          "stale_answer",
          "Question has already changed",
          409,
        );
      if (
        q.request.category === "spending" &&
        option === "approve" &&
        this.getGoal(q.goalId).config.admission
      )
        throw new ControlError(
          "admitted_configuration",
          "Spending for admitted goals cannot exceed their accepted configuration; submit a new goal",
          409,
        );
      if (!q.request.options.some((o: { id: string }) => o.id === option))
        throw new ControlError("invalid_answer", "Unknown answer option");
      if (q.request.recoveryAttemptId && option === "defer") return q;
      const answer = { option, explanation, actor };
      this.db.exec(
        `UPDATE control_questions SET status='answered',answer=${this.encode(answer)},revision=revision+1 WHERE id=${sql(qid)}`,
      );
      this.decision(
        q.goalId,
        q.taskId ?? undefined,
        q.request.category,
        { question: q.request, answer },
        actor,
      );
      if (q.taskId) {
        const t = this.getTask(q.taskId);
        if (
          q.request.recoveryAttemptId === `${t.id}:${t.generation}` &&
          option === "inspect" &&
          t.checkpoint
        )
          delete t.checkpoint.pendingTool;
        this.db.exec(
          `UPDATE control_tasks SET status='pending',checkpoint=${this.encode({ ...t.checkpoint, summary: `${t.checkpoint?.summary ?? ""}\nHuman answer: ${JSON.stringify(answer)}` })},revision=revision+1 WHERE id=${sql(q.taskId)} AND status='waiting_human'`,
        );
      }
      this.event(
        "HUMAN_INPUT_RECEIVED",
        actor,
        { questionId: qid, answer },
        q.goalId,
        q.taskId ?? undefined,
      );
      if (
        q.request.category === "spending" &&
        q.request.requestedMaxCostUsd &&
        option === "approve"
      ) {
        const g = this.getGoal(q.goalId);
        g.config.maxCostUsd = q.request.requestedMaxCostUsd;
        if (q.request.requestedRunEstimateUsd)
          g.config.estimatePerRunUsd = q.request.requestedRunEstimateUsd;
        this.db.exec(
          `UPDATE control_goals SET config=${this.encode(g.config)},revision=revision+1 WHERE id=${sql(g.id)}`,
        );
      }
      this.ready(q.goalId);
      return this.question(qid);
    });
  }
  decision(
    goalId: string | undefined,
    taskId: string | undefined,
    category: string,
    record: unknown,
    actor: string,
  ) {
    const did = id("decision");
    this.db.exec(
      `INSERT INTO control_decisions VALUES(${sql(did)},${sql(goalId)},${sql(taskId)},${sql(category)},${this.encode(record)},${sql(this.now())});INSERT INTO control_memory VALUES(${sql(did)},${sql(goalId)},${sql(category)},${this.encode(record)});`,
    );
    this.event(
      "DECISION_RECORDED",
      actor,
      { id: did, category, record },
      goalId,
      taskId,
    );
    return did;
  }
  memory(query: string, goalId?: string) {
    if (!query.trim())
      return this.db.query<Row>(
        `SELECT id,goal_id,category,text FROM control_memory ${goalId ? `WHERE goal_id=${sql(goalId)}` : ""} ORDER BY rowid DESC LIMIT 20`,
      );
    return this.db.query<Row>(
      `SELECT id,goal_id,category,text FROM control_memory WHERE control_memory MATCH ${sql(query)} ${goalId ? `AND goal_id=${sql(goalId)}` : ""} ORDER BY rank LIMIT 20`,
    );
  }
  finding(
    goalId: string,
    taskId: string | undefined,
    record: unknown,
    actor: string,
  ) {
    return this.db.transaction(() => {
      this.getGoal(goalId);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ goalId, record }))
        .digest("hex");
      const prior = this.db.one<Row>(
        `SELECT id FROM control_findings WHERE fingerprint=${sql(fingerprint)}`,
      );
      if (prior) return String(prior.id);
      const fid = id("finding");
      this.db.exec(
        `INSERT INTO control_findings(id,goal_id,task_id,fingerprint,record) VALUES(${sql(fid)},${sql(goalId)},${sql(taskId)},${sql(fingerprint)},${this.encode(record)})`,
      );
      this.event("FINDING", actor, { id: fid, record }, goalId, taskId);
      return fid;
    });
  }
  artifact(
    goalId: string,
    taskId: string | undefined,
    kind: string,
    location: string,
    metadata: unknown = {},
  ) {
    const state = dirname(this.db.path);
    if (existsSync(resolve(state, "instance.json"))) {
      const path = resolve(state, location),
        rel = relative(state, path);
      if (!rel || rel.startsWith("../") || rel === ".." || isAbsolute(rel))
        throw new ControlError(
          "artifact_path",
          "Artifacts must stay inside instance state",
        );
      const canonical = realpathSync(path);
      if (canonical !== path || lstatSync(path).isSymbolicLink())
        throw new ControlError(
          "artifact_path",
          "Artifact reference traverses a symlink",
        );
      location = rel.split("\\").join("/");
    }
    const aid = id("artifact");
    this.db.exec(
      `INSERT INTO control_artifacts VALUES(${sql(aid)},${sql(goalId)},${sql(taskId)},${sql(kind)},${sql(location)},${this.encode(metadata)})`,
    );
    return aid;
  }
  events(after = 0, goalId?: string, limit = 100) {
    return this.db
      .query<Row>(
        `SELECT * FROM control_events WHERE id>${Math.max(0, after)} ${goalId ? `AND goal_id=${sql(goalId)}` : ""} ORDER BY id LIMIT ${boundedLimit(limit)}`,
      )
      .map((r) => ({
        ...r,
        id: Number(r.id),
        payload: JSON.parse(String(r.payload)),
      }));
  }
  setGoalState(
    goalId: string,
    status: Goal["status"],
    revision: number,
    actor: string,
    result?: unknown,
  ) {
    return this.db.transaction(() => {
      const g = this.getGoal(goalId);
      if (g.revision !== revision)
        throw new ControlError("revision_conflict", "Goal changed", 409);
      if (["completed", "cancelled"].includes(g.status))
        throw new ControlError("invalid_transition", "Goal is terminal", 409);
      this.db.exec(
        `UPDATE control_goals SET status=${sql(status)},revision=revision+1,result=${this.encode(result ?? null)} WHERE id=${sql(goalId)}`,
      );
      if (status === "cancelled") {
        for (const t of this.tasks(goalId).filter(
          (t) => !["accepted", "superseded"].includes(t.status),
        )) {
          if (t.workerId) this.free(t, undefined, "cancelled");
          this.db.exec(
            `UPDATE control_tasks SET status='cancelled',revision=revision+1 WHERE id=${sql(t.id)}`,
          );
        }
        this.db.exec(
          `UPDATE control_questions SET status='cancelled',revision=revision+1 WHERE goal_id=${sql(goalId)} AND status='pending'`,
        );
      }
      this.event(`GOAL_${status.toUpperCase()}`, actor, { result }, goalId);
      if (["completed", "failed", "cancelled"].includes(status)) {
        this.outbox(status, { goalId, result });
        this.queueGoalReport(goalId);
      }
      return this.getGoal(goalId);
    });
  }
  job(kind: string, payload: unknown, due = this.clock()) {
    const jid = id("job");
    this.db.exec(
      `INSERT INTO control_jobs(id,kind,payload,due_at) VALUES(${sql(jid)},${sql(kind)},${this.encode(payload)},${due})`,
    );
    return jid;
  }
  /** Commit report intent with the terminal outcome; file writes happen later. */
  queueGoalReport(goalId: string) {
    return this.db.transaction(() => {
      const goal = this.getGoal(goalId);
      if (!["completed", "failed", "cancelled"].includes(goal.status))
        throw new ControlError(
          "report_state",
          "Reports require a terminal goal",
          409,
        );
      const existing = this.db.one<Row>(
        `SELECT id FROM control_jobs WHERE kind='report' AND status='pending' AND json_extract(payload,'$.goalId')=${sql(goalId)}`,
      );
      if (existing) return String(existing.id);
      const location = `goals/${goalId}/report.json`;
      this.setting(`report:${goalId}`, {
        schemaVersion: 1,
        state: "pending",
        location,
        goalRevision: goal.revision,
      });
      return this.job("report", { goalId });
    });
  }
  outbox(kind: string, payload: unknown) {
    return this.db.transaction(() => {
      const notificationId = id("notification");
      this.db.exec(
        `INSERT INTO control_outbox(id,kind,payload,created_at) VALUES(${sql(notificationId)},${sql(kind)},${this.encode(payload)},${sql(this.now())})`,
      );
      enqueueDeliveries(this, notificationId, kind, payload);
      return notificationId;
    });
  }
  jobs(kind?: string) {
    return this.db.query<Row>(
      `SELECT * FROM control_jobs WHERE status='pending' AND due_at<=${this.clock()} ${kind ? `AND kind=${sql(kind)}` : ""} ORDER BY due_at`,
    );
  }
  finishJob(jobId: string) {
    this.db.exec(
      `UPDATE control_jobs SET status='done' WHERE id=${sql(jobId)}`,
    );
  }
  retryJob(jobId: string, reason: string) {
    this.db.transaction(() => {
      this.db.exec(
        `UPDATE control_jobs SET attempts=attempts+1,due_at=${this.clock() + 30000},status=CASE WHEN attempts>=2 THEN 'failed' ELSE 'pending' END WHERE id=${sql(jobId)}`,
      );
      this.event("JOB_RETRY", "scheduler", { jobId, reason });
    });
  }
  setting(key: string, value?: unknown) {
    const pathSetting =
        /^publication:|^(?:publication|integration)-repair:/.test(key),
      paths = new StatePaths(dirname(this.db.path), this.db);
    const transform = (v: any, encode: boolean): any => {
      if (!v || typeof v !== "object") return v;
      if (Array.isArray(v)) return v.map((x) => transform(x, encode));
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          k === "path" && typeof x === "string"
            ? encode
              ? paths.encode(x)
              : paths.decode(x)
            : transform(x, encode),
        ]),
      );
    };
    if (value !== undefined)
      this.db.exec(
        `INSERT INTO control_settings VALUES(${sql(key)},${this.encode(pathSetting ? transform(value, true) : value)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      );
    const r = this.db.one<Row>(
      `SELECT value FROM control_settings WHERE key=${sql(key)}`,
    );
    if (!r) return undefined;
    const result = JSON.parse(String(r.value));
    return pathSetting ? transform(result, false) : result;
  }
  reserveOperation(goalId: string, label: string, parent?: Claim): string {
    return this.db.transaction(() => {
      const g = this.getGoal(goalId),
        amount = g.config.estimatePerRunUsd;
      if (g.config.executionContract?.usagePolicy.kind === "subscription") {
        const attemptId = id(`subscription_${label}`);
        let completedInvocation: string | undefined;
        if (parent) {
          const task = this.assertLease(
            parent.task.id,
            parent.workerId,
            parent.generation,
          );
          if (
            task.goalId !== goalId ||
            !["verifying", "integrating"].includes(task.status)
          )
            throw new ControlError(
              "subscription_parent",
              "Controller continuation requires its current verifying task",
              409,
            );
          const invocation = this.db.one<{
            id: string;
            usage: string | null;
            execution_session_id: string | null;
          }>(
            `SELECT id,usage,execution_session_id FROM control_attempts WHERE task_id=${sql(task.id)} AND generation=${parent.generation} AND outcome='active'`,
          );
          if (!invocation?.usage || !invocation.execution_session_id)
            throw new ControlError(
              "subscription_parent",
              "Coding completion must retain native usage and session evidence",
              409,
            );
          completedInvocation = invocation.id;
        }
        this.startAttempt(
          attemptId,
          g,
          0,
          undefined,
          "scheduler",
          label,
          completedInvocation,
        );
        this.event(
          "SUBSCRIPTION_CAPACITY_RESERVED",
          "scheduler",
          { attemptId, label },
          goalId,
        );
        return attemptId;
      }
      const spent = Number(
        this.db.one<Row>(
          `SELECT COALESCE(SUM(CASE WHEN status='settled' THEN actual ELSE amount END),0) n FROM control_budgets WHERE goal_id=${sql(goalId)} AND status!='released'`,
        )?.n,
      );
      if (spent + amount > g.config.maxCostUsd) {
        throw new ControlError(
          "budget",
          "Authorized spending budget exhausted",
          409,
        );
      }
      const budgetId = id(`budget_${label}`);
      this.db.exec(
        `INSERT INTO control_budgets VALUES(${sql(budgetId)},${sql(goalId)},NULL,${amount},NULL,'reserved')`,
      );
      this.startAttempt(budgetId, g, 0, undefined, "scheduler", label);
      this.event(
        "BUDGET_RESERVED",
        "scheduler",
        { budgetId, label, amount },
        goalId,
      );
      return budgetId;
    });
  }
  settleOperation(
    budgetId: string,
    cost?: number,
    usage?: Usage,
    outcome = "completed",
    result?: unknown,
  ) {
    return this.db.transaction(() => {
      const attempt = this.db.one<{ configuration: string; outcome: string }>(
        `SELECT configuration,outcome FROM control_attempts WHERE id=${sql(budgetId)}`,
      );
      if (!attempt)
        throw new ControlError(
          "not_found",
          "Attempt reservation not found",
          404,
        );
      if (!["active", "recovering"].includes(attempt.outcome)) return;
      const parsed = executionUsage(
        { usage, costUsd: cost },
        JSON.parse(attempt.configuration),
      );
      this.settleReservation(budgetId, knownCost(parsed));
      this.closeAttempt(budgetId, outcome, parsed, result);
    });
  }
  requestGoalHuman(goalId: string, input: QuestionInput, actor = "scheduler") {
    const request = questionSchema.parse(input);
    return this.db.transaction(() => {
      this.getGoal(goalId);
      const prior = this.questions().find(
        (q) =>
          q.goalId === goalId &&
          !q.taskId &&
          JSON.stringify(q.request) === JSON.stringify(request),
      );
      if (prior) return prior;
      const qid = id("question");
      this.db.exec(
        `INSERT INTO control_questions VALUES(${sql(qid)},${sql(goalId)},NULL,'pending',${this.encode(request)},NULL,1,${sql(this.now())})`,
      );
      this.event(
        "HUMAN_INPUT_REQUIRED",
        actor,
        { questionId: qid, request },
        goalId,
      );
      this.outbox("question", { questionId: qid, goalId, request });
      return this.question(qid);
    });
  }
  deferJob(jobId: string, delay = 30000) {
    this.db.exec(
      `UPDATE control_jobs SET due_at=${this.clock() + delay} WHERE id=${sql(jobId)}`,
    );
  }
  /** Counts all native invocations, including planning/review; unknown counters close admission when a token ceiling is configured. */
  subscriptionCapacity(goalId: string, completedInvocation?: string) {
    const goal = this.getGoal(goalId),
      contract = goal.config.executionContract;
    if (
      contract?.usagePolicy.kind !== "subscription" ||
      contract.authentication.kind !== "session"
    )
      return undefined;
    const policy = contract.usagePolicy,
      reference = contract.authentication.reference;
    const attempts = this.db.query<{
      configuration: string;
      outcome: string;
      usage: string | null;
    }>(
      `SELECT configuration,outcome,usage FROM control_attempts WHERE goal_id=${sql(goalId)}`,
    );
    const busy =
      (
        this.setting("subscription-auth-runs") as
          { authId: string; status: string }[] | undefined
      )?.some((run) => run.authId === reference && run.status !== "stopped") ||
      !!this.db.one(
        `SELECT id FROM control_attempts WHERE outcome IN ('active','recovering') ${completedInvocation ? `AND id!=${sql(completedInvocation)}` : ""} AND json_extract(configuration,'$.executionContract.authentication.kind')='session' AND json_extract(configuration,'$.executionContract.authentication.reference')=${sql(reference)} LIMIT 1`,
      );
    let reportedTokens = 0,
      unknownAttempts = 0;
    for (const attempt of attempts) {
      if (!attempt.usage) {
        unknownAttempts++;
        continue;
      }
      const usage = usageSchema.parse(JSON.parse(attempt.usage));
      if (
        usage.kind !== "subscription" ||
        usage.status === "unknown" ||
        usage.inputTokens === undefined ||
        usage.outputTokens === undefined
      )
        unknownAttempts++;
      if (usage.kind === "subscription")
        reportedTokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    }
    return {
      kind: "subscription" as const,
      authenticationReference: reference,
      activeIdentityWriter: busy,
      attempts: attempts.length,
      remainingAttempts: Math.max(0, policy.maxAttempts - attempts.length),
      maxAttempts: policy.maxAttempts,
      timeoutMs: policy.timeoutMs,
      reportedTokens,
      unknownAttempts,
      maxReportedTokens: policy.maxReportedTokens,
      admissionAllowed:
        !busy &&
        attempts.length < policy.maxAttempts &&
        (policy.maxReportedTokens === undefined ||
          (unknownAttempts === 0 && reportedTokens < policy.maxReportedTokens)),
      limitMeaning:
        "Time and attempt admission are enforced locally; native token counts are reports and cannot enforce a provider-side token ceiling",
    };
  }
  canSpend(goalId: string) {
    const g = this.getGoal(goalId);
    const amounts = this.db.one<Row>(
      `SELECT COALESCE(SUM(CASE WHEN status='settled' THEN actual ELSE 0 END),0) settled, COALESCE(SUM(CASE WHEN status IN ('reserved','unresolved') THEN amount ELSE 0 END),0) reserved FROM control_budgets WHERE goal_id=${sql(goalId)} AND status!='released'`,
    )!;
    const settled = Number(amounts.settled),
      reserved = Number(amounts.reserved);
    return {
      spent: settled + reserved,
      settledUsd: settled,
      reservedUsd: reserved,
      unresolvedUsd: Number(
        this.db.one<Row>(
          `SELECT COALESCE(SUM(amount),0) n FROM control_budgets WHERE goal_id=${sql(goalId)} AND status='unresolved'`,
        )?.n,
      ),
      remaining: g.config.maxCostUsd - settled - reserved,
      costMeaning:
        "Settled values may include provider estimates; reservations are not measured spending",
    };
  }
  createToken(actor: string, role: Principal["role"], workerId?: string) {
    const token = randomUUID() + randomUUID();
    this.redactor.register(token);
    this.db.exec(
      `INSERT INTO control_tokens VALUES(${sql(hash(token))},${sql(actor)},${sql(role)},${sql(workerId)},${role === "worker" ? this.clock() + 86400000 : "NULL"})`,
    );
    return token;
  }
  authenticate(token: string): Principal | null {
    const r = this.db.one<Row>(
      `SELECT * FROM control_tokens WHERE hash=${sql(hash(token))} AND (expires_at IS NULL OR expires_at>${this.clock()})`,
    );
    return r
      ? {
          actor: String(r.actor),
          role: r.role as Principal["role"],
          workerId: r.worker_id as string | undefined,
        }
      : null;
  }
  revokeToken(token: string) {
    this.db.exec(`DELETE FROM control_tokens WHERE hash=${sql(hash(token))}`);
  }
  idempotent(key: string, request: unknown, operation: () => unknown) {
    return this.db.transaction(() => {
      const fingerprint = hash(JSON.stringify(request));
      const old = this.db.one<Row>(
        `SELECT * FROM control_idempotency WHERE key=${sql(key)}`,
      );
      if (old) {
        if (old.request_hash !== fingerprint)
          throw new ControlError(
            "idempotency_conflict",
            "Key used for another request",
            409,
          );
        return JSON.parse(String(old.response));
      }
      const response = operation();
      this.db.exec(
        `INSERT INTO control_idempotency VALUES(${sql(key)},${sql(fingerprint)},${this.encode(response)})`,
      );
      return response;
    });
  }
}
function hash(v: string) {
  return createHash("sha256").update(v).digest("hex");
}
function boundedLimit(n: number) {
  if (!Number.isInteger(n) || n < 1 || n > 500)
    throw new ControlError("invalid_limit", "Limit must be 1–500");
  return n;
}
