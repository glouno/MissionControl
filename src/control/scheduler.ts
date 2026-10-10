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
  private maintenanceRequested = false;
  private isolated = new Map<
    string,
    { claim: Claim; token: string; abort: AbortController; done: Promise<void> }
  >();
  private integrating: Promise<unknown> = Promise.resolve();
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
      gitHost?: GitHost;
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
        const workspace = await this.workspaces.prepareTask(
          claim.goal,
          claim.task,
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
    if (this.ticking || this.maintenanceRequested) return;
    this.ticking = true;
    try {
      for (const t of this.store.expired()) {
        const isolated = this.isolated.get(t.id);
        if (isolated) {
          isolated.abort.abort(new Error("Task lease expired"));
          await isolated.done;
        }
        this.store.reconcileExpired(t.id, t.generation);
      }
      for (const active of this.isolated.values())
        if (
          ["cancelled", "paused"].includes(
            this.store.getGoal(active.claim.goal.id).status,
          )
        )
          active.abort.abort(new Error("Goal execution stopped"));
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
      this.runSchedules();
      for (const job of this.store.jobs()) {
        if (this.isolated.size >= 4) break;
        const payload = JSON.parse(String(job.payload));
        try {
          const g = this.store.getGoal(payload.goalId);
          if (job.kind === "report") {
            await this.writeGoalReport(g.id);
            this.store.finishJob(String(job.id));
            continue;
          }
          if (["cancelled", "completed", "failed"].includes(g.status)) {
            // Completion and filesystem lifecycle cannot share a transaction.
            // Replay pending publication intent before retiring its durable job.
            if (g.status === "completed" && job.kind === "publish")
              await this.publish(g.id);
            this.store.finishJob(String(job.id));
            continue;
          }
          if (g.status === "paused") {
            this.store.deferJob(String(job.id));
            continue;
          }
          if (job.kind === "plan") await this.plan(payload.goalId);
          else if (job.kind === "publish") await this.publish(payload.goalId);
          else if (job.kind === "replan") await this.replan(payload.goalId);
          this.store.finishJob(String(job.id));
        } catch (e) {
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
            continue;
          }
          if (e instanceof HumanWait) {
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
        while (this.isolated.size < 4) {
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
              break;
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
              continue;
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
            else break;
          }
        }
      }
    } finally {
      this.ticking = false;
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
      const output = await backend.run({
        ...context,
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
      cost = output.costUsd;
      usage = executionUsage(output, g.config);
      outcome = "completed";
      result = {
        executionSessionId: output.executionSessionId,
        environmentDigest: output.environmentDigest,
      };
      return output;
    } catch (e) {
      cost = (e as any).costUsd;
      try {
        usage = executionUsage(e as any, g.config);
      } catch {
        usage = executionUsage({}, g.config);
        cost = undefined;
      }
      throw e;
    } finally {
      this.store.settleOperation(budget, cost, usage, outcome, result);
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
          prompt: `Investigate this repository and decompose the goal into a bounded DAG. Return only JSON {"tasks":[{"key":"...","title":"...","description":"...","dependencies":[],"acceptanceCriteria":["..."],"allowedPaths":["..."],"verificationCommands":[]}]}. Goal: ${g.config.description}\nRequired checks: ${JSON.stringify(g.config.verificationCommands)}\nProject context: ${JSON.stringify(context)}`,
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
        prompt: `Revise the goal plan after these events: ${JSON.stringify(this.store.events(0, g.id).slice(-20))}. Preserve these accepted contracts exactly: ${JSON.stringify(prior)}. Return JSON {tasks:[...]} with bounded tasks, dependencies, acceptanceCriteria, allowedPaths, verificationCommands. Goal: ${g.config.description}`,
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
      const claim = { task, goal, workerId, generation };
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
          signal: AbortSignal.timeout(goal.config.timeoutMs),
          onCheckpoint: async () => {},
          prompt: `Independently review this exact commit ${commit}. Inspect complete changed files. Return only JSON {"commit":"${commit}","verdict":"pass"|"fail","findings":[{"summary":"...","blocking":true,"evidence":"file or test"}]}. Task: ${JSON.stringify(task.spec)}\nDiff:\n${diff}`,
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
          environmentDigest: reviewed.environmentDigest,
          executionSessionId: reviewed.executionSessionId,
        },
      );
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
              signal: AbortSignal.timeout(goal.config.timeoutMs),
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
              signal: AbortSignal.timeout(goal.config.timeoutMs),
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
      const execution = this.integrating.then(integrate);
      this.integrating = execution.catch(() => {});
      return await execution;
    } catch (e) {
      const t = this.store.getTask(taskId);
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
          "retry_wait",
          (e as Error).message,
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
        timeoutMs: claim.goal.config.timeoutMs,
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
          prompt: `Independently review the complete goal against current development ${candidate.targetSha}. Return JSON {"commit":"${candidate.commit}","verdict":"pass" or "fail","findings":[{"summary":"...","blocking":true,"evidence":"..."}]}. Goal: ${g.config.description}\nDiff:\n${diff}`,
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
      while (this.ticking || this.isolated.size || this.busyResults.size) {
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
    for (const active of this.isolated.values())
      active.abort.abort(new Error("Scheduler shutdown"));
    await Promise.all([...this.isolated.values()].map((active) => active.done));
  }
}
