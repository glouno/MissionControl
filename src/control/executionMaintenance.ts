import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "../sqlite.js";
import { ControlError } from "./schema.js";
import { git } from "./git.js";
import type {
  ExecutionEnvironment,
  EnvironmentRegistry,
  ExecutionSession,
} from "./environments.js";

// Execution source is separate from trusted task worktrees. Only successful,
// immutable verification/review clones are disposable without recovery archival.
export class ExecutionMaintenance {
  constructor(
    readonly registry: EnvironmentRegistry,
    readonly environment: ExecutionEnvironment,
    readonly active: (session: ExecutionSession) => Promise<boolean>,
    readonly clock = Date.now,
  ) {
    registry.db.exec(
      "CREATE TABLE IF NOT EXISTS execution_maintenance(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL)",
    );
  }
  private async reasons(session: ExecutionSession) {
    const reasons: string[] = [];
    if (session.status === "destroyed") return ["already removed"];
    if (await this.active(session))
      reasons.push("active task, goal or owner reservation");
    if (session.container) reasons.push("execution container remains recorded");
    if (!["checkpointed", "prepared", "stopped"].includes(session.status))
      reasons.push("execution is not stopped/checkpointed");
    if (session.completion?.outcome !== "verified")
      reasons.push(
        "source is not a successful disposable verification/review clone",
      );
    if (reasons.length) return reasons;
    try {
      await this.registry.owned(session);
      if (
        (await git(session.path, ["rev-parse", "HEAD"])) !==
          session.completion!.commit ||
        (await git(session.path, ["status", "--porcelain"]))
      )
        reasons.push("source changed after verification");
      const ignored = (
        await git(session.path, [
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "-z",
        ])
      )
        .split("\0")
        .filter(Boolean);
      if (
        ignored.some(
          (path) =>
            !/(^|\/)(node_modules|\.venv|venv|__pycache__|\.cache|\.pytest_cache|\.ruff_cache|\.next|dist|build|coverage)(\/|$)/.test(
              path,
            ),
        )
      )
        reasons.push("ignored artifact requires classification");
    } catch (error) {
      reasons.push(
        `ownership/source inspection failed: ${(error as Error).message}`,
      );
    }
    return reasons;
  }
  async preview() {
    const actions = [];
    for (const session of this.registry.all()) {
      const reasons = await this.reasons(session);
      actions.push({
        sessionId: session.id,
        path: session.path,
        outcome: session.completion?.outcome,
        eligible: reasons.length === 0,
        reasons,
      });
    }
    return { previewOnly: true, actions };
  }
  async maintain(apply = false) {
    const owner = randomUUID(),
      db = this.registry.db;
    const acquired = db.transaction(() => {
      db.exec(
        `DELETE FROM execution_maintenance WHERE expires<${this.clock()}`,
      );
      db.exec(
        `INSERT OR IGNORE INTO execution_maintenance VALUES('temporary',${sql(owner)},${this.clock() + 60000})`,
      );
      return (
        db.one<{ owner: string }>(
          "SELECT owner FROM execution_maintenance WHERE name='temporary'",
        )?.owner === owner
      );
    });
    if (!acquired)
      throw new ControlError(
        "active_work",
        "Execution maintenance is already leased",
        409,
      );
    const renew = setInterval(
      () =>
        db.exec(
          `UPDATE execution_maintenance SET expires=${this.clock() + 60000} WHERE owner=${sql(owner)}`,
        ),
      10000,
    );
    renew.unref();
    try {
      const preview = await this.preview(),
        removed: string[] = [];
      if (apply)
        for (const action of preview.actions.filter((a) => a.eligible)) {
          if (
            db.one<{ owner: string }>(
              "SELECT owner FROM execution_maintenance WHERE name='temporary'",
            )?.owner !== owner
          )
            throw new ControlError(
              "lease_lost",
              "Execution cleanup lease changed",
              409,
            );
          const session = this.registry.get(action.sessionId);
          // Repeat authority and source checks immediately before destructive action.
          if ((await this.reasons(session)).length) continue;
          await this.environment.destroy(session.id);
          removed.push(session.id);
        }
      return { ...preview, previewOnly: !apply, removed };
    } finally {
      clearInterval(renew);
      db.exec(`DELETE FROM execution_maintenance WHERE owner=${sql(owner)}`);
    }
  }
  async reconcile() {
    for (const session of this.registry
      .all()
      .filter((s) => s.status === "destroying")) {
      if (await this.active(session))
        throw new ControlError(
          "active_work",
          "Cleanup intent has active authority",
          409,
        );
      if (session.completion?.outcome !== "verified")
        throw new ControlError(
          "recovery_required",
          "Only verified temporary source can reconcile deletion",
          409,
        );
      const present = await lstat(dirname(session.path)).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!present)
        this.registry.save({
          ...session,
          status: "destroyed",
          container: undefined,
        });
      else {
        await this.registry.owned(session);
        this.registry.save({ ...session, status: "checkpointed" });
      }
    }
  }
}
