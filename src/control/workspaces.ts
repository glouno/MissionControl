import {
  mkdir,
  writeFile,
  open,
  rename,
  rm,
  realpath,
  lstat,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { ControlError, type Goal, type Task } from "./schema.js";
import { git } from "./git.js";
import { StorageManager, storageDefaults } from "./storage.js";
import { RepositoryManager, parseWorktrees } from "./repositories.js";
import type { SqliteStore } from "../sqlite.js";
export { git } from "./git.js";
export class PublicationConflict extends ControlError {
  constructor(
    readonly candidate: { path: string; goalSha: string; targetSha: string },
  ) {
    super(
      "merge_conflict",
      `Development merge conflict retained at ${candidate.path}`,
      409,
    );
  }
}
export class TaskIntegrationConflict extends PublicationConflict {}
export class WorkspaceManager {
  readonly repositories: RepositoryManager;
  readonly storage: StorageManager;
  constructor(
    readonly root: string,
    applicationDb?: SqliteStore,
    storagePolicy: typeof storageDefaults = storageDefaults,
  ) {
    this.repositories = new RepositoryManager(root, applicationDb);
    this.storage = new StorageManager(
      root,
      join(root, "recovery"),
      Date.now,
      applicationDb,
      storagePolicy,
    );
  }
  goalPath(g: Goal) {
    return join(this.root, "goals", g.id, "integration");
  }
  taskPath(t: Task) {
    return join(this.root, "goals", t.goalId, "tasks", t.id);
  }
  goalBranch(g: Goal) {
    return `missioncontrol/${g.id}/integration`;
  }
  taskBranch(t: Task) {
    return `missioncontrol/${t.goalId}/${t.id}`;
  }
  async prepareGoal(g: Goal) {
    return this.repositories.exclusive(`goal:${g.id}`, async () => {
      const path = this.goalPath(g);
      const retained = this.storage.workspaces().find((w) => w.id === g.id);
      if (
        retained &&
        ["cleaning", "cleaned", "archived", "cleanup_failed"].includes(
          retained.status,
        )
      )
        throw new ControlError(
          "workspace_retained",
          "Restore or reconcile retired goal source explicitly; do not recreate it",
          409,
        );
      if (
        !this.repositories.record(g.id) &&
        !(await this.storage.pressure()).admissionAllowed
      )
        throw new ControlError(
          "storage_pressure",
          "New workspace admission requires the configured free storage reserve",
          409,
        );
      const base = await this.repositories.resolveGoal(
        g,
        path,
        this.goalBranch(g),
      );
      await mkdir(join(this.root, "goals", g.id, "tasks"), { recursive: true });
      const entries = parseWorktrees(
        await git(base.repositoryPath, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]),
      );
      const existing = entries.find((w) => w.path === path);
      if (existing && existing.branch !== `refs/heads/${this.goalBranch(g)}`)
        throw new ControlError(
          "workspace_lineage",
          "Recorded workspace has another branch",
          409,
        );
      if (!existing) {
        const branch = await git(base.repositoryPath, [
          "rev-parse",
          "--verify",
          `refs/heads/${this.goalBranch(g)}`,
        ]).catch(() => "");
        await git(base.repositoryPath, [
          "worktree",
          "add",
          ...(branch ? [] : ["-b", this.goalBranch(g)]),
          path,
          branch ? this.goalBranch(g) : base.baseSha,
        ]);
      }
      const prior = this.storage.workspaces().find((w) => w.id === g.id);
      this.storage.register({
        ...prior,
        id: g.id,
        goalId: g.id,
        kind: "goal",
        path,
        baseSha: base.baseSha,
        headSha: await git(path, ["rev-parse", "HEAD"]),
        generation: 0,
        status: prior?.status ?? "retained",
        lastActivityAt: Date.now(),
        unfinished: prior?.unfinished ?? true,
      });
      return path;
    });
  }
  async prepareTask(g: Goal, t: Task) {
    await this.prepareGoal(g);
    return this.repositories.exclusive(`task:${t.id}`, async () => {
      const path = this.taskPath(t);
      const retained = this.storage.workspaces().find((w) => w.id === t.id);
      if (
        retained &&
        ["cleaning", "cleaned", "archived", "cleanup_failed"].includes(
          retained.status,
        )
      )
        throw new ControlError(
          "workspace_retained",
          "Restore or reconcile retired task source explicitly; do not recreate it",
          409,
        );
      const goalBase = this.repositories.record(g.id)!;
      const entries = parseWorktrees(
        await git(goalBase.repositoryPath, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]),
      );
      const existing = entries.find((w) => w.path === path);
      let base = this.repositories.record(t.id);
      if (!base && !(await this.storage.pressure()).admissionAllowed)
        throw new ControlError(
          "storage_pressure",
          "New task workspace waits for storage reserve",
          409,
        );
      if (!base) {
        const baseSha = existing
          ? await git(path, ["merge-base", "HEAD", this.goalBranch(g)])
          : await git(this.goalPath(g), ["rev-parse", "HEAD"]);
        base = this.repositories.save({
          ...goalBase,
          owner: t.id,
          path,
          baseSha,
          integrationRef: this.taskBranch(t),
          disposition: existing ? "recovered" : "fresh",
        });
      }
      if (existing && existing.branch !== `refs/heads/${this.taskBranch(t)}`)
        throw new ControlError(
          "workspace_lineage",
          "Task workspace branch changed",
          409,
        );
      if (!existing) {
        const branch = await git(base.repositoryPath, [
          "rev-parse",
          "--verify",
          `refs/heads/${this.taskBranch(t)}`,
        ]).catch(() => "");
        await git(base.repositoryPath, [
          "worktree",
          "add",
          ...(branch ? [] : ["-b", this.taskBranch(t)]),
          path,
          branch ? this.taskBranch(t) : base.baseSha,
        ]);
      }
      this.storage.register({
        id: t.id,
        goalId: g.id,
        taskId: t.id,
        kind: "task",
        path,
        baseSha: base.baseSha,
        headSha: await git(path, ["rev-parse", "HEAD"]),
        generation: t.generation,
        status: "active",
        lastActivityAt: Date.now(),
        unfinished: true,
      });
      return { path, branch: this.taskBranch(t), baseCommit: base.baseSha };
    });
  }
  taskBase(t: Task) {
    const record = this.repositories.record(t.id);
    if (!record)
      throw new ControlError(
        "workspace_lineage",
        "Task base has not been recorded",
        409,
      );
    return record.baseSha;
  }
  async checkpoint(t: Task, summary: string) {
    const path = this.taskPath(t);
    if (await git(path, ["status", "--porcelain"])) {
      await git(path, ["add", "-A"]);
      await git(path, [
        "-c",
        "user.name=MissionControl",
        "-c",
        "user.email=missioncontrol@localhost",
        "commit",
        "-m",
        `Checkpoint ${t.key}`,
      ]);
    }
    const commit = await git(path, ["rev-parse", "HEAD"]);
    await writeFile(
      join(this.root, "goals", t.goalId, `${t.id}-checkpoint.json`),
      JSON.stringify(
        this.repositories.db.redactor.value({ commit, summary }),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const record = this.storage.workspaces().find((w) => w.id === t.id);
    if (record)
      this.storage.register({
        ...record,
        headSha: commit,
        status: "checkpointed",
        lastActivityAt: Date.now(),
      });
    return { commit, summary };
  }
  async commit(t: Task) {
    const path = this.taskPath(t);
    if (await git(path, ["status", "--porcelain"])) {
      await git(path, ["add", "-A"]);
      await git(path, [
        "-c",
        "user.name=MissionControl",
        "-c",
        "user.email=missioncontrol@localhost",
        "commit",
        "-m",
        t.spec.title,
      ]);
    }
    return git(path, ["rev-parse", "HEAD"]);
  }
  async candidate(g: Goal, t: Task) {
    const path = join(
      this.root,
      "goals",
      g.id,
      `candidate-${t.id}-${t.generation}`,
    );
    const repository = this.repositories.record(g.id)!.repositoryPath;
    const existing = parseWorktrees(
      await git(repository, ["worktree", "list", "--porcelain", "-z"]),
    ).find((w) => w.path === path);
    if (existing) {
      const head = await git(path, ["rev-parse", "HEAD"]);
      const mergeHead = await git(path, [
        "rev-parse",
        "--verify",
        "MERGE_HEAD",
      ]).catch(() => "");
      if (mergeHead)
        throw new TaskIntegrationConflict({
          path,
          goalSha: head,
          targetSha: mergeHead,
        });
      if (
        !(await git(path, ["status", "--porcelain"])) &&
        (await git(path, [
          "merge-base",
          "--is-ancestor",
          this.taskBranch(t),
          head,
        ]).then(
          () => true,
          () => false,
        ))
      )
        return this.recordCandidate(g, path, head, "task-candidate", t);
      throw new ControlError(
        "merge_conflict",
        `Unresolved integration candidate retained at ${path}`,
        409,
      );
    }
    await git(repository, [
      "worktree",
      "add",
      "--detach",
      path,
      await git(this.goalPath(g), ["rev-parse", "HEAD"]),
    ]);
    await this.recordCandidate(
      g,
      path,
      await git(path, ["rev-parse", "HEAD"]),
      "task-candidate",
      t,
    );
    try {
      await git(path, [
        "-c",
        "user.name=MissionControl",
        "-c",
        "user.email=missioncontrol@localhost",
        "merge",
        "--no-edit",
        this.taskBranch(t),
      ]);
    } catch (error) {
      const targetSha = await git(path, [
        "rev-parse",
        "--verify",
        "MERGE_HEAD",
      ]).catch(() => "");
      if (!targetSha) throw error;
      throw new TaskIntegrationConflict({
        path,
        goalSha: await git(path, ["rev-parse", "HEAD"]),
        targetSha,
      });
    }
    return this.recordCandidate(
      g,
      path,
      await git(path, ["rev-parse", "HEAD"]),
      "task-candidate",
      t,
    );
  }
  private async recordCandidate(
    g: Goal,
    path: string,
    commit: string,
    kind: "task-candidate" | "publication-candidate",
    task?: Task,
  ) {
    const id = `${g.id}_${path.split("/").at(-1)!.replaceAll("-", "_")}`;
    const prior = this.storage.workspaces().find((w) => w.id === id);
    this.storage.register({
      ...prior,
      id,
      goalId: g.id,
      taskId: task?.id,
      kind,
      path,
      baseSha: this.repositories.record(g.id)!.baseSha,
      headSha: commit,
      generation: task?.generation ?? 0,
      status: prior?.status ?? "checkpointed",
      unfinished: prior?.unfinished ?? true,
      lastActivityAt: Date.now(),
    });
    return { path, commit };
  }
  async recordPublication(
    g: Goal,
    candidateSha: string,
    url: string,
    recordedAt: number,
  ) {
    const goalPath = this.goalPath(g);
    const goalRecord = this.storage.workspaces().find((w) => w.id === g.id);
    if (
      goalRecord &&
      ["cleaning", "cleaned", "archived", "cleanup_failed"].includes(
        goalRecord.status,
      )
    )
      return;
    if ((await git(goalPath, ["rev-parse", "HEAD"])) !== candidateSha)
      throw new ControlError(
        "stale_commit",
        "Published goal head differs from verified candidate",
        409,
      );
    for (const record of this.storage
      .workspaces()
      .filter((w) => w.goalId === g.id)) {
      // Unaccepted or conflicting candidates retain unfinished status. Only an
      // immutable clean revision contained in the published goal can be retained.
      if (
        [
          "cleaning",
          "cleaned",
          "archiving",
          "archived",
          "cleanup_failed",
        ].includes(record.status)
      )
        continue;
      const head = await git(record.path, ["rev-parse", "HEAD"]);
      if (await git(record.path, ["status", "--porcelain"])) continue;
      if (
        !(await git(goalPath, [
          "merge-base",
          "--is-ancestor",
          head,
          candidateSha,
        ]).then(
          () => true,
          () => false,
        ))
      )
        continue;
      this.storage.register({
        ...record,
        headSha: head,
        status: "retained",
        unfinished: false,
        acceptedAt: record.publication ? record.acceptedAt : recordedAt,
        publication: { candidateSha, url, recordedAt },
        lastActivityAt: recordedAt,
      });
    }
  }
  async refreshCandidate(g: Goal) {
    const base = this.repositories.record(g.id)!;
    let targetSha: string;
    if (g.config.repository?.mode === "local") {
      const observed = await git(g.config.repoPath, [
        "rev-parse",
        `refs/heads/${base.targetRef}^{commit}`,
      ]);
      await this.repositories.exclusive(
        `fetch:${base.repositoryId}`,
        async () => {
          await git(base.repositoryPath, [
            "fetch",
            "--no-tags",
            "origin",
            `+refs/heads/${base.targetRef}:refs/heads/${base.targetRef}`,
          ]);
        },
      );
      targetSha = await git(base.repositoryPath, [
        "rev-parse",
        `refs/heads/${base.targetRef}^{commit}`,
      ]);
      if (targetSha !== observed)
        throw new ControlError(
          "stale_base",
          "Local branch changed during integration refresh",
          409,
        );
    } else {
      if (g.config.repository?.mode !== "remote")
        throw new ControlError(
          "repository_policy",
          "Remote publication requires audited remote mode",
          409,
        );
      await this.repositories.exclusive(
        `fetch:${base.repositoryId}`,
        async () => {
          try {
            await git(base.repositoryPath, [
              "fetch",
              "--no-tags",
              "origin",
              `+refs/heads/${base.targetRef}:refs/remotes/origin/${base.targetRef}`,
            ]);
          } catch {
            throw new ControlError(
              "fetch_pending",
              "Development refresh failed; publication waits",
              409,
            );
          }
        },
      );
      targetSha = await git(base.repositoryPath, [
        "rev-parse",
        `refs/remotes/origin/${base.targetRef}^{commit}`,
      ]);
    }
    const goalSha = await git(this.goalPath(g), ["rev-parse", "HEAD"]);
    const path = join(
      this.root,
      "goals",
      g.id,
      `publication-${goalSha}-${targetSha}`,
    );
    const exists = parseWorktrees(
      await git(base.repositoryPath, ["worktree", "list", "--porcelain", "-z"]),
    ).some((w) => w.path === path);
    if (!exists)
      await git(base.repositoryPath, [
        "worktree",
        "add",
        "--detach",
        path,
        goalSha,
      ]);
    else if (await git(path, ["status", "--porcelain"]))
      throw new PublicationConflict({ path, goalSha, targetSha });
    await this.recordCandidate(
      g,
      path,
      await git(path, ["rev-parse", "HEAD"]),
      "publication-candidate",
    );
    try {
      await git(path, [
        "-c",
        "user.name=MissionControl",
        "-c",
        "user.email=missioncontrol@localhost",
        "merge",
        "--no-edit",
        targetSha,
      ]);
    } catch {
      throw new PublicationConflict({ path, goalSha, targetSha });
    }
    await this.recordCandidate(
      g,
      path,
      await git(path, ["rev-parse", "HEAD"]),
      "publication-candidate",
    );
    return {
      path,
      commit: await git(path, ["rev-parse", "HEAD"]),
      targetSha,
      goalSha,
    };
  }
  async advance(g: Goal, candidate: { path: string; commit: string }) {
    await git(this.goalPath(g), ["merge", "--ff-only", candidate.commit]);
    return git(this.goalPath(g), ["rev-parse", "HEAD"]);
  }
  async changed(g: Goal, t: Task) {
    return (
      await git(this.taskPath(t), [
        "diff",
        "--name-only",
        this.taskBase(t),
        "HEAD",
      ])
    )
      .split("\n")
      .filter(Boolean);
  }
  async report(g: Goal, body: unknown) {
    const directory = join(this.root, "goals", g.id),
      path = join(directory, "report.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await realpath(directory)) !== resolve(directory))
      throw new ControlError(
        "report_path",
        "Report directory is redirected",
        409,
      );
    try {
      const existing = await lstat(path);
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        existing.nlink !== 1
      )
        throw new ControlError(
          "report_path",
          "Report must be a private regular file",
          409,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = join(directory, `.report-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify(this.repositories.db.redactor.value(body), null, 2) +
            "\n",
        );
        await file.sync();
      } finally {
        await file.close();
      }
      if ((await realpath(directory)) !== resolve(directory))
        throw new ControlError("report_path", "Report directory changed", 409);
      await rename(temporary, path);
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return path;
  }
}
