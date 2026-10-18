import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { sql } from "../sqlite.js";
import type { ControlStore } from "./store.js";
import { safeDiagnosticText } from "./reliability.js";
import { ControlError } from "./schema.js";

/** Metadata only by default. Prompts, checkpoints, raw events and response bodies are deliberately not copied. */
export function supportBundle(
  store: ControlStore,
  goalId: string,
  attemptId?: string,
  reviewedExcerpts: string[] = [],
) {
  const goal = store.getGoal(goalId);
  if (
    reviewedExcerpts.length > 10 ||
    reviewedExcerpts.some((s) => s.length > 2048)
  )
    throw new ControlError(
      "bundle_limit",
      "Reviewed excerpts exceed the bound",
      400,
    );
  const selected = attemptId
    ? store.db.one<{ id: string }>(
        `SELECT id FROM control_attempts WHERE id=${sql(attemptId)} AND goal_id=${sql(goalId)}`,
      )
    : undefined;
  if (attemptId && !selected)
    throw new ControlError(
      "not_found",
      "Attempt does not belong to this goal",
      404,
    );
  const attempts = store.attempts(goalId, 500, "", attemptId).map((a) => ({
    id: a.id,
    operation: a.operation,
    generation: a.generation,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    outcome: a.outcome,
    configurationHash: a.configurationHash,
    executionSessionId: a.executionSessionId,
    runtime: a.runtime,
    usage: a.usage,
    usageReconciliation: a.usageReconciliation
      ? {
          status: a.usageReconciliation.status,
          costUsd: a.usageReconciliation.costUsd,
        }
      : undefined,
  }));
  if (attemptId && !attempts.length)
    throw new ControlError(
      "not_found",
      "Attempt does not belong to this goal",
      404,
    );
  const bundle = {
    version: 1,
    goalId,
    status: goal.status,
    generatedAt: store.clock(),
    configuration: {
      backend: goal.config.backend.kind,
      model: goal.config.backend.model,
      execution: goal.config.admission?.executionMode,
      runtimeHash: goal.config.admission?.runtimeHash,
      image: goal.config.containerImage,
    },
    attempts,
    diagnostics: store.reliability.page(
      "inference_diagnostics",
      goalId,
      attemptId,
      500,
    ),
    incidents: store.reliability.page(
      "reliability_incidents",
      goalId,
      attemptId,
      500,
    ),
    evidence: store.db
      .query(
        `SELECT e.* FROM control_evidence e JOIN control_tasks t ON t.id=e.task_id WHERE t.goal_id=${sql(goalId)} ${attemptId ? `AND e.task_id=(SELECT task_id FROM control_attempts WHERE id=${sql(attemptId)}) AND e.generation=(SELECT generation FROM control_attempts WHERE id=${sql(attemptId)})` : ""} ORDER BY e.created_at LIMIT 500`,
      )
      .map((e: any) => ({
        id: e.id,
        kind: e.kind,
        commit: e.commit_sha,
        generation: e.generation,
        passed: e.passed,
        recordedAt: e.created_at,
      })),
    reviewedExcerpts: reviewedExcerpts.map((s) =>
      safeDiagnosticText(s, store.redactor),
    ),
  };
  const sanitized = store.redactor.value(bundle) as typeof bundle;
  const bytes = JSON.stringify(sanitized);
  if (Buffer.byteLength(bytes) > 4 * 1024 * 1024)
    throw new ControlError(
      "bundle_limit",
      "Selected bundle exceeds 4 MiB",
      400,
    );
  return {
    manifest: {
      version: 1,
      goalId,
      attemptId,
      bytes: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sections: Object.keys(bundle),
      pageLimit: 500,
      possiblyTruncatedSections: [
        "attempts",
        "diagnostics",
        "incidents",
        "evidence",
      ].filter((section) => (bundle as any)[section].length === 500),
      reviewedExcerptCount: reviewedExcerpts.length,
    },
    bundle: sanitized,
  };
}
export async function writeSupportBundle(destination: string, bundle: unknown) {
  if (!isAbsolute(destination))
    throw Error("Support destination must be absolute");
  const parent = await realpath(dirname(destination));
  if (parent !== dirname(destination))
    throw Error("Support parent must be canonical");
  const info = await lstat(parent);
  if ((info.mode & 0o077) !== 0)
    throw Error("Support parent must be private (0700)");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const tracked = await promisify(execFile)(
    "git",
    ["-C", parent, "rev-parse", "--show-toplevel"],
    { timeout: 5000 },
  ).then(
    () => true,
    () => false,
  );
  if (tracked)
    throw Error("Support exports must stay outside Git repositories");
  const file = await open(destination, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(bundle, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
}
