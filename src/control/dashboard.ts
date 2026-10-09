import type { ControlStore } from "./store.js";
import { ControlError, type GoalConfig } from "./schema.js";
import { sql } from "../sqlite.js";
import {
  connectorHealth,
  type ConnectorDescriptor,
} from "./connectorHealth.js";
/** Projection only. Readiness probes never admit work or authenticate a provider. */
export function dashboardSnapshot(
  store: ControlStore,
  readiness?: (config: GoalConfig) => { admissible: boolean; reason?: string },
  after = "",
  connectors: ConnectorDescriptor[] = [],
  activeAfter = "",
) {
  const page = store.goals(500, after);
  const activeCursor = activeAfter
    ? store.db.one<{ id: string; created_at: string }>(
        `SELECT id,created_at FROM control_goals WHERE id=${sql(activeAfter)}`,
      )
    : undefined;
  if (activeAfter && !activeCursor)
    throw new ControlError(
      "invalid_cursor",
      "Active goal cursor does not belong to this instance",
      400,
    );
  const activePage = store.db.query<{ id: string }>(
    `SELECT id FROM control_goals WHERE status NOT IN ('completed','failed','cancelled') ${activeCursor ? `AND (created_at<${sql(activeCursor.created_at)} OR (created_at=${sql(activeCursor.created_at)} AND id<${sql(activeCursor.id)}))` : ""} ORDER BY created_at DESC,id DESC LIMIT 501`,
  );
  const activeTruncated = activePage.length > 500;
  const activeGoals = activePage
    .slice(0, 500)
    .map((row) => store.getGoal(row.id));
  const goals = [
    ...page,
    ...activeGoals.filter((goal) => !page.some((item) => item.id === goal.id)),
  ];
  const tasks = goals.flatMap((g) => store.tasks(g.id));
  const projects = store.projects().map((p) => {
    let admission = { admissible: false, reason: "Project is disabled" } as {
      admissible: boolean;
      reason?: string;
    };
    if (p.enabled) {
      try {
        admission = readiness
          ? readiness(p.config)
          : {
              admissible: p.config.backend.kind === "fake",
              reason:
                p.config.backend.kind === "fake"
                  ? undefined
                  : "Runtime readiness was not inspected",
            };
      } catch {
        admission = {
          admissible: false,
          reason:
            "Configured execution is unavailable; inspect doctor and private runtime configuration",
        };
      }
    }
    return {
      ...p,
      readiness: {
        ...admission,
        liveQualified: false,
        checksConfigured: p.config.verificationCommands.length > 0,
      },
    };
  });
  const executions = store.db
    .query<{ record: string }>(
      "SELECT record FROM (SELECT record FROM sessions ORDER BY rowid DESC LIMIT 250) UNION ALL SELECT record FROM (SELECT record FROM execution_invocations ORDER BY rowid DESC LIMIT 250)",
    )
    .map((r) => {
      const s = JSON.parse(r.record);
      return {
        id: s.id,
        taskId: s.taskId,
        goalId: s.spec.goalId,
        generation: s.generation,
        status: s.status,
        image: s.image,
        imageDigest: s.imageDigest,
        cpu: s.spec.cpu,
        memoryMiB: s.spec.memoryMiB,
        timeoutMs: s.spec.timeoutMs,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt,
        completion: s.completion
          ? { outcome: s.completion.outcome, commit: s.completion.commit }
          : undefined,
      };
    });
  return {
    goals,
    goalCursor: page.length === 500 ? page.at(-1)!.id : null,
    activeCursor: activeTruncated ? activeGoals.at(-1)!.id : null,
    activeTruncated,
    tasks,
    projects,
    backlog: projects.flatMap((project) =>
      store.listBacklog(project.id).map((entry) => {
        const dependencies = entry.dependencies.map((id) => {
          const dependency = store.getBacklog(id, project.id);
          const status = dependency.goalId
            ? store.getGoal(dependency.goalId).status
            : dependency.status;
          return {
            id,
            title: dependency.title,
            status,
            completed: status === "completed",
          };
        });
        return {
          ...entry,
          dependencyStatus: dependencies,
          blockedReasons: dependencies
            .filter((dependency) => !dependency.completed)
            .map(
              (dependency) =>
                `Dependency ${dependency.id} is ${dependency.status}`,
            ),
        };
      }),
    ),
    questions: store.questions(),
    schedules: store.schedules(),
    executions,
    budgets: Object.fromEntries(
      goals.map((g) => [
        g.id,
        store.subscriptionCapacity(g.id) ?? store.canSpend(g.id),
      ]),
    ),
    evidence: store.db.query(
      "SELECT id,task_id,commit_sha,kind,passed,generation,created_at FROM control_evidence ORDER BY created_at DESC LIMIT 2000",
    ),
    attempts: store.attempts(undefined, 500),
    ownership: store.ownership(500),
    deliveries: store.db.query(
      "SELECT connector_id,status,count(*) AS count,MIN(due_at) AS oldest_due_at FROM connector_deliveries GROUP BY connector_id,status",
    ),
    workers: store.db
      .query<{ id: string; last_seen: number; capabilities: string }>(
        "SELECT id,last_seen,capabilities FROM control_workers ORDER BY last_seen DESC,id LIMIT 500",
      )
      .map((worker) => ({
        id: worker.id,
        lastSeen: worker.last_seen,
        capabilities: JSON.parse(worker.capabilities),
        leases: store.db
          .query<{
            taskId: string;
            goalId: string;
            generation: number;
            leaseUntil: number;
            status: string;
          }>(
            `SELECT id taskId,goal_id goalId,generation,lease_until leaseUntil,status FROM control_tasks WHERE worker_id=${sql(worker.id)} AND lease_until IS NOT NULL ORDER BY lease_until DESC LIMIT 100`,
          )
          .map((lease) => ({
            ...lease,
            authority: lease.leaseUntil > store.clock() ? "live" : "expired",
          })),
      })),
    connectors: connectorHealth(store, connectors),
    health: {
      configuration: store.setting("configuration"),
      storage: store.setting("storage-maintenance-preview"),
      maintenance: store.setting("instance-maintenance") ?? false,
      startupRecoveryFault: store.setting("startup-recovery-fault") ?? null,
      qualification: "alpha_unqualified",
    },
  };
}
