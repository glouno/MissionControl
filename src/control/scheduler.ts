import { repositoryIdentity } from "./repositories.js";
import {
  withExecutionDeadline,
  executionDeadline,
  executionSignal,
} from "./executionDeadline.js";
import {
  ProviderFailure,
  classifyFailure,
  failureRecord,
  deadlineSignal,
  abortable,
  boundedCleanup,
} from "./reliability.js";
import {
  observations,
  assertObservationsClosed,
  closeObservation,
  deliveryIncident,
} from "./delivery.js";
import type { LocalDeliveryInput } from "./localDelivery.js";
import { z } from "zod";
import { executionUsage } from "./usage.js";
import { matchesGlob, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { ControlStore } from "./store.js";
import {
  createBackend,
  parseReview,
  HumanWait,
  type AgentBackend,
} from "./backends.js";
import {
  ControlError,
  validatePlan,
  type Claim,
  type Goal,
  planSchema,
} from "./schema.js";
import { instructionManifest } from "./projectContext.js";
import {
  git,
  WorkspaceManager,
  PublicationConflict,
  TaskIntegrationConflict,
} from "./workspaces.js";
import {
  repairPublication,
  retryPublicationRepair,
} from "./publicationRepair.js";
import { GithubHost, type GitHost } from "./gitHost.js";
import { runShell } from "../util.js";
import { sql } from "../sqlite.js";
import { ControlClient } from "./client.js";
import { executeClaim } from "./worker.js";
import type { VerificationResult } from "./isolatedVerifier.js";
import { reviewOutputSchema } from "./workerHandoff.js";
import {
  StorageMaintenance,
  type MaintenanceMode,
} from "./storageMaintenance.js";
export class Scheduler {
  readonly workspaces: WorkspaceManager;
  private ticking = false;
  private runningJobs = new Map<string, Promise<void>>();
  private operationAborts = new Map<string, AbortController>();
  private recovering = new Map<string, Promise<void>>();
  private closing = false;
  private shutdownAbort = new AbortController();
  private maintenanceRequested = false;
  private isolated = new Map<
    string,
    { claim: Claim; token: string; abort: AbortController; done: Promise<void> }
  >();
  private integrating: Promise<unknown> = Promise.resolve();
  private repositoryIntegrations = new Map<string, Promise<unknown>>();
  private busyResults = new Set<string>();
  private controllerWorkers = new Map<
    string,
    {
      claim?: Claim;
      pending?: Promise<Claim | null>;
      requestedGoalId?: string;
      closed: boolean;
    }
  >();
  constructor(
    readonly store: ControlStore,
    readonly stateRoot: string,
    readonly url: string,
    readonly options: {
      backend?: (g: Goal) => AgentBackend;
      asynchronousJobs?: boolean;
      gitHost?: GitHost;
      localDeliveryGate?: (input: LocalDeliveryInput) => Promise<void>;
      spawnWorkers?: boolean;
      /** Registered controller dispatches claim via the same authenticated API. */
      claimThroughApi?: boolean;
      // Trusted runtime injection only; persisted goals cannot choose host mounts
      // or upstream credentials. All model runs, including planning, use it.
      isolatedBackend?: (g: Goal) => AgentBackend;
      isolatedVerifier?: (
        claim: Claim,
        source: string,
      ) => Promise<VerificationResult>;
      executionMaintenance?: () => Promise<unknown>;
      recoverAttempt?: (
        taskId: string,
        generation: number,
        signal: AbortSignal,
      ) => Promise<void>;
      recoverOperation?: (
        attemptId: string,
        signal: AbortSignal,
      ) => Promise<void>;
      imageMaintenance?: (apply: boolean) => Promise<unknown>;
      storagePolicy?: import("./storage.js").StorageManager["policy"];
    } = {},
  ) {
    this.workspaces = new WorkspaceManager(
      stateRoot,
      existsSync(join(stateRoot, "instance.json")) ? store.db : undefined,
      options.storagePolicy,
    );
  }
  backend(g: Goal) {
    if (g.config.backend.kind !== "fake" && !this.options.isolatedBackend)
      throw new ControlError(
        "execution_environment",
        "Real execution requires a configured isolated runtime",
        409,
      );
    return this.options.backend?.(g) ?? createBackend(g.config.backend);
  }
  authorizeControllerWorker(workerId: string) {
    if (this.controllerWorkers.has(workerId))
      throw new ControlError(
        "worker_registration",
        "Dispatch identity already registered",
        409,
      );
    this.store.registerWorker(workerId);
    this.controllerWorkers.set(workerId, { closed: false });
  }
  revokeControllerWorker(workerId: string) {
    this.controllerWorkers.delete(workerId);
  }
  async claimControllerWorker(
    workerId: string,
    goalId?: string,
  ): Promise<Claim | null> {
    const dispatch = this.controllerWorkers.get(workerId);
    if (!dispatch || dispatch.closed)
      throw new ControlError(
        "worker_registration",
        "Worker has no controller-owned dispatch",
        403,
      );
    if (dispatch.pending) {
      if (goalId !== dispatch.requestedGoalId)
        throw new ControlError(
          "worker_scope",
          "Pending dispatch must be retried with the same goal scope",
          403,
        );
      return dispatch.pending;
    }
    if (dispatch.claim) {
      const claim = dispatch.claim;
      if (goalId && goalId !== claim.goal.id)
        throw new ControlError(
          "worker_scope",
          "Dispatch is bound to another goal",
          403,
        );
      this.store.assertLease(claim.task.id, workerId, claim.generation);
      return claim;
    }
    // Complete backups close admission before draining the current tick.
    // Do not claim work that would then be unable to transition or release.
    if (this.maintenanceRequested || this.store.setting("instance-maintenance"))
      return null;
    dispatch.requestedGoalId = goalId;
    dispatch.pending = (async () => {
      const claim = this.store.claimNextTask(workerId, { goalId });
      if (!claim) {
        dispatch.closed = true;
        return null;
      }
      try {
        // Backend policy must be valid before the source/environment is prepared.
        if (this.options.isolatedBackend)
          this.options.isolatedBackend(claim.goal);
        else this.backend(claim.goal);
        const pressure = await this.workspaces.storage.pressure();
        if (!pressure.admissionAllowed)
          throw new ControlError(
            "storage_pressure",
            "Free storage is below the configured reserve",
            409,
          );
        const workspace = await withExecutionDeadline(
          claim.runtime!.deadlineAt,
          this.shutdownAbort.signal,
          () => this.workspaces.prepareTask(claim.goal, claim.task),
        );
        if (
          this.controllerWorkers.get(workerId) !== dispatch ||
          dispatch.closed
        )
          throw new ControlError(
            "worker_registration",
            "Dispatch was revoked during workspace preparation",
            403,
          );
        this.store.assertLease(claim.task.id, workerId, claim.generation);
        dispatch.claim = { ...claim, workspace };
        return dispatch.claim;
      } catch (error) {
        dispatch.closed = true;
        if (claim.runtime && this.store.clock() >= claim.runtime.deadlineAt) {
          this.store.db.exec(
            `UPDATE control_tasks SET lease_until=${this.store.clock() - 1} WHERE id=${sql(claim.task.id)}`,
          );
          this.store.reconcileExpired(claim.task.id, claim.generation);
          throw error;
        }
        this.store.release(
          claim.task.id,
          workerId,
          claim.generation,
          error instanceof ControlError && error.code === "storage_pressure"
            ? "waiting_provider"
            : "retry_wait",
          (error as Error).message,
        );
        throw error;
      }
    })();
    try {
      return await dispatch.pending;
    } finally {
      dispatch.pending = undefined;
    }
  }
  async tick() {
    if (this.closing || this.ticking || this.maintenanceRequested) return;
    this.ticking = true;
    this.store.setting("scheduler-heartbeat", {
      startedAt: this.store.clock(),
    });
    try {
      for (const goal of this.store.goals(500)) {
        const threshold = goal.config.budgetAlertUsd;
        if (
          threshold === undefined ||
          this.store.setting(`budget-alert:${goal.id}`)
        )
          continue;
        const budget = this.store.canSpend(goal.id);
        if (budget.settledUsd >= threshold) {
          this.store.setting(`budget-alert:${goal.id}`, {
            thresholdUsd: threshold,
            settledUsd: budget.settledUsd,
          });
          this.store.event(
            "BUDGET_ALERT",
            "scheduler",
            {
              thresholdUsd: threshold,
              settledUsd: budget.settledUsd,
              reportedUsd: budget.reportedUsd,
              estimatedUsd: budget.estimatedUsd,
            },
            goal.id,
          );
        }
      }
      for (const attempt of this.store.db
        .query<{ id: string; goal_id: string; task_id: string | null }>(
          "SELECT id,goal_id,task_id FROM control_attempts WHERE outcome='active'",
        )
        .map((a) => ({
          id: a.id,
          goalId: a.goal_id,
          taskId: a.task_id,
          runtime: this.store.reliability.runtime(a.id),
        }))) {
        const r = attempt.runtime;
        if (!r) continue;
        const goal = this.store.getGoal(attempt.goalId),
          idle = this.store.clock() - r.lastProgressAt;
        if (
          idle >= goal.config.noProgressWarningMs &&
          !this.store.setting(`stall-warning:${attempt.id}`)
        ) {
          this.store.recordFailure(
            goal.id,
            failureRecord("service", {
              message:
                "Execution has no meaningful progress; inspect the attempt timeline.",
            }),
            attempt.id,
            "controller",
            false,
          );
          this.store.setting(`stall-warning:${attempt.id}`, true);
        }
        if (
          idle >= goal.config.noProgressTimeoutMs ||
          this.store.clock() >= r.deadlineAt
        ) {
          if (attempt.taskId) {
            const task = this.store.getTask(String(attempt.taskId));
            if (task.workerId) {
              this.store.db.exec(
                `UPDATE control_tasks SET lease_until=${this.store.clock() - 1} WHERE id=${sql(task.id)}`,
              );
            }
          } else
            this.operationAborts
              .get(attempt.id)
              ?.abort(
                new Error(
                  "Controller operation deadline or no-progress limit expired",
                ),
              );
        }
      }
      for (const t of this.store.expired()) {
        const isolated = this.isolated.get(t.id);
        if (isolated) {
          this.store.reconcileExpired(t.id, t.generation);
          isolated.abort.abort(new Error("Task deadline or lease expired"));
          void isolated.done;
          continue;
        }
        this.store.reconcileExpired(t.id, t.generation);
      }
      for (const attempt of this.store.db
        .query<{ id: string; task_id: string; goal_id: string }>(
          "SELECT id,task_id,goal_id FROM control_attempts WHERE outcome='recovering' AND task_id IS NOT NULL",
        )
        .map((a) => ({
          id: a.id,
          taskId: a.task_id,
          goalId: a.goal_id,
          runtime: this.store.reliability.runtime(a.id),
        }))) {
        const task = this.store.getTask(String(attempt.taskId));
        if (
          this.recovering.has(attempt.id) ||
          attempt.runtime?.cleanupState === "blocked"
        )
          continue;
        const job = Promise.resolve()
          .then(() =>
            boundedCleanup(
              async (cleanup) => {
                const active = this.isolated.get(task.id);
                active?.abort.abort(new Error("Attempt recovery"));
                // The adapter must finish all import/checkpoint callbacks before ownership is released.
                if (active) await abortable(active.done, cleanup);
                if (this.options.recoverAttempt)
                  await abortable(
                    this.options.recoverAttempt(
                      task.id,
                      task.generation,
                      cleanup,
                    ),
                    cleanup,
                  );
                else if (
                  !active &&
                  this.store.getGoal(task.goalId).config.backend.kind !== "fake"
                )
                  throw new ControlError(
                    "cleanup_blocked",
                    "Runtime inspection is required",
                    409,
                  );
                let safe = false;
                if (
                  task.checkpoint?.commit &&
                  !task.checkpoint.pendingTool &&
                  !this.store.setting(`result-request:${attempt.id}`)
                ) {
                  try {
                    const path = this.workspaces.taskPath(task);
                    safe =
                      (await git(path, ["rev-parse", "HEAD"])) ===
                        task.checkpoint.commit &&
                      !(await git(path, ["status", "--porcelain"]));
                  } catch {
                    /* Retain the recovery decision if the checkpoint cannot be reproduced. */
                  }
                }
                cleanup.throwIfAborted();
                this.store.finishAttemptRecovery(
                  task.id,
                  task.generation,
                  safe,
                );
              },
              60000,
              this.store.reliability.cleanupSignal(attempt.id),
            ),
          )
          .catch(() => {
            const runtime = this.store.reliability.runtime(attempt.id)!;
            runtime.cleanupState = "blocked";
            this.store.reliability.saveRuntime(runtime);
            this.store.recordFailure(
              task.goalId,
              failureRecord("cleanup_blocked"),
              attempt.id,
            );
          })
          .then(() => {})
          .finally(() => this.recovering.delete(attempt.id));
        this.recovering.set(attempt.id, job);
      }
      for (const attempt of this.store.db.query<{
        id: string;
        goal_id: string;
      }>(
        "SELECT id,goal_id FROM control_attempts WHERE outcome='recovering' AND task_id IS NULL",
      )) {
        if (
          this.recovering.has(attempt.id) ||
          this.operationAborts.has(attempt.id) ||
          this.store.reliability.runtime(attempt.id)?.cleanupState === "blocked"
        )
          continue;
        const done = Promise.resolve()
          .then(async () => {
            await boundedCleanup(
              async (signal) => {
                if (this.options.recoverOperation)
                  await abortable(
                    this.options.recoverOperation(attempt.id, signal),
                    signal,
                  );
                else if (
                  this.store.getGoal(attempt.goal_id).config.backend.kind !==
                  "fake"
                )
                  throw new Error("Controller runtime inspection is required");
                signal.throwIfAborted();
                this.store.finishOperationRecovery(attempt.id);
              },
              60000,
              this.store.reliability.cleanupSignal(attempt.id),
            );
          })
          .catch(() => {
            const runtime = this.store.reliability.runtime(attempt.id)!;
            runtime.cleanupState = "blocked";
            this.store.reliability.saveRuntime(runtime);
            this.store.recordFailure(
              attempt.goal_id,
              failureRecord("cleanup_blocked"),
              attempt.id,
            );
          })
          .finally(() => this.recovering.delete(attempt.id));
        this.recovering.set(attempt.id, done);
      }
      for (const active of this.isolated.values())
        if (
          ["cancelled", "paused"].includes(
            this.store.getGoal(active.claim.goal.id).status,
          )
        )
          active.abort.abort(new Error("Goal execution stopped"));
      if (!this.runningJobs.has("maintenance")) {
        const run = () => this.maintainStorage();
        if (this.options.asynchronousJobs) {
          const job = run()
            .catch(() =>
              this.store.event("MAINTENANCE_FAILED", "controller", {}),
            )
            .finally(() => this.runningJobs.delete("maintenance"));
          this.runningJobs.set("maintenance", job);
        } else await run();
      }
      this.runSchedules();
      for (const job of this.store.jobs()) {
        if (
          this.isolated.size + this.runningJobs.size + this.recovering.size >=
          4
        )
          break;
        if (this.runningJobs.has(String(job.id))) continue;
        const goalId = JSON.parse(String(job.payload)).goalId;
        if (
          [...this.runningJobs.keys()].some(
            (id) =>
              this.store.db.one<{ payload: string }>(
                `SELECT payload FROM control_jobs WHERE id=${sql(id)}`,
              )?.payload &&
              JSON.parse(
                this.store.db.one<{ payload: string }>(
                  `SELECT payload FROM control_jobs WHERE id=${sql(id)}`,
                )!.payload,
              ).goalId === goalId,
          )
        )
          continue;
        const run = () => this.runJob(job);
        if (this.options.asynchronousJobs) {
          const done = Promise.resolve()
            .then(run)
            .catch((error) =>
              this.store.event("JOB_DISPATCH_ERROR", "scheduler", {
                reason: classifyFailure(error).message,
              }),
            )
            .finally(() => this.runningJobs.delete(String(job.id)));
          this.runningJobs.set(String(job.id), done);
        } else await run();
      }
      for (const goal of this.store
        .goals(500)
        .filter((g) => g.status === "running")) {
        const tasks = this.store.tasks(goal.id);
        if (
          !tasks.some((t) => t.workerId) &&
          tasks.some((t) => t.status === "failed")
        ) {
          const existing = this.store.db.one<Record<string, unknown>>(
            `SELECT id FROM control_jobs WHERE kind='replan' AND status='pending' AND json_extract(payload,'$.goalId')=${sql(goal.id)}`,
          );
          if (!existing) {
            if (goal.planRevision > goal.config.maxReplans)
              this.store.setGoalState(
                goal.id,
                "failed",
                goal.revision,
                "scheduler",
                { reason: "Execution and replanning limits exhausted" },
              );
            else this.store.job("replan", { goalId: goal.id });
          }
        }
        const ready = tasks.some((t) => t.status === "ready");
        const subscription = this.store.subscriptionCapacity(goal.id);
        if (
          ready &&
          subscription &&
          !subscription.admissionAllowed &&
          !subscription.activeIdentityWriter
        )
          this.store.requestGoalHuman(goal.id, {
            question: "Inspect subscription limits before further execution?",
            reason:
              "The admitted invocation count or reported token limit is exhausted, or token usage is unknown. Retain this goal and its evidence; submit new work only after reviewing usage and installation authority.",
            category: "policy",
            options: [
              { id: "inspect", label: "Inspect limits and usage" },
              { id: "defer", label: "Keep pending" },
            ],
          });
        const budget = this.store.canSpend(goal.id);
        if (
          ready &&
          !subscription &&
          budget.remaining < goal.config.estimatePerRunUsd
        )
          this.store.requestGoalHuman(goal.id, {
            question: "Authorize more goal spending?",
            reason:
              "No new task can fit within the remaining authorized budget.",
            options: [
              { id: "approve", label: "Increase the budget" },
              { id: "reject", label: "Keep existing limits" },
            ],
            category: "spending",
            requestedMaxCostUsd:
              goal.config.maxCostUsd + goal.config.estimatePerRunUsd,
          });
      }
      if (this.options.spawnWorkers !== false) {
        const capacity =
          4 - this.isolated.size - this.runningJobs.size - this.recovering.size;
        for (let i = 0; i < capacity; i++) {
          if (!this.options.asynchronousJobs) {
            await this.dispatchWorker();
            continue;
          }
          const key = `dispatch:${randomUUID()}`;
          const job = Promise.resolve()
            .then(() => this.dispatchWorker())
            .catch((error) => {
              this.store.event("WORKER_DISPATCH_FAILED", "scheduler", {
                reason: classifyFailure(error).message,
              });
            })
            .finally(() => this.runningJobs.delete(key));
          this.runningJobs.set(key, job);
        }
      }
    } finally {
      this.store.setting("scheduler-heartbeat", {
        completedAt: this.store.clock(),
      });
      this.ticking = false;
    }
  }
  private async dispatchWorker() {
    if (this.closing || this.maintenanceRequested) return;
    const workerId = `worker_${randomUUID()}`;
    this.authorizeControllerWorker(workerId);
    const token = this.store.createToken(workerId, "worker", workerId);
    let claim: Claim | null = null;
    try {
      claim = this.options.claimThroughApi
        ? await new ControlClient(this.url, token).claim(workerId)
        : await this.claimControllerWorker(workerId);
      if (!claim) {
        this.store.revokeToken(token);
        this.revokeControllerWorker(workerId);
        return;
      }
      const admitted = claim;
      {
        const backend = this.options.isolatedBackend
          ? this.options.isolatedBackend(claim.goal)
          : this.backend(claim.goal);
        const abort = new AbortController();
        // Defer to register ownership before the adapter starts asynchronous work.
        const done = Promise.resolve()
          .then(() =>
            executeClaim(
              new ControlClient(this.url, token),
              admitted,
              this.stateRoot,
              backend,
              abort.signal,
              this.workspaces,
            ),
          )
          .catch((error) => {
            this.store.event(
              "ISOLATED_WORKER_ERROR",
              "scheduler",
              { reason: (error as Error).message },
              admitted.goal.id,
              admitted.task.id,
            );
          })
          .finally(() => {
            this.isolated.delete(admitted.task.id);
            this.store.revokeToken(token);
            this.revokeControllerWorker(workerId);
          });
        this.isolated.set(claim.task.id, { claim, token, abort, done });
        return;
      }
    } catch (e) {
      this.store.revokeToken(token);
      this.revokeControllerWorker(workerId);
      if (claim)
        this.store.release(
          claim.task.id,
          workerId,
          claim.generation,
          "retry_wait",
          (e as Error).message,
        );
      else return;
    }
  }
  private async maintainStorage() {
    const maintenanceAt = Number(
      this.store.setting("storage-maintenance-at") ?? 0,
    );
    if (this.store.clock() - maintenanceAt >= 3600000) {
      const configured =
        this.store.setting("storage-maintenance-mode") ?? "preview";
      if (!["preview", "workspaces", "branches"].includes(configured))
        throw new ControlError(
          "storage_policy",
          "Unknown storage maintenance mode",
        );
      const preview = await new StorageMaintenance(
        this.workspaces.storage,
        this.store,
      ).maintain(configured as MaintenanceMode);
      this.store.setting("storage-maintenance-preview", preview);
      if (this.options.executionMaintenance)
        this.store.setting(
          "execution-maintenance-preview",
          await this.options.executionMaintenance(),
        );
      if (this.options.imageMaintenance)
        this.store.setting(
          "image-maintenance-preview",
          await this.options.imageMaintenance(configured !== "preview"),
        );
      this.store.setting("storage-maintenance-at", this.store.clock());
      const previousPressure =
        this.store.setting("storage-pressure-active") === true;
      const pressure = !preview.pressure.admissionAllowed;
      if (pressure !== previousPressure) {
        this.store.db.transaction(() => {
          this.store.setting("storage-pressure-active", pressure);
          this.store.event(
            pressure ? "STORAGE_PRESSURE" : "STORAGE_RECOVERED",
            "maintenance",
            preview.pressure,
          );
          this.store.outbox("storage", {
            message: pressure
              ? "New workspace admission is paused: free disk is below the configured storage reserve. Inspect storage maintenance before reclaiming data."
              : "Free disk has recovered above the configured storage reserve; new workspace admission can resume.",
            pressure: preview.pressure,
          });
        });
      }
    }
  }
  private async runJob(job: any) {
    const { goalId } = JSON.parse(String(job.payload)),
      goal = this.store.getGoal(goalId);
    const key = `controller-job:${job.id}`;
    const prior = this.store.setting(key);
    if (prior?.status === "running") {
      this.store.recordFailure(goalId, failureRecord("interrupted"));
      if (!["paused", "completed", "cancelled", "failed"].includes(goal.status))
        this.store.setGoalState(goalId, "paused", goal.revision, "controller", {
          reason:
            "Interrupted controller job requires source and effect inspection before resume",
        });
      this.store.setting(`pause:${goalId}`, {
        version: 1,
        actor: "controller",
        category: "interrupted",
        reason:
          "Interrupted controller job requires source and effect inspection",
        recordedAt: this.store.clock(),
        nextAction:
          "Inspect retained source and publication effects, then use revision-checked recovery",
      });
      this.store.deferJob(String(job.id));
      return;
    }
    // Each dispatch has one envelope including repository preparation and publication.
    // Restart retains incomplete intent and requires source/effect reconciliation.
    const record = {
      version: 1,
      jobId: job.id,
      goalId,
      phase: job.kind,
      startedAt: this.store.clock(),
      deadlineAt: this.store.clock() + goal.config.timeoutMs,
      status: "running",
      previous:
        prior?.status === "running"
          ? { startedAt: prior.startedAt, deadlineAt: prior.deadlineAt }
          : undefined,
    };
    this.store.setting(key, record);
    let reconciled = true;
    try {
      await withExecutionDeadline(
        record.deadlineAt,
        this.shutdownAbort.signal,
        async () => {
          const signal = executionSignal()!;
          const operation = this.runJobWithinDeadline(job);
          try {
            await abortable(operation, signal);
          } catch (error) {
            if (signal.aborted) {
              this.store.recordFailure(goalId, failureRecord("deadline"));
              const current = this.store.getGoal(goalId);
              if (
                !["completed", "failed", "cancelled", "paused"].includes(
                  current.status,
                )
              )
                this.store.setGoalState(
                  goalId,
                  "paused",
                  current.revision,
                  "controller",
                  {
                    reason:
                      "Controller deadline expired; inspect retained effects before recovery",
                  },
                );
              try {
                await boundedCleanup((cleanup) =>
                  abortable(
                    operation.then(
                      () => {},
                      () => {},
                    ),
                    cleanup,
                  ),
                );
              } catch (cleanupError) {
                reconciled = false;
                this.store.recordFailure(
                  goalId,
                  failureRecord("cleanup_blocked"),
                );
                throw cleanupError;
              }
            }
            throw error;
          }
        },
      );
    } finally {
      this.store.setting(key, {
        ...record,
        status: reconciled ? "settled" : "running",
        cleanupState: reconciled ? "stopped" : "blocked",
        endedAt: reconciled ? this.store.clock() : undefined,
      });
    }
  }

  private async runJobWithinDeadline(job: any) {
    const payload = JSON.parse(String(job.payload));
    try {
      const g = this.store.getGoal(payload.goalId);
      if (job.kind === "report") {
        await this.writeGoalReport(g.id);
        this.store.finishJob(String(job.id));
        return;
      }
      if (["cancelled", "completed", "failed"].includes(g.status)) {
        // Completion and filesystem lifecycle cannot share a transaction.
        // Replay pending publication intent before retiring its durable job.
        if (g.status === "completed" && job.kind === "publish")
          await this.publish(g.id);
        this.store.finishJob(String(job.id));
        return;
      }
      if (g.status === "paused") {
        this.store.deferJob(String(job.id));
        return;
      }
      if (job.kind === "plan") await this.plan(payload.goalId);
      else if (job.kind === "publish") await this.publish(payload.goalId);
      else if (job.kind === "replan") await this.replan(payload.goalId);
      executionSignal()?.throwIfAborted();
      this.store.finishJob(String(job.id));
    } catch (e) {
      if (executionSignal()?.aborted) {
        this.store.deferJob(String(job.id));
        return;
      }
      const goal = this.store.getGoal(payload.goalId);
      if (job.kind === "report" || goal.status === "completed") {
        // Terminal domain effects are durable. A filesystem/lifecycle retry
        // can never fail or reexecute already-completed work.
        this.store.deferJob(String(job.id), 30000);
        this.store.event(
          "TERMINAL_EVIDENCE_RETRY",
          "scheduler",
          { jobId: job.id, kind: job.kind },
          goal.id,
        );
        return;
      }
      if (
        job.kind === "publish" &&
        e instanceof ControlError &&
        [
          "checks_pending",
          "checks_failed",
          "stale_base",
          "freshness_policy",
          "blocking_observation",
        ].includes(e.code)
      ) {
        const candidate = (this.store.setting(`publication:${goal.id}`) ??
          this.store.setting(`local-delivery:${goal.id}`)) as any;
        deliveryIncident(
          this.store,
          goal.id,
          candidate?.commit ?? "unknown",
          candidate?.targetSha ?? "unknown",
          e.code,
          e.message,
        );
      }
      if (e instanceof ProviderFailure) {
        this.store.recordFailure(
          goal.id,
          e.failure,
          (e as any).reliabilityAttemptId,
        );
        // Eligible explicit provider rejections already consumed retryProvider's
        // persisted allowance within this operation. A new job dispatch would
        // allocate new authority, reset that allowance and replay uncertain POSTs.
        const current = this.store.getGoal(goal.id);
        if (
          !["paused", "completed", "cancelled", "failed"].includes(
            current.status,
          )
        ) {
          this.store.setGoalState(
            goal.id,
            "paused",
            current.revision,
            "scheduler",
            {
              reason: e.failure.message,
            },
          );
          this.store.setting(`pause:${goal.id}`, {
            version: 1,
            actor: "scheduler",
            category: e.failure.kind,
            reason: e.failure.message,
            recordedAt: this.store.clock(),
            nextAction:
              "Inspect the failed operation and usage before revision-checked recovery",
          });
        }
        this.store.deferJob(String(job.id));
      } else if (e instanceof HumanWait) {
        this.store.requestGoalHuman(goal.id, e.request);
        this.store.deferJob(String(job.id));
      } else if (e instanceof ControlError && e.code === "budget") {
        this.store.requestGoalHuman(goal.id, {
          question: "Authorize an additional run budget?",
          reason: "Current authorized spending is exhausted.",
          options: [
            { id: "approve", label: "Increase the authorized budget" },
            { id: "reject", label: "Keep the current budget" },
          ],
          category: "spending",
          requestedMaxCostUsd:
            goal.config.maxCostUsd + goal.config.estimatePerRunUsd,
        });
        this.store.deferJob(String(job.id));
      } else if (
        e instanceof ControlError &&
        [
          "checks_pending",
          "checks_failed",
          "blocking_observation",
          "active_work",
          "merge_pending",
          "fetch_pending",
          "stale_base",
          "freshness_policy",
          "storage_pressure",
          "repair_unresolved",
          "repair_retry",
        ].includes(e.code)
      ) {
        this.store.deferJob(String(job.id));
      } else {
        this.store.retryJob(String(job.id), (e as Error).message);
        if (Number(job.attempts) >= 2)
          this.store.setGoalState(
            goal.id,
            "failed",
            goal.revision,
            "scheduler",
            { reason: (e as Error).message },
          );
      }
    }
  }
  async runBackend(
    g: Goal,
    context: Parameters<AgentBackend["run"]>[0],
    label: string,
  ) {
    const parent =
      context.claim.generation > 0 &&
      ["verifying", "integrating"].includes(context.claim.task.status)
        ? context.claim
        : undefined;
    const budget = this.store.reserveOperation(g.id, label, parent);
    let cost: number | undefined, usage: import("./usage.js").Usage | undefined;
    let outcome = "failed",
      result: unknown;
    try {
      const backend = this.options.isolatedBackend
        ? this.options.isolatedBackend(g)
        : this.backend(g);
      if (
        context.disableTaskHandoffs &&
        g.config.backend.kind !== "fake" &&
        !this.options.isolatedBackend
      )
        throw new ControlError(
          "repair_environment",
          "Publication coding repair requires the isolated runtime",
          409,
        );
      const runtime = this.store.reliability.runtime(budget)!;
      const deadlineAt = Math.min(
        runtime.deadlineAt,
        context.deadlineAt ?? Infinity,
        executionDeadline() ?? Infinity,
      );
      runtime.deadlineAt = deadlineAt;
      this.store.reliability.saveRuntime(runtime);
      const abort = new AbortController();
      this.operationAborts.set(budget, abort);
      const signal = deadlineSignal(
        deadlineAt,
        AbortSignal.any([
          context.signal,
          this.shutdownAbort.signal,
          abort.signal,
          ...(executionSignal() ? [executionSignal()!] : []),
        ]),
      );
      let cleanupSignal: AbortSignal | undefined;
      const cleanup = () =>
        (cleanupSignal ??= this.store.reliability.cleanupSignal(budget));
      const running = backend.run({
        ...context,
        cleanupSignal: cleanup,
        signal,
        deadlineAt,
        onProgress: (kind) => {
          const r = this.store.reliability.runtime(budget);
          if (r && this.store.clock() - r.lastProgressAt >= 1000)
            this.store.reliability.progress(budget, kind);
        },
        prompt: [
          context.prompt,
          ...(g.config.admission?.contexts ?? []).map(
            (c) =>
              `Selected private context ${c.path} (sha256 ${c.hash}):\n${c.content}`,
          ),
          ...(g.config.admission?.prompts ?? []).map(
            (p) =>
              `Configured instruction ${p.id} (sha256 ${p.hash}):\n${p.content}`,
          ),
        ].join("\n"),
        ...(context.mode === "review"
          ? { outputSchema: reviewOutputSchema }
          : {}),
        operationReservationId: budget,
      });
      let output;
      try {
        output = await abortable(running, signal);
      } catch (error) {
        if (signal.aborted)
          await boundedCleanup(
            async (cleanup) => {
              await abortable(
                running.catch(() => {}),
                cleanup,
              );
            },
            60000,
            cleanup(),
          );
        throw error;
      }
      signal.throwIfAborted();
      cost = output.costUsd;
      usage = executionUsage(output, g.config);
      outcome = "completed";
      result = {
        executionSessionId: output.executionSessionId,
        environmentDigest: output.environmentDigest,
      };
      return output;
    } catch (e) {
      this.store.recordFailure(g.id, classifyFailure(e), budget);
      if (e instanceof Error)
        Object.assign(e, { reliabilityAttemptId: budget });
      cost = (e as any).costUsd;
      try {
        usage = executionUsage(e as any, g.config);
      } catch {
        usage = executionUsage({}, g.config);
        cost = undefined;
      }
      throw e;
    } finally {
      this.operationAborts.delete(budget);
      const failure = this.store.reliability.runtime(budget)?.failure;
      if (failure?.kind === "cleanup_blocked") {
        this.store.db.exec(
          `UPDATE control_attempts SET outcome='recovering',usage=COALESCE(${usage ? sql(JSON.stringify(usage)) : "NULL"},usage) WHERE id=${sql(budget)} AND outcome='active'`,
        );
        const r = this.store.reliability.runtime(budget);
        if (r) {
          r.cleanupState = "blocked";
          this.store.reliability.saveRuntime(r);
        }
      } else this.store.settleOperation(budget, cost, usage, outcome, result);
    }
  }
  async plan(goalId: string) {
    const g = this.store.getGoal(goalId);
    if (g.planRevision > 0) return;
    const workspace = await this.workspaces.prepareGoal(g);
    const context = {
      ...this.store.projectContext(g.id),
      base: this.workspaces.repositories.record(g.id),
      ...(await instructionManifest(g, workspace)),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), g.config.timeoutMs);
    try {
      const claim = this.plannerClaim(g);
      const output = await this.runBackend(
        g,
        {
          claim,
          workspace,
          mode: "plan",
          outputSchema: z.toJSONSchema(planSchema, { target: "draft-7" }),
          signal: controller.signal,
          onCheckpoint: async () => {},
          prompt: `Produce the smallest useful task plan. For an explicitly defined single-task goal, return one task without rediscovering or redesigning the whole project. Limit investigation to files needed to identify scope, paths and checks; keep the final plan concise. Investigate this repository and decompose the goal into a bounded DAG. Workers implement source and run required checks, then return candidates. MissionControl performs separate independent review and integration; do not assign workers subagent startup or reviewer infrastructure. Preserve required repository checks. Return only JSON {"tasks":[{"key":"...","title":"...","description":"...","dependencies":[],"acceptanceCriteria":["..."],"allowedPaths":["..."],"verificationCommands":[]}]}. Goal: ${g.config.description}\nRequired checks: ${JSON.stringify(g.config.verificationCommands)}\nProject context: ${JSON.stringify(context)}`,
        },
        "planning",
      );
      const plan = JSON.parse(
        output.text
          .trim()
          .replace(/^```(?:json)?\s*/, "")
          .replace(/\s*```$/, ""),
      );
      validatePlan(plan);
      this.store.installPlan(g.id, plan, g.revision, "planner");
      this.store.decision(
        g.id,
        undefined,
        "planning",
        { plan, costUsd: output.costUsd },
        "planner",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  plannerClaim(g: Goal): Claim {
    return {
      goal: g,
      workerId: "planner",
      generation: 0,
      task: {
        id: "planning",
        goalId: g.id,
        key: "planning",
        status: "running",
        generation: 0,
        attempts: 0,
        revision: 1,
        workerId: "planner",
        leaseUntil: null,
        retryAt: null,
        createdAt: g.createdAt,
        spec: {
          key: "planning",
          title: g.config.title,
          description: g.config.description,
          dependencies: [],
          acceptanceCriteria: ["Valid bounded DAG"],
          allowedPaths: ["**"],
          verificationCommands: [],
          capability: "researcher",
          priority: 0,
          resources: [],
          cpuUnits: 2,
          memoryMiB: 2048,
        },
      },
    };
  }
  async replan(goalId: string) {
    const g = this.store.getGoal(goalId);
    if (this.store.tasks(goalId).some((t) => t.workerId))
      throw new ControlError(
        "active_work",
        "Waiting for workers to checkpoint before replanning",
        409,
      );
    const prior = this.store
      .tasks(goalId)
      .filter((t) => t.status === "accepted")
      .map((t) => t.spec);
    const c = this.plannerClaim(g);
    const output = await this.runBackend(
      g,
      {
        claim: c,
        workspace: this.workspaces.goalPath(g),
        mode: "plan",
        signal: AbortSignal.timeout(g.config.timeoutMs),
        onCheckpoint: async () => {},
        prompt: `Revise the goal plan after these events: ${JSON.stringify(this.store.events(0, g.id).slice(-20))}. Preserve these accepted contracts exactly: ${JSON.stringify(prior)}. Workers implement source and run required checks, then return candidates. MissionControl performs separate independent review and integration; do not assign workers subagent startup or reviewer infrastructure. Return JSON {tasks:[...]} with bounded tasks, dependencies, acceptanceCriteria, allowedPaths, verificationCommands. Goal: ${g.config.description}`,
      },
      "replanning",
    );
    this.store.installPlan(
      g.id,
      JSON.parse(output.text),
      g.revision,
      "replanner",
    );
  }
  async result(
    taskId: string,
    workerId: string,
    generation: number,
    result: unknown,
  ) {
    const runtime = this.store.reliability.runtime(`${taskId}:${generation}`);
    return withExecutionDeadline(
      runtime?.deadlineAt ?? Date.now() + 30000,
      this.shutdownAbort.signal,
      () => this.resultWithinDeadline(taskId, workerId, generation, result),
    );
  }
  private async resultWithinDeadline(
    taskId: string,
    workerId: string,
    generation: number,
    result: unknown,
  ) {
    const key = `${taskId}:${generation}`;
    const replay = this.replayResult(taskId, workerId, generation, result);
    if (replay !== undefined) return replay;
    if (this.busyResults.has(key))
      throw new ControlError(
        "duplicate_result",
        "Result integration is already running",
        409,
      );
    this.busyResults.add(key);
    try {
      const task = this.store.assertLease(taskId, workerId, generation),
        goal = this.store.getGoal(task.goalId);
      if (task.status !== "verifying")
        throw new ControlError(
          "invalid_transition",
          "Task must enter verification first",
          409,
        );
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(result))
        .digest("hex");
      const previous = this.store.setting(`result-request:${key}`);
      if (previous && previous.fingerprint !== fingerprint)
        throw new ControlError(
          "idempotency_conflict",
          "Attempt result differs from the admitted request",
          409,
        );
      if (!previous)
        this.store.setting(`result-request:${key}`, { fingerprint, workerId });
      const commit = await git(this.workspaces.taskPath(task), [
        "rev-parse",
        "HEAD",
      ]);
      if ((result as any)?.commit !== commit)
        throw new ControlError(
          "stale_commit",
          "Worker result differs from task HEAD",
          409,
        );
      const claim = {
        task,
        goal,
        workerId,
        generation,
        runtime: this.store.reliability.runtime(`${taskId}:${generation}`),
      };
      const changed = await this.workspaces.changed(goal, task);
      if (
        changed.some(
          (p) => !task.spec.allowedPaths.some((scope) => matchesGlob(p, scope)),
        )
      )
        throw new ControlError("scope", "Changes exceed task scope", 409);
      const protectedFiles = changed.filter(
        (p) =>
          goal.config.policy.protectedPaths.some((scope) =>
            matchesGlob(p, scope),
          ) &&
          !goal.config.policy.approvedPaths.some((scope) =>
            matchesGlob(p, scope),
          ),
      );
      const approved = this.store.db
        .query<Record<string, unknown>>(
          `SELECT request,answer FROM control_questions WHERE task_id=${sql(taskId)} AND status='answered'`,
        )
        .some((row) => {
          const request = JSON.parse(String(row.request)),
            answer = JSON.parse(String(row.answer));
          return request.commit === commit && answer.option === "approve";
        });
      if (protectedFiles.length && !approved) {
        await this.workspaces.checkpoint(
          task,
          "Protected changes require approval",
        );
        this.store.checkpoint(taskId, workerId, generation, {
          commit,
          summary: "Protected changes drafted; awaiting approval to integrate",
        });
        return this.store.requestHuman(taskId, workerId, generation, {
          question: `Approve protected changes in ${protectedFiles.join(", ")}?`,
          reason:
            "Auth, billing, migrations or policy-sensitive changes need explicit approval",
          options: [
            { id: "approve", label: "Approve these exact changes" },
            { id: "reject", label: "Revise without these changes" },
          ],
          category: "policy",
          commit,
        });
      }
      const tests = await this.verify(claim, this.workspaces.taskPath(task));
      this.store.evidence(
        taskId,
        workerId,
        generation,
        commit,
        "tests",
        tests.passed,
        tests,
      );
      if (!tests.passed) {
        this.store.finding(
          goal.id,
          taskId,
          { kind: "test_failure", commit, tests },
          "verifier",
        );
        return this.store.release(
          taskId,
          workerId,
          generation,
          "retry_wait",
          "Task tests failed",
          (result as any)?.costUsd,
        );
      }
      const diff = await git(this.workspaces.taskPath(task), [
        "diff",
        this.workspaces.taskBase(task),
        "HEAD",
      ]);
      if (/^Binary files /m.test(diff))
        throw new ControlError(
          "review_limit",
          "Binary changes require a configured verifier capable of inspecting them",
        );
      if (diff.length > 512000)
        throw new ControlError(
          "review_limit",
          "Complete diff exceeds review capacity",
        );
      const reviewed = await this.runBackend(
        goal,
        {
          claim,
          workspace: this.workspaces.taskPath(task),
          mode: "review",
          signal: deadlineSignal(
            claim.runtime?.deadlineAt ?? Date.now() + goal.config.timeoutMs,
          ),
          deadlineAt: claim.runtime?.deadlineAt,
          onCheckpoint: async () => {},
          prompt: `Independently review this exact commit ${commit}. Inspect complete changed files. Explicitly list resolved observation ids in resolvedObservations only after reproducing and verifying their resolution. Return only JSON {"commit":"${commit}","verdict":"pass"|"fail","findings":[{"summary":"...","blocking":true,"evidence":"file or test"}]}. Task: ${JSON.stringify(task.spec)}\nOperator observations: ${JSON.stringify(observations(this.store, goal.id))}\nDiff:\n${diff}`,
        },
        "review",
      );
      if (
        (await git(this.workspaces.taskPath(task), ["rev-parse", "HEAD"])) !==
          commit ||
        (await git(this.workspaces.taskPath(task), ["status", "--porcelain"]))
      )
        throw new ControlError(
          "review_mutation",
          "Reviewer changed the reviewed workspace",
        );
      const review = parseReview(reviewed.text, commit);
      const reviewPassed =
        review.verdict === "pass" && !review.findings.some((f) => f.blocking);
      this.store.evidence(
        taskId,
        workerId,
        generation,
        commit,
        "review",
        reviewPassed,
        {
          ...review,
          observations: review.resolvedObservations,
          environmentDigest: reviewed.environmentDigest,
          executionSessionId: reviewed.executionSessionId,
        },
      );
      if (reviewPassed) {
        for (const observationId of review.resolvedObservations ?? []) {
          closeObservation(
            this.store,
            goal.id,
            observationId,
            commit,
            "independent-reviewer",
          );
        }
      }
      for (const finding of review.findings)
        this.store.finding(goal.id, taskId, { ...finding, commit }, "reviewer");
      const cost = (result as any)?.costUsd;
      if (!reviewPassed) {
        this.store.checkpoint(taskId, workerId, generation, {
          commit,
          summary: `Repair blocking review findings: ${JSON.stringify(review.findings)}`,
        });
        return this.store.release(
          taskId,
          workerId,
          generation,
          "retry_wait",
          "Independent review failed",
          cost,
        );
      }
      this.store.transition(taskId, workerId, generation, "integrating");
      const integrate = async () => {
        this.store.assertLease(taskId, workerId, generation);
        let candidate;
        try {
          candidate = await this.workspaces.candidate(goal, task);
        } catch (error) {
          if (!(error instanceof TaskIntegrationConflict)) throw error;
          const conflicts = (
            await git(error.candidate.path, [
              "diff",
              "--name-only",
              "--diff-filter=U",
              "-z",
            ])
          )
            .split("\0")
            .filter(Boolean);
          if (
            conflicts.some(
              (path) =>
                !task.spec.allowedPaths.some((scope) =>
                  matchesGlob(path, scope),
                ),
            )
          )
            throw new ControlError(
              "task_repair_scope",
              "Task integration conflict exceeds its declared write contract",
              409,
            );
          candidate = await repairPublication(
            this.store,
            this.workspaces,
            goal,
            error,
            {
              claim,
              workspace: error.candidate.path,
              mode: "implement",
              prompt: "",
              signal: deadlineSignal(
                claim.runtime?.deadlineAt ?? Date.now() + goal.config.timeoutMs,
              ),
              deadlineAt: claim.runtime?.deadlineAt,
              onCheckpoint: async () => {},
            },
            (context) => this.runBackend(goal, context, "repair"),
            `task-${task.id}`,
          );
          // Repair changes the tested candidate; original task review cannot
          // authorize the conflict resolution's newly introduced content.
          const repairedReview = await this.runBackend(
            goal,
            {
              claim,
              workspace: candidate.path,
              mode: "review",
              signal: deadlineSignal(
                claim.runtime?.deadlineAt ?? Date.now() + goal.config.timeoutMs,
              ),
              deadlineAt: claim.runtime?.deadlineAt,
              onCheckpoint: async () => {},
              prompt: `Independently review task integration repair at exact commit ${candidate.commit}. Preserve both prerequisite integration behavior and task contract ${JSON.stringify(task.spec)}. Inspect the complete conflict resolution. Return only JSON with commit, verdict and findings.`,
            },
            "review",
          );
          const verdict = parseReview(repairedReview.text, candidate.commit);
          if (
            verdict.verdict !== "pass" ||
            verdict.findings.some((f) => f.blocking)
          ) {
            const key = `task-${task.id}-repair:${goal.id}:${candidate.goalSha}:${candidate.targetSha}`;
            const repaired = this.store.setting(key);
            if (repaired?.path === candidate.path)
              this.store.setting(key, {
                ...repaired,
                status: "ready",
                feedback: verdict,
              });
            throw new ControlError(
              "task_repair_review",
              "Independent task integration repair review failed",
              409,
            );
          }
          if (
            (await git(candidate.path, ["rev-parse", "HEAD"])) !==
              candidate.commit ||
            (await git(candidate.path, ["status", "--porcelain"]))
          )
            throw new ControlError(
              "review_mutation",
              "Task repair review changed the candidate",
              409,
            );
          this.store.artifact(
            goal.id,
            task.id,
            "task-repair-review",
            candidate.path,
            { commit: candidate.commit, verdict },
          );
        }
        const checks = await this.verify(claim, candidate.path);
        this.store.evidence(
          taskId,
          workerId,
          generation,
          candidate.commit,
          "integration",
          checks.passed,
          checks,
        );
        if (!checks.passed) {
          if ("goalSha" in candidate && "targetSha" in candidate) {
            const key = `task-${task.id}-repair:${goal.id}:${candidate.goalSha}:${candidate.targetSha}`;
            const repaired = this.store.setting(key);
            if (repaired?.path === candidate.path)
              this.store.setting(key, {
                ...repaired,
                status: "ready",
                feedback: checks,
              });
          }
          this.store.finding(
            goal.id,
            taskId,
            { kind: "integration_failure", candidate, checks },
            "verifier",
          );
          return this.store.release(
            taskId,
            workerId,
            generation,
            "retry_wait",
            "Integration checks failed",
            cost,
          );
        }
        this.store.assertLease(taskId, workerId, generation);
        const priorHead = await git(this.workspaces.goalPath(goal), [
          "rev-parse",
          "HEAD",
        ]);
        assertObservationsClosed(this.store, goal.id);
        const sha = await this.workspaces.advance(goal, candidate);
        try {
          return this.store.accept(
            taskId,
            workerId,
            generation,
            commit,
            sha,
            cost,
          );
        } catch (error) {
          await git(this.workspaces.goalPath(goal), [
            "reset",
            "--hard",
            priorHead,
          ]);
          throw error;
        }
      };
      const repository =
        this.workspaces.repositories.record(goal.id)?.repositoryId ??
        repositoryIdentity(
          goal.config.repository?.mode === "remote"
            ? goal.config.repository.remoteUrl
            : goal.config.repoPath,
        );
      const prior =
        this.repositoryIntegrations.get(repository) ?? Promise.resolve();
      const execution = abortable(
        prior,
        executionSignal() ?? this.shutdownAbort.signal,
      ).then(() => {
        executionSignal()?.throwIfAborted();
        return integrate();
      });
      const settled = execution.catch(() => {});
      this.repositoryIntegrations.set(repository, settled);
      this.integrating = Promise.all([...this.repositoryIntegrations.values()]);
      void settled.finally(() => {
        if (this.repositoryIntegrations.get(repository) === settled)
          this.repositoryIntegrations.delete(repository);
      });
      return await execution;
    } catch (e) {
      const t = this.store.getTask(taskId);
      if (
        e instanceof ProviderFailure &&
        t.workerId === workerId &&
        t.generation === generation
      ) {
        // A deterministic provider blocker pauses the goal before result error
        // handling. Fence the parent immediately; paused authority cannot use
        // ordinary worker release and must not linger until lease expiry.
        this.store.db.exec(
          `UPDATE control_tasks SET lease_until=${this.store.clock() - 1} WHERE id=${sql(taskId)}`,
        );
        this.store.reconcileExpired(taskId, generation);
        return this.store.getTask(taskId);
      }
      if (
        e instanceof ControlError &&
        [
          "repair_limit",
          "repair_scope",
          "repair_lineage",
          "repair_handoff",
          "repair_environment",
          "task_repair_scope",
          "task_repair_review",
        ].includes(e.code) &&
        t.workerId === workerId &&
        t.generation === generation
      ) {
        this.store.checkpoint(taskId, workerId, generation, {
          commit: await git(this.workspaces.taskPath(t), ["rev-parse", "HEAD"]),
          summary:
            "Task integration repair needs owner inspection; conflict and task source retained",
        });
        return this.store.requestHuman(taskId, workerId, generation, {
          question: "Inspect retained task integration conflict?",
          reason: e.message,
          category: "policy",
          options: [
            { id: "inspect", label: "Inspect and retry retained repair" },
            { id: "retry", label: "Retry with recorded review feedback" },
          ],
        });
      }
      if (
        (e instanceof HumanWait ||
          (e instanceof ControlError && e.code === "budget")) &&
        t.workerId === workerId &&
        t.generation === generation
      ) {
        this.store.checkpoint(taskId, workerId, generation, {
          commit: await git(this.workspaces.taskPath(t), ["rev-parse", "HEAD"]),
          summary: "Awaiting approval before verification can continue",
          costUsd: (result as any)?.costUsd,
        });
        return this.store.requestHuman(
          taskId,
          workerId,
          generation,
          e instanceof HumanWait
            ? e.request
            : {
                question: "Authorize additional review spending?",
                reason:
                  "Independent review must pass before integration; the budget is exhausted.",
                options: [
                  { id: "approve", label: "Increase review budget" },
                  { id: "reject", label: "Keep current budget" },
                ],
                category: "spending",
                requestedMaxCostUsd:
                  this.store.getGoal(t.goalId).config.maxCostUsd +
                  this.store.getGoal(t.goalId).config.estimatePerRunUsd,
              },
        );
      }
      if (
        t.workerId === workerId &&
        t.generation === generation &&
        t.leaseUntil &&
        t.leaseUntil > this.store.clock()
      ) {
        this.store.finding(
          t.goalId,
          t.id,
          { kind: "verification_or_integration", reason: (e as Error).message },
          "scheduler",
        );
        return this.store.release(
          taskId,
          workerId,
          generation,
          classifyFailure(e).retryable ? "retry_wait" : "blocked",
          classifyFailure(e).message,
          undefined,
          undefined,
          classifyFailure(e),
        );
      }
      throw e;
    } finally {
      this.busyResults.delete(key);
    }
  }
  replayResult(
    taskId: string,
    workerId: string,
    generation: number,
    result: unknown,
  ) {
    const attempt = this.store.db.one<{
      worker_id: string;
      outcome: string;
      result: string;
    }>(
      `SELECT worker_id,outcome,result FROM control_attempts WHERE task_id=${sql(taskId)} AND generation=${generation}`,
    );
    if (!attempt || attempt.outcome !== "accepted") return undefined;
    if (attempt.worker_id !== workerId)
      throw new ControlError(
        "worker_scope",
        "Attempt belongs to another worker",
        403,
      );
    const request = this.store.setting(
      `result-request:${taskId}:${generation}`,
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(result))
      .digest("hex");
    if (
      !request ||
      request.workerId !== workerId ||
      request.fingerprint !== fingerprint
    )
      throw new ControlError(
        "idempotency_conflict",
        "Completed result differs from its admitted request",
        409,
      );
    const task = this.store.getTask(taskId);
    if (task.generation !== generation || task.status !== "accepted")
      throw new ControlError(
        "stale_generation",
        "Attempt is no longer the accepted task generation",
        409,
      );
    return task;
  }
  async verify(claim: Claim, path: string) {
    if (this.options.isolatedVerifier)
      return this.options.isolatedVerifier(claim, path);
    if (claim.goal.config.backend.kind !== "fake")
      throw new ControlError(
        "verification_environment",
        "Isolated dispatch requires its isolated verifier",
        409,
      );
    const commands = [
      ...new Set([
        ...claim.goal.config.verificationCommands,
        ...claim.task.spec.verificationCommands,
      ]),
    ];
    if (!commands.length)
      return {
        passed: false,
        results: [],
        reason: "At least one explicit verification command is required",
      };
    const results = [];
    const before = await git(path, ["rev-parse", "HEAD"]);
    for (const command of commands) {
      const result = await runShell(command, {
        cwd: path,
        timeoutMs: Math.max(
          1,
          (claim.runtime?.deadlineAt ??
            executionDeadline() ??
            Date.now() + claim.goal.config.timeoutMs) - Date.now(),
        ),
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      results.push({
        command,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(-20000),
        stderr: result.stderr.slice(-20000),
      });
    }
    const unchanged =
      (await git(path, ["rev-parse", "HEAD"])) === before &&
      (await git(path, ["status", "--porcelain"])) === "";
    return {
      passed: unchanged && results.every((r) => r.exitCode === 0),
      results,
      unchanged,
    };
  }
  async publish(goalId: string) {
    const goal = this.store.getGoal(goalId);
    if (goal.status !== "completed") await this.workspaces.prepareGoal(goal);
    const base = this.workspaces.repositories.record(goalId);
    if (!base && goal.status === "completed") return; // Historical completed goals predate managed lineage.
    if (!base)
      throw new ControlError(
        "workspace_lineage",
        "Goal has no recorded repository base",
        409,
      );
    return this.workspaces.repositories.exclusive(
      `publication:${base.repositoryId}:${base.targetRef}`,
      () => this.publishLeased(goalId),
    );
  }
  private async publishLeased(goalId: string) {
    const g = this.store.getGoal(goalId);
    if (g.status === "completed") {
      const result = g.result as any;
      if (result?.publication?.merged) {
        const candidate = this.store.setting(`publication:${g.id}`);
        if (candidate)
          await this.workspaces.recordPublication(
            g,
            candidate.commit,
            result.publication.url,
            this.store.clock(),
          );
      }
      await this.writeGoalReport(g.id);
      return;
    }
    const tasks = this.store.tasks(g.id);
    if (!tasks.every((t) => ["accepted", "superseded"].includes(t.status)))
      throw new ControlError(
        "unfinished_work",
        "Goal still has unaccepted tasks",
        409,
      );
    let publication: unknown = {
      local: true,
      branch: this.workspaces.goalBranch(g),
    };
    const host = this.options.gitHost ?? new GithubHost();
    const prior = this.store.setting(`publication:${g.id}`);
    if (
      prior &&
      (await git(this.workspaces.goalPath(g), ["rev-parse", "HEAD"])) !==
        prior.commit
    )
      throw new ControlError(
        "stale_commit",
        "Recorded publication differs from integration head; reconcile before retry",
        409,
      );
    if (
      g.config.policy.publish &&
      prior &&
      (await git(this.workspaces.goalPath(g), ["rev-parse", "HEAD"])) ===
        prior.commit
    ) {
      try {
        const result = await host.publish(
          g,
          this.workspaces.goalPath(g),
          this.workspaces.goalBranch(g),
          { targetSha: prior.targetSha, candidateSha: prior.commit },
        );
        if (g.config.policy.autoMerge && !result.merged)
          throw new ControlError("merge_pending", "PR has not merged", 409);
        publication = result;
      } catch (error) {
        if (!(error instanceof ControlError) || error.code !== "stale_base")
          throw error;
        this.store.setting(`publication:${g.id}`, null);
      }
    }
    if (
      g.config.policy.publish &&
      (!prior || this.store.setting(`publication:${g.id}`) === null)
    ) {
      const claim = this.plannerClaim(g);
      let candidate;
      try {
        candidate = await this.workspaces.refreshCandidate(g);
      } catch (error) {
        if (!(error instanceof PublicationConflict)) throw error;
        try {
          candidate = await repairPublication(
            this.store,
            this.workspaces,
            g,
            error,
            {
              claim,
              workspace: error.candidate.path,
              mode: "implement",
              prompt: "",
              signal: AbortSignal.timeout(g.config.timeoutMs),
              onCheckpoint: async () => {},
            },
            (context) => this.runBackend(g, context, "repair"),
          );
        } catch (repairError) {
          if (
            repairError instanceof ControlError &&
            [
              "repair_limit",
              "repair_scope",
              "repair_lineage",
              "repair_handoff",
              "repair_environment",
            ].includes(repairError.code)
          ) {
            this.store.requestGoalHuman(g.id, {
              question: "Inspect retained development merge repair?",
              reason:
                repairError.message +
                `; conflict source: ${error.candidate.path}`,
              category: "policy",
              commit: error.candidate.goalSha,
              options: [
                { id: "inspect", label: "Inspect retained source" },
                { id: "wait", label: "Keep waiting" },
              ],
            });
            throw new ControlError(
              "active_work",
              "Development repair awaits owner inspection",
              409,
            );
          }
          throw repairError;
        }
      }
      claim.task.spec.verificationCommands = [
        ...new Set(tasks.flatMap((t) => t.spec.verificationCommands)),
      ];
      const checks = await this.verify(claim, candidate.path);
      this.store.artifact(
        g.id,
        undefined,
        "publication-checks",
        candidate.path,
        {
          ...candidate,
          checks,
          image: g.config.containerImage ?? "fixture-host",
          verifierVersion: "publication-v1",
        },
      );
      if (!checks.passed) {
        retryPublicationRepair(this.store, g.id, candidate, checks);
        throw new ControlError(
          candidate.path.includes("/repair-")
            ? "repair_retry"
            : "integration_failed",
          "Current-development goal verification failed",
          409,
        );
      }
      const diff = await git(candidate.path, [
        "diff",
        candidate.targetSha,
        candidate.commit,
      ]);
      if (diff.length > 512000 || /^Binary files /m.test(diff))
        throw new ControlError(
          "review_limit",
          "Publication diff requires an expanded verifier",
          409,
        );
      const reviewOutput = await this.runBackend(
        g,
        {
          claim,
          workspace: candidate.path,
          mode: "review",
          signal: AbortSignal.timeout(g.config.timeoutMs),
          onCheckpoint: async () => {},
          prompt: `Independently review the complete goal against current development ${candidate.targetSha}. Return JSON {"commit":"${candidate.commit}","verdict":"pass" or "fail","findings":[{"summary":"...","blocking":true,"evidence":"..."}]}. Goal: ${g.config.description}\nOperator observations: ${JSON.stringify(observations(this.store, g.id))}\nDiff:\n${diff}`,
        },
        "review",
      );
      const review = parseReview(reviewOutput.text, candidate.commit);
      const unchanged =
        (await git(candidate.path, ["rev-parse", "HEAD"])) ===
          candidate.commit &&
        !(await git(candidate.path, ["status", "--porcelain"]));
      this.store.artifact(
        g.id,
        undefined,
        "publication-review",
        candidate.path,
        {
          ...candidate,
          review,
          unchanged,
          environmentDigest: reviewOutput.environmentDigest,
          executionSessionId: reviewOutput.executionSessionId,
          verifierVersion: "publication-v1",
        },
      );
      if (
        !unchanged ||
        review.verdict !== "pass" ||
        review.findings.some((f) => f.blocking)
      ) {
        retryPublicationRepair(this.store, g.id, candidate, review);
        throw new ControlError(
          candidate.path.includes("/repair-")
            ? "repair_retry"
            : "integration_review",
          "Independent current-development review failed",
          409,
        );
      }
      // Accepted task approvals remain immutable. Any refreshed content in sensitive
      // files needs a new content-specific owner decision before publication.
      const refreshedPaths = (
        await git(candidate.path, [
          "diff",
          "--name-only",
          candidate.goalSha,
          candidate.commit,
        ])
      )
        .split("\n")
        .filter(Boolean);
      const sensitive = refreshedPaths.filter(
        (p) =>
          g.config.policy.protectedPaths.some((scope) =>
            matchesGlob(p, scope),
          ) &&
          !g.config.policy.approvedPaths.some((scope) => matchesGlob(p, scope)),
      );
      if (sensitive.length) {
        const approved = this.store.db
          .query<Record<string, unknown>>(
            `SELECT request,answer FROM control_questions WHERE goal_id=${sql(g.id)} AND task_id IS NULL AND status='answered'`,
          )
          .some(
            (row) =>
              JSON.parse(String(row.request)).commit === candidate.commit &&
              JSON.parse(String(row.answer)).option === "approve",
          );
        if (!approved) {
          this.store.requestGoalHuman(g.id, {
            question: "Approve sensitive content on refreshed development?",
            reason: JSON.stringify({ candidate, sensitive }),
            commit: candidate.commit,
            category: "policy",
            options: [
              { id: "approve", label: "Approve this candidate" },
              { id: "wait", label: "Keep it awaiting review" },
            ],
          });
          throw new ControlError(
            "active_work",
            "Refreshed sensitive content awaits approval",
            409,
          );
        }
      }
      assertObservationsClosed(this.store, g.id);
      await this.workspaces.advance(g, candidate);
      this.store.setting(`publication:${g.id}`, candidate);
      const result = await host.publish(
        g,
        this.workspaces.goalPath(g),
        this.workspaces.goalBranch(g),
        { targetSha: candidate.targetSha, candidateSha: candidate.commit },
      );
      publication = result;
      if (g.config.policy.autoMerge && !result.merged)
        throw new ControlError("merge_pending", "PR has not merged", 409);
    }
    if (!g.config.policy.publish && g.config.policy.requiredChecks.length) {
      if (!this.options.localDeliveryGate)
        throw new ControlError(
          "checks_pending",
          "Local delivery requires a trusted configured delivery verifier",
          409,
        );
      if (g.config.repository?.mode !== "local")
        throw new ControlError(
          "checks_pending",
          "Non-publishing required checks need an explicit local repository target",
          409,
        );
      const targetBranch = g.config.repository.branch;
      const workspace = this.workspaces.goalPath(g);
      const candidateSha = await git(workspace, ["rev-parse", "HEAD"]);
      const targetSha = await git(g.config.repoPath, [
        "rev-parse",
        targetBranch,
      ]);
      this.store.setting(`local-delivery:${g.id}`, {
        commit: candidateSha,
        targetSha,
      });
      await this.options.localDeliveryGate({
        goalId: g.id,
        workspace,
        repoPath: g.config.repoPath,
        candidateSha,
        targetSha,
        requiredChecks: g.config.policy.requiredChecks,
      });
      if (
        (await git(workspace, ["status", "--porcelain"])) ||
        (await git(workspace, ["rev-parse", "HEAD"])) !== candidateSha ||
        (await git(g.config.repoPath, ["rev-parse", targetBranch])) !==
          targetSha
      )
        throw new ControlError(
          "stale_base",
          "Local source or target advanced after delivery verification",
          409,
        );
    }
    assertObservationsClosed(this.store, g.id);
    this.store.setGoalState(g.id, "completed", g.revision, "scheduler", {
      publication,
      report: `goals/${g.id}/report.json`,
    });
    if ((publication as any).merged) {
      const candidate = this.store.setting(`publication:${g.id}`);
      if (candidate)
        await this.workspaces.recordPublication(
          g,
          candidate.commit,
          (publication as any).url,
          this.store.clock(),
        );
    }
    await this.writeGoalReport(g.id);
  }
  async writeGoalReport(goalId: string) {
    const goal = this.store.getGoal(goalId);
    if (!["completed", "failed", "cancelled"].includes(goal.status))
      throw new ControlError(
        "report_state",
        "Report requires a terminal goal",
        409,
      );
    const attempts: ReturnType<ControlStore["attempts"]> = [];
    let cursor = "";
    while (true) {
      const page = this.store.attempts(goalId, 500, cursor);
      attempts.push(...page);
      if (page.length < 500) break;
      cursor = page.at(-1)!.id;
    }
    const events: ReturnType<ControlStore["events"]> = [];
    let after = 0;
    while (true) {
      const page = this.store.events(after, goalId, 500);
      events.push(...page);
      if (page.length < 500) break;
      after = page.at(-1)!.id;
    }
    const tasks = this.store.tasks(goalId);
    const report = {
      schemaVersion: 1,
      goal,
      tasks,
      attempts,
      events,
      publication: (goal.result as any)?.publication,
      usage:
        this.store.subscriptionCapacity(goalId) ?? this.store.canSpend(goalId),
      evidence: this.store.db.query(
        `SELECT e.* FROM control_evidence e JOIN control_tasks t ON t.id=e.task_id WHERE t.goal_id=${sql(goalId)} ORDER BY e.created_at,e.id`,
      ),
      decisions: this.store.db.query(
        `SELECT * FROM control_questions WHERE goal_id=${sql(goalId)} ORDER BY created_at,id`,
      ),
    };
    const path = await this.workspaces.report(goal, report);
    this.store.db.transaction(() => {
      const existing = this.store.db.one(
        `SELECT id FROM control_artifacts WHERE goal_id=${sql(goalId)} AND kind='goal-report'`,
      );
      if (!existing)
        this.store.artifact(goalId, undefined, "goal-report", path);
      this.store.setting(`report:${goalId}`, {
        schemaVersion: 1,
        state: "ready",
        location: `goals/${goalId}/report.json`,
        goalRevision: goal.revision,
      });
      this.store.db.exec(
        `UPDATE control_jobs SET status='done' WHERE kind='report' AND json_extract(payload,'$.goalId')=${sql(goalId)} AND status='pending'`,
      );
    });
    return report;
  }
  runSchedules() {
    for (const row of this.store.db.query<Record<string, unknown>>(
      `SELECT * FROM control_schedules WHERE next_at<=${this.store.clock()}`,
    )) {
      if (row.last_goal_id) {
        const g = this.store.getGoal(String(row.last_goal_id));
        if (!["completed", "failed", "cancelled"].includes(g.status)) continue;
      }
      this.store.db.transaction(() => {
        const g = this.store.createGoal(
          JSON.parse(String(row.config)),
          "schedule",
        );
        this.store.db.exec(
          `UPDATE control_schedules SET last_goal_id=${sql(g.id)},next_at=${this.store.clock() + Number(row.interval_ms)} WHERE id=${sql(String(row.id))}`,
        );
      });
    }
  }
  async maintenance<T>(
    operation: () => Promise<T>,
    timeoutMs = 60000,
  ): Promise<T> {
    if (this.maintenanceRequested)
      throw new ControlError(
        "maintenance",
        "Maintenance is already active",
        409,
      );
    this.maintenanceRequested = true;
    try {
      const deadline = Date.now() + timeoutMs;
      while (
        this.ticking ||
        this.isolated.size ||
        this.busyResults.size ||
        this.runningJobs.size
      ) {
        if (Date.now() > deadline)
          throw new ControlError(
            "maintenance_busy",
            "Work is still changing filesystem state; pause/drain goals and retry complete backup",
            409,
          );
        await new Promise((r) => setTimeout(r, 50));
      }
      await this.integrating;
      return await operation();
    } finally {
      this.maintenanceRequested = false;
    }
  }
  async close() {
    this.closing = true;
    this.shutdownAbort.abort(new Error("Controller shutdown"));
    for (const active of this.isolated.values())
      active.abort.abort(new Error("Scheduler shutdown"));
    await boundedCleanup(async (signal) => {
      await abortable(
        Promise.all(
          [...this.isolated.values()]
            .map((active) => active.done)
            .concat(
              [...this.runningJobs.values()],
              [...this.recovering.values()],
            ),
        ).then(() => {}),
        signal,
      );
    }, 90000);
  }
}
