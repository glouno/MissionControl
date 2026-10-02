import { ControlStore } from "./store.js";
import { StorageManager, type ManagedWorkspace } from "./storage.js";
import { ControlError } from "./schema.js";
import { sql } from "../sqlite.js";
import { git } from "./git.js";

export type MaintenanceMode = "preview" | "workspaces" | "branches";
export class StorageMaintenance {
  constructor(
    readonly storage: StorageManager,
    readonly store: ControlStore,
  ) {}
  async active(w: ManagedWorkspace) {
    const goal = this.store.getGoal(w.goalId);
    return (
      !["completed", "failed", "cancelled", "paused"].includes(goal.status) ||
      this.store.tasks(w.goalId).some((t) => t.workerId !== null) ||
      Boolean(
        this.store.db.one(
          `SELECT id FROM control_budgets WHERE goal_id=${sql(w.goalId)} AND status IN ('reserved','unresolved') UNION ALL SELECT id FROM control_attempts WHERE goal_id=${sql(w.goalId)} AND (outcome IN ('active','recovering') OR (json_extract(configuration,'$.executionContract.usagePolicy.kind')='subscription' AND (usage IS NULL OR json_extract(usage,'$.status')='unknown')))`,
        ),
      )
    );
  }
  private async inactive(w: ManagedWorkspace) {
    if (await this.active(w))
      throw new ControlError(
        "active_work",
        "Goal, worker or review still owns source",
        409,
      );
  }
  private async publication(w: ManagedWorkspace) {
    const goal = this.store.getGoal(w.goalId);
    const candidate = this.store.setting(`publication:${w.goalId}`);
    const result = goal.result as {
      publication?: {
        merged?: boolean;
        verifiedCandidate?: string;
        url?: string;
      };
    } | null;
    if (
      goal.status !== "completed" ||
      !result?.publication?.merged ||
      !w.publication ||
      (candidate?.commit ?? result.publication.verifiedCandidate) !==
        w.publication.candidateSha ||
      result.publication.url !== w.publication.url
    )
      throw new ControlError(
        "publication_required",
        "Exact verified merged publication required for cleanup",
        409,
      );
  }
  private async dependencies(w: ManagedWorkspace) {
    // A durable base SHA can reference this branch's objects even after its
    // workspace disappears. Keep refs while any unfinished source shares Git.
    if (
      this.storage
        .workspaces()
        .some(
          (other) =>
            other.id !== w.id &&
            (other.pinned || other.unfinished || other.status !== "cleaned") &&
            other.goalId === w.goalId,
        )
    )
      throw new ControlError(
        "dependent_work",
        "Goal source still depends on owned branch",
        409,
      );
    for (const other of this.storage
      .workspaces()
      .filter(
        (other) =>
          other.goalId !== w.goalId &&
          (other.pinned || other.unfinished || other.status !== "cleaned"),
      )) {
      const dependent = await git(w.branchCleanup!.repositoryPath, [
        "merge-base",
        "--is-ancestor",
        w.headSha,
        other.baseSha,
      ]).then(
        () => true,
        (error) => {
          if (error.code === 1) return false;
          // Unknown objects can be from another cache; conservatively retain.
          return true;
        },
      );
      if (dependent)
        throw new ControlError(
          "dependent_work",
          "Another goal retains branch ancestry or unresolved lineage",
          409,
        );
    }
  }
  async maintain(mode: MaintenanceMode = "preview") {
    return this.storage.exclusiveMaintenance(async () => {
      const removed: string[] = [],
        branches: string[] = [],
        errors: { id: string; reason: string }[] = [];
      if (mode !== "preview") {
        for (const w of this.storage.workspaces()) {
          try {
            await this.inactive(w);
            if (w.status === "archiving")
              await this.storage.reconcileArchive(w.id);
            else if (["cleaning", "cleanup_failed"].includes(w.status))
              await this.storage.reconcileCleanup(w.id);
          } catch (error) {
            errors.push({ id: w.id, reason: (error as Error).message });
          }
        }
      }
      const preview = await this.storage.preview((w) => this.active(w));
      if (mode !== "preview") {
        for (const action of preview.actions.filter((a) => a.eligible)) {
          try {
            await this.storage.cleanup(
              action.workspace.id,
              {},
              (w) => this.inactive(w),
              (w) => this.publication(w),
            );
            removed.push(action.workspace.id);
          } catch (error) {
            errors.push({
              id: action.workspace.id,
              reason: (error as Error).message,
            });
          }
        }
      }
      if (mode === "branches") {
        for (const w of this.storage
          .workspaces()
          .filter(
            (w) =>
              w.status === "cleaned" &&
              w.branchCleanup &&
              w.branchCleanup.status !== "deleted",
          )) {
          try {
            await this.storage.cleanupBranch(
              w.id,
              (w) => this.inactive(w),
              (w) => this.dependencies(w),
            );
            branches.push(w.id);
          } catch (error) {
            errors.push({ id: w.id, reason: (error as Error).message });
          }
        }
      }
      return {
        ...preview,
        archiveMaintenance: await this.storage.evictArchives(
          (w) => this.active(w),
          mode !== "preview",
        ),
        previewOnly: mode === "preview",
        mode,
        removed,
        branches,
        errors,
      };
    });
  }
}
