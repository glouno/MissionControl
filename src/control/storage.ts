import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  realpath,
  readFile,
  writeFile,
  copyFile,
  readdir,
  statfs,
  rm,
} from "node:fs/promises";
import { join, resolve, relative, dirname, basename } from "node:path";
import { SqliteStore, sql, registryDatabase } from "../sqlite.js";
import { ControlError } from "./schema.js";
import { git } from "./git.js";
import { parseWorktrees } from "./repositories.js";
import { StatePaths } from "./statePaths.js";
export const storageDefaults = {
  mergedRetentionMs: 7 * 86400000,
  archiveRetentionMs: 90 * 86400000,
  archiveBudgetBytes: 20 * 1024 ** 3,
  cacheBudgetBytes: 30 * 1024 ** 3,
  freeReserveBytes: 5 * 1024 ** 3,
};
export interface ManagedWorkspace {
  id: string;
  goalId: string;
  taskId?: string;
  kind?:
    | "goal"
    | "task"
    | "task-candidate"
    | "publication-candidate"
    | "repair-candidate";
  publication?: { candidateSha: string; url: string; recordedAt: number };
  path: string;
  baseSha: string;
  headSha: string;
  generation: number;
  status:
    | "preparing"
    | "active"
    | "checkpointed"
    | "waiting"
    | "retained"
    | "archiving"
    | "archived"
    | "cleaning"
    | "cleaned"
    | "cleanup_failed";
  acceptedAt?: number;
  archiveId?: string;
  lastActivityAt: number;
  sizeBytes?: number;
  pinned?: boolean;
  unfinished: boolean;
  branchCleanup?: {
    repositoryPath: string;
    ref: string;
    headSha: string;
    status: "retained" | "deleting" | "deleted";
  };
}
interface ArchiveManifest {
  id: string;
  workspaceId: string;
  createdAt: number;
  headSha: string;
  baseSha: string;
  bundleHash: string;
  bundleBytes: number;
  files: { path: string; hash: string; bytes: number }[];
  unfinished: boolean;
  verified: boolean;
  disposition?: "retained" | "evicting" | "evicted";
  offHostBackup?: { encrypted: true; location: string; verifiedAt: number };
}
const digest = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
const secretPath = (path: string) =>
  /(^|\/)(\.env(?:\..*)?|\.azure|\.ssh|\.aws|\.codex|\.claude|credentials?|.*\.(pem|key|pfx))($|\/)/i.test(
    path,
  );
const disposablePath = (path: string) =>
  /(^|\/)(node_modules|\.venv|venv|__pycache__|\.cache|\.pytest_cache|\.ruff_cache|\.next|dist|build|coverage)($|\/)/.test(
    path,
  );
export class StorageManager {
  readonly db: SqliteStore;
  readonly paths: StatePaths;
  constructor(
    readonly managedRoot: string,
    readonly recoveryRoot: string,
    readonly clock = Date.now,
    applicationDb?: SqliteStore,
    readonly policy: typeof storageDefaults = storageDefaults,
  ) {
    this.db =
      applicationDb ?? registryDatabase(managedRoot, "storage-registry.db");
    this.paths = new StatePaths(managedRoot, this.db);
    if (applicationDb) return;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY,record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS maintenance(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);",
    );
  }
  register(w: ManagedWorkspace) {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(w.id) ||
      !w.path.startsWith(resolve(this.managedRoot) + "/")
    )
      throw new ControlError(
        "storage_path",
        "Workspace must be controller-owned under managed root",
      );
    const existing = this.db.one<{ record: string }>(
      `SELECT record FROM workspaces WHERE id=${sql(w.id)}`,
    );
    if (
      existing &&
      this.paths.decode(JSON.parse(existing.record).path) !== w.path
    )
      throw new ControlError(
        "storage_path",
        "Workspace record cannot change path",
        409,
      );
    this.db.exec(
      `INSERT INTO workspaces VALUES(${sql(w.id)},${sql(this.db.redactor.json({ ...w, path: this.paths.encode(w.path), branchCleanup: w.branchCleanup ? { ...w.branchCleanup, repositoryPath: this.paths.optionalEncode(w.branchCleanup.repositoryPath) } : undefined }))}) ON CONFLICT(id) DO UPDATE SET record=excluded.record`,
    );
    return w;
  }
  workspaces() {
    return this.db
      .query<{ record: string }>("SELECT record FROM workspaces")
      .map((r) => {
        const w: ManagedWorkspace = JSON.parse(r.record);
        return {
          ...w,
          path: this.paths.decode(w.path),
          branchCleanup: w.branchCleanup
            ? {
                ...w.branchCleanup,
                repositoryPath: this.paths.optionalDecode(
                  w.branchCleanup.repositoryPath,
                ),
              }
            : undefined,
        };
      });
  }
  archives() {
    return this.db
      .query<{ record: string }>("SELECT record FROM archives")
      .map((r) => JSON.parse(r.record) as ArchiveManifest);
  }
  private saveArchive(a: ArchiveManifest) {
    this.db.exec(
      `INSERT INTO archives VALUES(${sql(a.id)},${sql(this.db.redactor.json(a))}) ON CONFLICT(id) DO UPDATE SET record=excluded.record`,
    );
    return a;
  }
  private async owned(path: string, root = this.managedRoot) {
    const canonicalRoot = await realpath(root),
      canonical = await realpath(path);
    if (
      (await lstat(path)).isSymbolicLink() ||
      canonical !== resolve(path) ||
      !canonical.startsWith(canonicalRoot + "/")
    )
      throw new ControlError(
        "storage_path",
        "Refuse non-owned or redirected workspace",
        409,
      );
  }
  async pressure() {
    const fs = await statfs(this.managedRoot, { bigint: true });
    const freeBytes = Number(fs.bavail * fs.bsize);
    return {
      freeBytes,
      reserveBytes: this.policy.freeReserveBytes,
      admissionAllowed: freeBytes >= this.policy.freeReserveBytes,
    };
  }
  async preview(isActive: (w: ManagedWorkspace) => Promise<boolean>) {
    const pressure = await this.pressure();
    const archives = this.archives().filter((a) => a.disposition !== "evicted");
    const actions = [];
    for (const workspace of this.workspaces()) {
      const reasons: string[] = [];
      try {
        await this.owned(workspace.path);
      } catch {
        reasons.push("ownership or canonical path not verified");
      }
      if (workspace.pinned) reasons.push("pinned workspace");
      try {
        if (await isActive(workspace)) reasons.push("active lease or process");
      } catch {
        reasons.push("goal or execution authority cannot be reconciled");
      }
      if (!["retained", "archived"].includes(workspace.status))
        reasons.push("not checkpointed for cleanup");
      const archive = archives.find((a) => a.id === workspace.archiveId);
      if (workspace.unfinished && !archive?.verified)
        reasons.push("unfinished source has no verified recovery archive");
      if (
        !workspace.unfinished &&
        (!workspace.acceptedAt ||
          this.clock() - workspace.acceptedAt < this.policy.mergedRetentionMs)
      )
        reasons.push("merged retention window");
      actions.push({ workspace, eligible: !reasons.length, reasons });
    }
    const archiveBytes = archives.reduce(
      (n, a) => n + a.bundleBytes + a.files.reduce((s, f) => s + f.bytes, 0),
      0,
    );
    return {
      previewOnly: true,
      pressure,
      actions,
      archiveBytes,
      archiveBudgetBytes: this.policy.archiveBudgetBytes,
      archiveEviction: archives.map((a) => ({
        id: a.id,
        eligible:
          this.clock() - a.createdAt >= this.policy.archiveRetentionMs &&
          !a.unfinished,
        reason: a.unfinished
          ? "sole unfinished recovery copy requires verified encrypted off-host backup"
          : "retention applies",
      })),
    };
  }
  async maintenancePreview(
    isActive: (w: ManagedWorkspace) => Promise<boolean>,
  ) {
    return this.exclusiveMaintenance(() => this.preview(isActive));
  }
  async exclusiveMaintenance<T>(action: () => Promise<T>) {
    const owner = randomUUID();
    const admitted = this.db.transaction(() => {
      this.db.exec(`DELETE FROM maintenance WHERE expires<${this.clock()}`);
      this.db.exec(
        `INSERT OR IGNORE INTO maintenance VALUES('hourly',${sql(owner)},${this.clock() + 60000})`,
      );
      return (
        this.db.one<{ owner: string }>(
          "SELECT owner FROM maintenance WHERE name='hourly'",
        )?.owner === owner
      );
    });
    if (!admitted)
      throw new ControlError(
        "active_work",
        "Maintenance lease already held",
        409,
      );
    const renew = setInterval(() => {
      this.db.exec(
        `UPDATE maintenance SET expires=${this.clock() + 60000} WHERE name='hourly' AND owner=${sql(owner)}`,
      );
    }, 10000);
    renew.unref();
    try {
      return await action();
    } finally {
      clearInterval(renew);
      this.db.exec(
        `DELETE FROM maintenance WHERE name='hourly' AND owner=${sql(owner)}`,
      );
    }
  }
  async archive(
    id: string,
    classification: Record<string, "retain" | "disposable" | "credential">,
    assertInactive: (w: ManagedWorkspace) => Promise<void>,
  ) {
    const workspace = this.workspaces().find((w) => w.id === id);
    if (!workspace)
      throw new ControlError("not_found", "Workspace not found", 404);
    await this.owned(workspace.path);
    await assertInactive(workspace);
    if (
      workspace.pinned ||
      ["active", "preparing", "cleaning"].includes(workspace.status)
    )
      throw new ControlError(
        "active_work",
        "Workspace cannot be archived yet",
        409,
      );
    if (
      await git(workspace.path, [
        "status",
        "--porcelain",
        "--untracked-files=no",
      ])
    )
      throw new ControlError(
        "checkpoint_required",
        "Commit tracked source before archival",
        409,
      );
    const history = await git(workspace.path, [
      "rev-list",
      "--objects",
      "HEAD",
    ]);
    if (
      history
        .split("\n")
        .some((line) => secretPath(line.slice(line.indexOf(" ") + 1)))
    )
      throw new ControlError(
        "archive_secret",
        "Git history contains a credential-like path; classify and use encrypted recovery before archival",
        409,
      );
    const headSha = await git(workspace.path, ["rev-parse", "HEAD"]);
    if (headSha !== workspace.headSha)
      throw new ControlError(
        "stale_commit",
        "Workspace head differs from registry",
        409,
      );
    const others = (
      await git(workspace.path, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean);
    const ignored = (
      await git(workspace.path, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean);
    for (const file of [...others, ...ignored]) {
      if (!classification[file] && !disposablePath(file) && !secretPath(file))
        throw new ControlError(
          "classification_required",
          `Classify non-Git file before cleanup: ${file}`,
          409,
        );
      if (
        classification[file] === "retain" &&
        (secretPath(file) || disposablePath(file))
      )
        throw new ControlError(
          "archive_secret",
          "Credentials and disposable build outputs cannot enter recovery archives",
          409,
        );
    }
    const archiveId = `archive_${randomUUID().replaceAll("-", "")}`;
    const directory = join(this.recoveryRoot, archiveId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.register({ ...workspace, status: "archiving", archiveId });
    const bundle = join(directory, "source.bundle");
    await git(workspace.path, ["bundle", "create", bundle, "HEAD"]);
    await git(workspace.path, ["bundle", "verify", bundle]);
    const bytes = await readFile(bundle);
    const files: ArchiveManifest["files"] = [];
    for (const file of [...others, ...ignored].filter(
      (f) => classification[f] === "retain",
    )) {
      const source = resolve(workspace.path, file);
      if (!source.startsWith(workspace.path + "/"))
        throw new ControlError("archive_path", "Invalid artifact path");
      await this.owned(source);
      if (!(await lstat(source)).isFile())
        throw new ControlError(
          "archive_path",
          "Only normal retained artifact files can be archived",
        );
      const destination = join(directory, "files", file);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
      const content = await readFile(destination);
      files.push({ path: file, hash: digest(content), bytes: content.length });
    }
    const archive = this.saveArchive({
      id: archiveId,
      workspaceId: id,
      createdAt: this.clock(),
      headSha,
      baseSha: workspace.baseSha,
      bundleHash: digest(bytes),
      bundleBytes: bytes.length,
      files,
      unfinished: workspace.unfinished,
      verified: false,
    });
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify(archive, null, 2),
      { mode: 0o600 },
    );
    await assertInactive(workspace);
    await this.verifyArchive(archiveId);
    this.register({ ...workspace, status: "archived", archiveId });
    return this.archives().find((a) => a.id === archiveId)!;
  }
  async verifyArchive(id: string) {
    const archive = this.archives().find((a) => a.id === id);
    if (!archive) throw new ControlError("not_found", "Archive not found", 404);
    if (archive.disposition === "evicted")
      throw new ControlError(
        "archive_evicted",
        "Recovery archive was evicted under retention policy",
        409,
      );
    const directory = join(this.recoveryRoot, id);
    await this.owned(directory, this.recoveryRoot);
    if (
      digest(await readFile(join(directory, "source.bundle"))) !==
      archive.bundleHash
    )
      throw new ControlError("archive_corrupt", "Bundle hash mismatch", 409);
    for (const file of archive.files) {
      const path = resolve(directory, "files", file.path);
      if (!path.startsWith(resolve(directory, "files") + "/"))
        throw new ControlError("archive_path", "Invalid retained file path");
      await this.owned(path, this.recoveryRoot);
      if (digest(await readFile(path)) !== file.hash)
        throw new ControlError(
          "archive_corrupt",
          "Artifact hash mismatch",
          409,
        );
    }
    return this.saveArchive({ ...archive, verified: true });
  }
  async evictArchives(
    isActive: (w: ManagedWorkspace) => Promise<boolean>,
    apply = false,
  ) {
    const candidates = [],
      removed: string[] = [],
      errors: { id: string; reason: string }[] = [];
    const archives = this.archives().filter((a) => a.disposition !== "evicted");
    let remainingBytes = archives.reduce(
      (n, a) => n + a.bundleBytes + a.files.reduce((s, f) => s + f.bytes, 0),
      0,
    );
    for (const archive of archives.sort((a, b) => a.createdAt - b.createdAt)) {
      const reasons: string[] = [];
      if (archive.unfinished)
        reasons.push(
          "unfinished recovery requires separately verified encrypted off-host backup",
        );
      if (this.clock() - archive.createdAt < this.policy.archiveRetentionMs)
        reasons.push("90-day recovery retention");
      for (const w of this.workspaces().filter(
        (w) => w.archiveId === archive.id,
      )) {
        try {
          if (w.pinned || (await isActive(w)))
            reasons.push("pinned or active workspace recovery");
          if (["archiving", "cleaning", "cleanup_failed"].includes(w.status))
            reasons.push("recovery lifecycle is incomplete");
        } catch {
          reasons.push("recovery authority unresolved");
        }
      }
      candidates.push({
        id: archive.id,
        eligible: reasons.length === 0,
        reasons,
      });
      if (
        !apply ||
        reasons.length ||
        (remainingBytes <= this.policy.archiveBudgetBytes &&
          archive.disposition !== "evicting")
      )
        continue;
      try {
        const directory = join(this.recoveryRoot, archive.id);
        const present = await lstat(directory).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (present) {
          await this.verifyArchive(archive.id);
          await this.owned(directory, this.recoveryRoot);
          this.saveArchive({ ...archive, disposition: "evicting" });
          await rm(directory, { recursive: true });
        } else if (archive.disposition !== "evicting")
          throw new ControlError(
            "archive_corrupt",
            "Archive disappeared without eviction intent",
            409,
          );
        this.saveArchive({
          ...archive,
          verified: false,
          disposition: "evicted",
        });
        removed.push(archive.id);
        remainingBytes -=
          archive.bundleBytes + archive.files.reduce((s, f) => s + f.bytes, 0);
      } catch (error) {
        errors.push({ id: archive.id, reason: (error as Error).message });
      }
    }
    return {
      previewOnly: !apply,
      budgetBytes: this.policy.archiveBudgetBytes,
      remainingBytes,
      candidates,
      removed,
      errors,
    };
  }
  async cleanup(
    id: string,
    classification: Record<string, "retain" | "disposable" | "credential">,
    assertInactive: (w: ManagedWorkspace) => Promise<void>,
    assertPublication: (w: ManagedWorkspace) => Promise<void>,
  ) {
    const workspace = this.workspaces().find((w) => w.id === id);
    if (!workspace)
      throw new ControlError("not_found", "Workspace not found", 404);
    if (workspace.status === "cleaned") return workspace;
    if (workspace.pinned)
      throw new ControlError(
        "active_work",
        "Pinned workspace cannot be cleaned",
        409,
      );
    await this.owned(workspace.path);
    await assertInactive(workspace);
    if (!workspace.unfinished) {
      await assertPublication(workspace);
      if (
        !workspace.acceptedAt ||
        this.clock() - workspace.acceptedAt < this.policy.mergedRetentionMs
      )
        throw new ControlError(
          "retention",
          "Merged workspace retention has not elapsed",
          409,
        );
    }
    const nonGit = (
      await git(workspace.path, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean);
    nonGit.push(
      ...(
        await git(workspace.path, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ])
      )
        .split("\0")
        .filter(Boolean),
    );
    if (
      nonGit.some(
        (file) => secretPath(file) || classification[file] === "credential",
      )
    )
      throw new ControlError(
        "credential_retention",
        "Move credential files to trusted storage before workspace removal",
        409,
      );
    // Re-archive at the current recorded commit; unknown ignored files still block.
    const archive = await this.archive(id, classification, assertInactive);
    await this.verifyArchive(archive.id);
    const branch = await git(workspace.path, [
      "symbolic-ref",
      "--short",
      "HEAD",
    ]).catch(() => "");
    const detachedCandidate =
      !branch &&
      (workspace.kind === "task-candidate" ||
        workspace.kind === "publication-candidate" ||
        workspace.kind === "repair-candidate") &&
      /^[a-zA-Z0-9_-]+$/.test(workspace.goalId) &&
      dirname(workspace.path) ===
        join(resolve(this.managedRoot), "goals", workspace.goalId) &&
      (workspace.kind === "task-candidate"
        ? /^[a-zA-Z0-9_-]+$/.test(workspace.taskId ?? "") &&
          basename(workspace.path) ===
            `candidate-${workspace.taskId}-${workspace.generation}`
        : workspace.kind === "repair-candidate"
          ? /^repair-[a-f0-9]{24}$/.test(basename(workspace.path))
          : /^publication-[a-f0-9]{40}-[a-f0-9]{40}$/.test(
              basename(workspace.path),
            ));
    if (!branch.startsWith("missioncontrol/") && !detachedCandidate)
      throw new ControlError(
        "storage_owner",
        "Cleanup only removes MissionControl-owned worktrees",
        409,
      );
    const common = await git(workspace.path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (resolve(common) === resolve(workspace.path, ".git"))
      throw new ControlError(
        "storage_owner",
        "Independent source clones require separate retirement",
        409,
      );
    const gitDirectory = await git(workspace.path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]);
    if (!resolve(gitDirectory).startsWith(resolve(common, "worktrees") + "/"))
      throw new ControlError(
        "storage_owner",
        "Workspace is not a registered linked worktree",
        409,
      );
    await assertInactive(workspace);
    if (
      (await git(workspace.path, ["rev-parse", "HEAD"])) !== archive.headSha ||
      (await git(workspace.path, [
        "status",
        "--porcelain",
        "--untracked-files=no",
      ]))
    )
      throw new ControlError(
        "stale_commit",
        "Workspace changed during cleanup",
        409,
      );
    const intent = this.register({
      ...workspace,
      archiveId: archive.id,
      status: "cleaning",
      branchCleanup: branch
        ? {
            repositoryPath: common,
            ref: `refs/heads/${branch}`,
            headSha: archive.headSha,
            status: "retained",
          }
        : undefined,
    });
    try {
      await git(common, ["worktree", "remove", "--force", workspace.path]);
      return this.register({ ...intent, status: "cleaned" });
    } catch (error) {
      this.register({ ...intent, status: "cleanup_failed" });
      throw error;
    }
  }
  async reconcileCleanup(id: string) {
    const workspace = this.workspaces().find((w) => w.id === id);
    if (
      !workspace ||
      !["cleaning", "cleanup_failed"].includes(workspace.status)
    )
      return workspace;
    if (!workspace.archiveId)
      throw new ControlError(
        "archive_required",
        "Cleanup intent has no recovery record",
        409,
      );
    await this.verifyArchive(workspace.archiveId);
    if (!(await lstat(workspace.path).catch(() => null)))
      return this.register({ ...workspace, status: "cleaned" });
    await this.owned(workspace.path);
    return this.register({ ...workspace, status: "cleanup_failed" });
  }
  async reconcileArchive(id: string) {
    const workspace = this.workspaces().find((w) => w.id === id);
    if (!workspace || workspace.status !== "archiving") return workspace;
    await this.owned(workspace.path);
    if (
      workspace.archiveId &&
      this.archives().some((a) => a.id === workspace.archiveId)
    ) {
      await this.verifyArchive(workspace.archiveId);
      if (
        (await git(workspace.path, ["rev-parse", "HEAD"])) !==
          workspace.headSha ||
        (await git(workspace.path, [
          "status",
          "--porcelain",
          "--untracked-files=no",
        ]))
      )
        throw new ControlError(
          "stale_commit",
          "Source changed during archival",
          409,
        );
      return this.register({ ...workspace, status: "archived" });
    }
    // Incomplete archive output is retained for inspection. Never infer recovery
    // success or remove the original source from a partial filesystem action.
    return this.register({
      ...workspace,
      status: "retained",
      archiveId: undefined,
    });
  }
  async cleanupBranch(
    id: string,
    assertInactive: (w: ManagedWorkspace) => Promise<void>,
    assertNoDependencies: (w: ManagedWorkspace) => Promise<void>,
  ) {
    const workspace = this.workspaces().find((w) => w.id === id);
    if (!workspace)
      throw new ControlError("not_found", "Workspace not found", 404);
    const branch = workspace.branchCleanup;
    if (
      !branch ||
      workspace.status !== "cleaned" ||
      workspace.pinned ||
      !workspace.archiveId
    )
      throw new ControlError(
        "recovery_required",
        "Branch cleanup requires removed owned source and recovery",
        409,
      );
    if (branch.status === "deleted") return workspace;
    await this.owned(branch.repositoryPath);
    const expected = `refs/heads/missioncontrol/${workspace.goalId}/${workspace.kind === "goal" ? "integration" : (workspace.taskId ?? workspace.id)}`;
    if (branch.ref !== expected || branch.headSha !== workspace.headSha)
      throw new ControlError(
        "storage_owner",
        "Branch differs from exact owned task/goal ref",
        409,
      );
    const archive = await this.verifyArchive(workspace.archiveId);
    if (archive.headSha !== branch.headSha)
      throw new ControlError(
        "stale_commit",
        "Recovery archive differs from owned branch",
        409,
      );
    await assertInactive(workspace);
    await assertNoDependencies(workspace);
    if (
      parseWorktrees(
        await git(branch.repositoryPath, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]),
      ).some((w) => w.branch === branch.ref)
    )
      throw new ControlError(
        "active_work",
        "Branch is checked out in a worktree",
        409,
      );
    const current = await git(branch.repositoryPath, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      branch.ref,
    ]).then(
      (output) =>
        output
          .split("\n")
          .find((line) => line.startsWith(branch.ref + " "))
          ?.slice(branch.ref.length + 1) ?? "",
    );
    if (!current && branch.status === "deleting")
      return this.register({
        ...workspace,
        branchCleanup: { ...branch, status: "deleted" },
      });
    if (current !== branch.headSha)
      throw new ControlError(
        "stale_commit",
        "Owned branch changed after workspace cleanup",
        409,
      );
    const intent = this.register({
      ...workspace,
      branchCleanup: { ...branch, status: "deleting" },
    });
    // Compare-and-delete the exact ref; never force-delete a moved branch.
    await git(branch.repositoryPath, [
      "update-ref",
      "-d",
      branch.ref,
      branch.headSha,
    ]);
    return this.register({
      ...intent,
      branchCleanup: { ...branch, status: "deleted" },
    });
  }
  async restore(id: string) {
    const archive = await this.verifyArchive(id);
    const destination = join(this.managedRoot, "restored", id);
    await mkdir(dirname(destination), { recursive: true });
    if (await lstat(destination).catch(() => null))
      throw new ControlError(
        "restore_exists",
        "Restore destination already exists",
        409,
      );
    await git(dirname(destination), [
      "clone",
      "--no-local",
      join(this.recoveryRoot, id, "source.bundle"),
      destination,
    ]);
    await git(destination, ["checkout", "--detach", archive.headSha]);
    for (const file of archive.files) {
      const target = resolve(destination, file.path);
      if (!target.startsWith(destination + "/"))
        throw new ControlError("archive_path", "Invalid restore path");
      let parent = dirname(target);
      while (parent !== destination) {
        if ((await lstat(parent).catch(() => null))?.isSymbolicLink())
          throw new ControlError(
            "archive_path",
            "Restore artifact parent is a symlink",
          );
        parent = dirname(parent);
      }
      if ((await lstat(target).catch(() => null))?.isSymbolicLink())
        throw new ControlError("archive_path", "Restore artifact is a symlink");
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(this.recoveryRoot, id, "files", file.path), target);
    }
    return {
      path: destination,
      headSha: await git(destination, ["rev-parse", "HEAD"]),
      archiveId: id,
    };
  }
}
