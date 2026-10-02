import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SqliteStore, sql, registryDatabase } from "../sqlite.js";
import { ControlError, type Goal } from "./schema.js";
import { git } from "./git.js";
import { StatePaths } from "./statePaths.js";

export interface BaseRecord {
  owner: string;
  repositoryId: string;
  repositoryPath: string;
  remoteIdentity: string;
  targetRef: string;
  baseSha: string;
  fetchedAt: string | null;
  integrationRef: string;
  path: string;
  disposition: "fresh" | "recovered";
}
export function repositoryIdentity(url: string) {
  if (/^[\w.-]+@[\w.-]+:/.test(url)) url = `ssh://${url.replace(":", "/")}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const parsed = new URL(url);
    if (
      parsed.password ||
      (parsed.protocol !== "ssh:" && parsed.username) ||
      parsed.search ||
      parsed.hash
    )
      throw new ControlError(
        "repository_policy",
        "Remote URLs must not contain credentials, query parameters or fragments",
      );
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      parsed.hostname === "github.com" &&
      ["ssh:", "https:"].includes(parsed.protocol)
    )
      return `https://github.com${parsed.pathname
        .toLowerCase()
        .replace(/\/$/, "")
        .replace(/\.git$/, "")}`;
    return parsed
      .toString()
      .replace(/\/?$/, "")
      .replace(/\.git$/, "");
  }
  return resolve(url);
}
export async function validateBranch(repo: string, branch: string) {
  if (branch.startsWith("-") || branch === "HEAD")
    throw new ControlError(
      "repository_policy",
      "An explicit branch is required",
    );
  try {
    await git(repo, ["check-ref-format", `refs/heads/${branch}`]);
  } catch {
    throw new ControlError("repository_policy", "Invalid Git branch name");
  }
}
export function parseWorktrees(text: string) {
  // -z avoids quoted paths, embedded newlines and prefix matches.
  const records: { path: string; head?: string; branch?: string }[] = [];
  let record: (typeof records)[number] | undefined;
  for (const field of text.split("\0")) {
    if (field.startsWith("worktree ")) {
      record = { path: field.slice(9) };
      records.push(record);
    } else if (record && field.startsWith("HEAD "))
      record.head = field.slice(5);
    else if (record && field.startsWith("branch "))
      record.branch = field.slice(7);
  }
  return records;
}
export class RepositoryManager {
  readonly db: SqliteStore;
  readonly paths: StatePaths;
  constructor(
    readonly root: string,
    applicationDb?: SqliteStore,
  ) {
    this.db = applicationDb ?? registryDatabase(root, "workspace-registry.db");
    this.paths = new StatePaths(root, this.db);
    if (applicationDb) return;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS bases(owner TEXT PRIMARY KEY,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY,token TEXT NOT NULL,expires INTEGER NOT NULL);`);
  }
  record(owner: string): BaseRecord | undefined {
    const row = this.db.one<{ record: string }>(
      `SELECT record FROM bases WHERE owner=${sql(owner)}`,
    );
    if (!row) return undefined;
    const record: BaseRecord = JSON.parse(row.record);
    return {
      ...record,
      path: this.paths.decode(record.path),
      repositoryPath: this.paths.optionalDecode(record.repositoryPath),
    };
  }
  save(record: BaseRecord) {
    this.db.exec(
      `INSERT INTO bases VALUES(${sql(record.owner)},${sql(this.db.redactor.json({ ...record, path: this.paths.encode(record.path), repositoryPath: this.paths.optionalEncode(record.repositoryPath) }))})`,
    );
    return record;
  }
  async exclusive<T>(name: string, action: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const acquired = this.db.transaction(() => {
      this.db.exec(
        `DELETE FROM leases WHERE name=${sql(name)} AND expires<${Date.now()}`,
      );
      this.db.exec(
        `INSERT OR IGNORE INTO leases VALUES(${sql(name)},${sql(token)},${Date.now() + 300000})`,
      );
      return (
        this.db.one<{ token: string }>(
          `SELECT token FROM leases WHERE name=${sql(name)}`,
        )?.token === token
      );
    });
    if (!acquired)
      throw new ControlError(
        "active_work",
        "Repository operation is already leased",
        409,
      );
    const renew = setInterval(() => {
      this.db.exec(
        `UPDATE leases SET expires=${Date.now() + 300000} WHERE name=${sql(name)} AND token=${sql(token)}`,
      );
    }, 30000);
    renew.unref();
    try {
      const result = await action();
      if (
        this.db.one<{ token: string }>(
          `SELECT token FROM leases WHERE name=${sql(name)}`,
        )?.token !== token
      )
        throw new ControlError("lease_lost", "Repository lease was lost", 409);
      return result;
    } finally {
      clearInterval(renew);
      this.db.exec(
        `DELETE FROM leases WHERE name=${sql(name)} AND token=${sql(token)}`,
      );
    }
  }
  async resolveGoal(
    g: Goal,
    path: string,
    integrationRef: string,
  ): Promise<BaseRecord> {
    const prior = this.record(g.id);
    if (prior) return prior;
    const checkout = await realpath(g.config.repoPath);
    const policy = g.config.repository;
    if (!policy)
      throw new ControlError(
        "repository_policy",
        "New goals require an audited remote policy or explicit local branch mode",
      );
    await validateBranch(checkout, g.config.policy.targetBranch);
    if (
      g.config.policy.targetBranch.startsWith("missioncontrol/") ||
      g.config.policy.targetBranch.startsWith("codex/")
    )
      throw new ControlError(
        "repository_policy",
        "Task branches cannot be integration targets",
      );
    if (policy.mode === "local") {
      if (policy.branch !== g.config.policy.targetBranch)
        throw new ControlError(
          "repository_policy",
          "Local base branch must match publication target",
          409,
        );
      await validateBranch(checkout, policy.branch);
      const baseSha = await git(checkout, [
        "rev-parse",
        `refs/heads/${policy.branch}^{commit}`,
      ]);
      const repositoryId = createHash("sha256").update(checkout).digest("hex");
      const cache = join(this.root, "repositories", `${repositoryId}.git`);
      // All worktree metadata and objects belong to application state, including
      // local projects. Backups must not depend on the user's checkout .git.
      return this.exclusive(`fetch:${repositoryId}`, async () => {
        await mkdir(cache, { recursive: true });
        await git(cache, ["init", "--bare"]);
        const origin = await git(cache, ["remote", "get-url", "origin"]).catch(
          () => "",
        );
        if (!origin) await git(cache, ["remote", "add", "origin", checkout]);
        else if (origin !== checkout)
          throw new ControlError(
            "repository_policy",
            "Local cache source changed",
            409,
          );
        await git(cache, [
          "fetch",
          "--no-tags",
          "origin",
          `+refs/heads/${policy.branch}:refs/heads/${policy.branch}`,
        ]);
        if (
          (await git(cache, [
            "rev-parse",
            `refs/heads/${policy.branch}^{commit}`,
          ])) !== baseSha
        )
          throw new ControlError(
            "stale_base",
            "Local branch changed while preparing goal",
            409,
          );
        return this.save({
          owner: g.id,
          path,
          integrationRef,
          repositoryPath: cache,
          repositoryId,
          remoteIdentity: checkout,
          targetRef: policy.branch,
          baseSha,
          fetchedAt: null,
          disposition: "fresh",
        });
      });
    }
    await validateBranch(checkout, policy.primaryBranch);
    const identity = repositoryIdentity(policy.remoteUrl);
    const repositoryId = createHash("sha256").update(identity).digest("hex");
    const cache = join(this.root, "repositories", `${repositoryId}.git`);
    return this.exclusive(`fetch:${repositoryId}`, async () => {
      await mkdir(cache, { recursive: true });
      await git(cache, ["init", "--bare"]);
      const origin = await git(cache, ["remote", "get-url", "origin"]).catch(
        () => "",
      );
      if (!origin)
        await git(cache, ["remote", "add", "origin", policy.remoteUrl]);
      else if (repositoryIdentity(origin) !== identity)
        throw new ControlError(
          "repository_policy",
          "Cache remote identity changed",
        );
      try {
        await git(cache, [
          "fetch",
          "--no-tags",
          "origin",
          `+refs/heads/${policy.primaryBranch}:refs/remotes/origin/${policy.primaryBranch}`,
        ]);
        const primary = await git(cache, [
          "rev-parse",
          `refs/remotes/origin/${policy.primaryBranch}^{commit}`,
        ]);
        try {
          await git(cache, [
            "merge-base",
            "--is-ancestor",
            policy.auditedPrimarySha,
            primary,
          ]);
        } catch {
          throw new ControlError(
            "repository_policy",
            "Audited primary commit is not in remote primary history; re-audit required",
            409,
          );
        }
        await git(cache, [
          "fetch",
          "--no-tags",
          "origin",
          `+refs/heads/${g.config.policy.targetBranch}:refs/remotes/origin/${g.config.policy.targetBranch}`,
        ]);
      } catch (error) {
        if (error instanceof ControlError) throw error;
        throw new ControlError(
          "fetch_pending",
          "Remote target fetch failed; retry without using local HEAD",
          409,
        );
      }
      const baseSha = await git(cache, [
        "rev-parse",
        `refs/remotes/origin/${g.config.policy.targetBranch}^{commit}`,
      ]);
      return this.save({
        owner: g.id,
        path,
        integrationRef,
        repositoryPath: cache,
        repositoryId,
        remoteIdentity: identity,
        targetRef: g.config.policy.targetBranch,
        baseSha,
        fetchedAt: new Date().toISOString(),
        disposition: "fresh",
      });
    });
  }
}
