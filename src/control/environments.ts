import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  writeFile,
  realpath,
  lstat,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, resolve, matchesGlob } from "node:path";
import { SqliteStore, sql, registryDatabase } from "../sqlite.js";
import { ControlError } from "./schema.js";
import { git } from "./git.js";
import { createHash } from "node:crypto";
import { StatePaths } from "./statePaths.js";
const exec = promisify(execFile);
export interface EnvironmentSpec {
  taskId: string;
  generation: number;
  invocationId?: string;
  goalId?: string;
  workerId?: string;
  authorityGeneration?: number;
  operationReservationId?: string;
  source: string;
  baseSha: string;
  image: string;
  cpu: number;
  memoryMiB: number;
  timeoutMs: number;
  gatewayNetwork?: string;
  gatewayEnv?: Record<string, string>;
  contractSnapshot?: { path: string; digest: string };
}
export interface ExecutionSession {
  id: string;
  taskId: string;
  generation: number;
  path: string;
  baseSha: string;
  image: string;
  imageDigest?: string;
  container?: string;
  status:
    | "preparing"
    | "prepared"
    | "starting"
    | "active"
    | "checkpointed"
    | "stopping"
    | "stopped"
    | "destroying"
    | "destroyed"
    | "failed";
  createdAt: number;
  lastActivityAt: number;
  spec: EnvironmentSpec;
  completion?: {
    outcome: "imported" | "verified" | "failed";
    commit: string;
    recordedAt: number;
    evidence?: unknown;
  };
}
export interface ExecutionEnvironment {
  readonly registry?: EnvironmentRegistry;
  prepare(spec: EnvironmentSpec): Promise<ExecutionSession>;
  acquire(
    id: string,
    gatewayEnv?: Record<string, string>,
  ): Promise<ExecutionSession>;
  execute(
    id: string,
    command: string[],
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }>;
  inspect(id: string): Promise<ExecutionSession>;
  checkpoint(id: string): Promise<ExecutionSession>;
  stop(id: string): Promise<ExecutionSession>;
  reset(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
}
export class EnvironmentRegistry {
  readonly db: SqliteStore;
  readonly paths: StatePaths;
  constructor(
    readonly root: string,
    applicationDb?: SqliteStore,
  ) {
    this.db = applicationDb ?? registryDatabase(root, "execution-registry.db");
    this.paths = new StatePaths(root, this.db);
    if (applicationDb) return;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,generation INTEGER NOT NULL,record TEXT NOT NULL,UNIQUE(task_id,generation));",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS execution_invocations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,generation INTEGER NOT NULL,record TEXT NOT NULL);",
    );
  }
  get(id: string): ExecutionSession {
    const row = this.db.one<{ record: string }>(
      `SELECT record FROM execution_invocations WHERE id=${sql(id)} UNION ALL SELECT record FROM sessions WHERE id=${sql(id)} LIMIT 1`,
    );
    if (!row)
      throw new ControlError("not_found", "Execution session not found", 404);
    const s: ExecutionSession = JSON.parse(row.record);
    return {
      ...s,
      path: this.paths.decode(s.path),
      spec: {
        ...s.spec,
        source: s.spec.source
          ? this.paths.optionalDecode(s.spec.source)
          : s.spec.source,
        contractSnapshot: s.spec.contractSnapshot
          ? {
              ...s.spec.contractSnapshot,
              path: this.paths.decode(s.spec.contractSnapshot.path),
            }
          : undefined,
      },
    };
  }
  all() {
    return this.db
      .query<{ id: string }>(
        "SELECT id FROM sessions UNION SELECT id FROM execution_invocations",
      )
      .map((r) => this.get(r.id));
  }
  save(s: ExecutionSession) {
    this.db.exec(
      `INSERT INTO ${s.spec.invocationId ? "execution_invocations" : "sessions"} VALUES(${sql(s.id)},${sql(s.taskId)},${s.generation},${sql(this.db.redactor.json({ ...s, path: this.paths.encode(s.path), spec: { ...s.spec, source: s.spec.source ? this.paths.optionalEncode(s.spec.source) : s.spec.source, contractSnapshot: s.spec.contractSnapshot ? { ...s.spec.contractSnapshot, path: this.paths.encode(s.spec.contractSnapshot.path) } : undefined } }))}) ON CONFLICT(id) DO UPDATE SET record=excluded.record`,
    );
    if (
      this.db.one(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='control_attempts'",
      )
    ) {
      const attemptId =
        s.spec.operationReservationId ??
        (s.spec.authorityGeneration
          ? `${s.taskId}:${s.spec.authorityGeneration}`
          : undefined);
      if (attemptId)
        this.db.exec(
          `UPDATE control_attempts SET execution_session_id=${sql(s.id)} WHERE id=${sql(attemptId)} AND outcome='active'`,
        );
    }
    return s;
  }
  async owned(s: ExecutionSession) {
    const expected = join(this.root, "execution", s.id, "repo");
    if (
      s.path !== expected ||
      (await lstat(s.path)).isSymbolicLink() ||
      (await realpath(s.path)) !== resolve(expected)
    )
      throw new ControlError(
        "environment_path",
        "Execution workspace ownership mismatch",
        409,
      );
  }
}
export class DockerEnvironment implements ExecutionEnvironment {
  constructor(
    readonly registry: EnvironmentRegistry,
    readonly docker: (
      args: string[],
      signal?: AbortSignal,
    ) => Promise<{ stdout: string; stderr: string }> = (args, signal) =>
      exec("docker", args, {
        signal,
        timeout: args[0] === "exec" ? undefined : 60000,
        maxBuffer: 8 * 1024 * 1024,
      }),
  ) {}
  async prepare(spec: EnvironmentSpec) {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(spec.taskId) ||
      !Number.isInteger(spec.generation) ||
      spec.generation < 1 ||
      (spec.invocationId !== undefined &&
        !/^[a-zA-Z0-9_-]{1,100}$/.test(spec.invocationId)) ||
      !/^[a-f0-9]{40,64}$/.test(spec.baseSha)
    )
      throw new ControlError(
        "environment_policy",
        "Invalid task lease or base",
      );
    if (
      !Number.isFinite(spec.cpu) ||
      spec.cpu < 1 ||
      spec.cpu > 16 ||
      !Number.isInteger(spec.memoryMiB) ||
      spec.memoryMiB < 128 ||
      spec.memoryMiB > 32768 ||
      !Number.isInteger(spec.timeoutMs) ||
      spec.timeoutMs < 1000 ||
      spec.timeoutMs > 3600000
    )
      throw new ControlError(
        "environment_policy",
        "Invalid execution resource allocation",
      );
    const existing = this.registry
      .all()
      .find(
        (s) =>
          s.taskId === spec.taskId &&
          s.generation === spec.generation &&
          s.spec.invocationId === spec.invocationId,
      );
    if (existing && existing.status !== "preparing") {
      if (
        existing.baseSha !== spec.baseSha ||
        existing.image !== spec.image ||
        existing.status === "destroyed"
      )
        throw new ControlError(
          "environment_lineage",
          "Execution session lineage changed",
          409,
        );
      await this.registry.owned(existing);
      return existing;
    }
    const id = existing?.id ?? `session_${randomUUID().replaceAll("-", "")}`;
    const path = join(this.registry.root, "execution", id, "repo");
    let s =
      existing ??
      this.registry.save({
        id,
        taskId: spec.taskId,
        generation: spec.generation,
        path,
        baseSha: spec.baseSha,
        image: spec.image,
        status: "preparing",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        spec,
      });
    await mkdir(dirname(path), { recursive: true });
    // Controller-created private clone: --no-local prevents object hardlinks and alternates.
    const present = await lstat(path).catch(() => null);
    if (!present)
      await git(dirname(path), [
        "clone",
        "--no-local",
        "--no-checkout",
        "--",
        resolve(spec.source),
        path,
      ]);
    await this.registry.owned(s);
    await sanitizeGit(path);
    await git(path, ["checkout", "--detach", spec.baseSha]);
    await git(path, ["remote", "remove", "origin"]).catch(() => {});
    return this.registry.save({
      ...s,
      status: "prepared",
      lastActivityAt: Date.now(),
    });
  }
  async acquire(id: string, gatewayEnv: Record<string, string> = {}) {
    let s = await this.inspect(id);
    if (s.status === "active") return s;
    if (!["prepared", "checkpointed", "stopped", "starting"].includes(s.status))
      throw new ControlError(
        "environment_state",
        "Execution session is not ready",
        409,
      );
    await this.registry.owned(s);
    if (s.path.includes(","))
      throw new ControlError(
        "environment_path",
        "Mount paths cannot contain commas",
      );
    if (s.container) {
      await this.docker(["rm", s.container]);
      s = this.registry.save({ ...s, container: undefined });
    }
    const digest =
      s.imageDigest ??
      JSON.parse(
        (
          await this.docker([
            "image",
            "inspect",
            s.image,
            "--format",
            "{{json .Id}}",
          ])
        ).stdout,
      );
    if (!/^sha256:[a-f0-9]{64}$/.test(digest))
      throw new ControlError(
        "environment_image",
        "Image digest is unavailable",
      );
    const container = `mc-${s.id}`;
    s = this.registry.save({
      ...s,
      imageDigest: digest,
      container,
      status: "starting",
    });
    if (s.spec.gatewayNetwork) {
      const network = JSON.parse(
        (await this.docker(["network", "inspect", s.spec.gatewayNetwork]))
          .stdout,
      )[0];
      if (
        !network.Internal ||
        network.Driver !== "bridge" ||
        network.EnableIPv6 ||
        network.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] !==
          "isolated" ||
        network.Labels?.["missioncontrol.gateway"] !== "true"
      )
        throw new ControlError(
          "environment_network",
          "Worker gateway network must be isolated, internal and controller-owned",
          409,
        );
    }
    const allowedEnv = new Set([
      "MISSIONCONTROL_INFERENCE_TOKEN",
      "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
      "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
      "CLAUDE_CODE_USE_FOUNDRY",
      "ANTHROPIC_FOUNDRY_BASE_URL",
      "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]);
    if (Object.keys(gatewayEnv).some((name) => !allowedEnv.has(name)))
      throw new ControlError(
        "environment_credentials",
        "Only scoped inference configuration may enter worker environment",
        409,
      );
    const gatewayArgs = Object.entries(gatewayEnv).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]);
    const contractArgs: string[] = [];
    if (s.spec.contractSnapshot) {
      const snapshot = s.spec.contractSnapshot;
      const snapshotRoot = join(this.registry.root, "contract-snapshots");
      if (
        !/^[a-f0-9]{64}$/.test(snapshot.digest) ||
        snapshot.path !== join(snapshotRoot, snapshot.digest) ||
        (await realpath(snapshot.path)) !== snapshot.path ||
        (await lstat(snapshot.path)).isSymbolicLink()
      )
        throw new ControlError(
          "contract_path",
          "Only controller-owned contract snapshots can be mounted",
          409,
        );
      const manifest = JSON.parse(
        await readFile(join(snapshot.path, "manifest.json"), "utf8"),
      );
      if (
        manifest.digest !== snapshot.digest ||
        createHash("sha256")
          .update(JSON.stringify(manifest.files))
          .digest("hex") !== snapshot.digest
      )
        throw new ControlError(
          "contract_integrity",
          "Contract snapshot manifest changed",
          409,
        );
      for (const file of manifest.files) {
        const path = resolve(snapshot.path, file.path);
        if (
          !path.startsWith(snapshot.path + "/") ||
          (await realpath(path)) !== path ||
          !(await lstat(path)).isFile() ||
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex") !== file.hash
        )
          throw new ControlError(
            "contract_integrity",
            "Contract snapshot content changed",
            409,
          );
      }
      contractArgs.push(
        "--mount",
        `type=bind,src=${snapshot.path},dst=/contracts,readonly`,
      );
    }

    await this.docker([
      "create",
      "--init",
      "--name",
      container,
      "--label",
      `missioncontrol.session=${id}`,
      "--label",
      `missioncontrol.generation=${s.generation}`,
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--network",
      s.spec.gatewayNetwork ?? "none",
      ...gatewayArgs,
      ...contractArgs,
      "--read-only",
      "--cpus",
      String(s.spec.cpu),
      "--memory",
      `${s.spec.memoryMiB}m`,
      "--memory-swap",
      `${s.spec.memoryMiB}m`,
      "--pids-limit",
      "256",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
      "--tmpfs",
      `/home/worker:rw,nosuid,nodev,size=128m,mode=0700,uid=${process.getuid?.() ?? 1000},gid=${process.getgid?.() ?? 1000}`,
      "--env",
      "HOME=/home/worker",
      "--env",
      "TMPDIR=/tmp",
      "--env",
      "GIT_CONFIG_NOSYSTEM=1",
      "--env",
      "GIT_CONFIG_GLOBAL=/dev/null",
      "--mount",
      `type=bind,src=${s.path},dst=/workspace`,
      "--workdir",
      "/workspace",
      "--entrypoint",
      "/bin/sh",
      digest,
      "-c",
      "exec sleep infinity",
    ]);
    await this.docker(["start", container]);
    return this.registry.save({
      ...s,
      status: "active",
      lastActivityAt: Date.now(),
    });
  }
  async inspect(id: string) {
    const s = this.registry.get(id);
    if (!s.container || s.status === "destroyed") return s;
    try {
      const data = JSON.parse(
        (await this.docker(["inspect", s.container])).stdout,
      )[0];
      if (
        data.Config.Labels?.["missioncontrol.session"] !== id ||
        data.Config.Labels?.["missioncontrol.generation"] !==
          String(s.generation)
      )
        throw new ControlError(
          "environment_owner",
          "Container ownership mismatch",
          409,
        );
      return this.registry.save({
        ...s,
        status: data.State.Running ? "active" : "stopped",
      });
    } catch (e) {
      if (e instanceof ControlError) throw e;
      if (!/No such (object|container)/i.test(String((e as any).stderr)))
        throw e;
      // A proven daemon "not found" is different from an inspection failure.
      // Retain source and incomplete outcome; do not invent successful work.
      return this.registry.save({
        ...s,
        container: undefined,
        status: "stopped",
      });
    }
  }
  async execute(id: string, command: string[], signal: AbortSignal) {
    const s = await this.acquire(id);
    if (!command.length)
      throw new ControlError("environment_command", "Command is required");
    this.registry.save({ ...s, lastActivityAt: Date.now() });
    try {
      return await this.docker(
        ["exec", s.container!, ...command],
        AbortSignal.any([signal, AbortSignal.timeout(s.spec.timeoutMs)]),
      );
    } catch (error) {
      await this.stop(id);
      throw error;
    } finally {
      const latest = this.registry.get(id);
      this.registry.save({ ...latest, lastActivityAt: Date.now() });
    }
  }
  async checkpoint(id: string) {
    await this.stop(id);
    return this.registry.save({
      ...this.registry.get(id),
      status: "checkpointed",
    });
  }
  async stop(id: string) {
    const s = await this.inspect(id);
    if (!s.container) return s;
    this.registry.save({ ...s, status: "stopping" });
    await this.docker(["stop", "--time", "10", s.container]);
    return this.registry.save({ ...s, status: "stopped" });
  }
  async reset(id: string) {
    const s = await this.stop(id);
    if (s.container) await this.docker(["rm", s.container]);
    this.registry.save({ ...s, container: undefined, status: "prepared" });
  }
  async destroy(id: string) {
    await this.reset(id);
    const s = this.registry.get(id);
    await this.registry.owned(s);
    this.registry.save({ ...s, status: "destroying" });
    // Source deletion is explicitly operator-driven; retention controller must authorize it.
    await rm(dirname(s.path), { recursive: true });
    this.registry.save({ ...s, status: "destroyed", container: undefined });
  }
}
async function rejectGitSymlinks(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink())
      throw new ControlError(
        "worker_git",
        "Worker Git metadata contains a symlink",
        409,
      );
    if (entry.isDirectory()) await rejectGitSymlinks(child);
    else if ((await lstat(child)).nlink > 1)
      throw new ControlError(
        "worker_git",
        "Worker Git metadata contains a hardlink",
        409,
      );
    else if (!entry.isFile())
      throw new ControlError(
        "worker_git",
        "Worker Git metadata contains a special file",
        409,
      );
  }
}
export async function sanitizeGit(path: string) {
  const metadata = join(path, ".git");
  if (!(await lstat(metadata)).isDirectory())
    throw new ControlError(
      "worker_git",
      "Private Git directory is required",
      409,
    );
  await rejectGitSymlinks(metadata);
  if (
    await lstat(join(metadata, "objects", "info", "alternates")).catch(
      () => null,
    )
  )
    throw new ControlError(
      "worker_git",
      "Worker Git alternates are forbidden",
      409,
    );
  await writeFile(
    join(metadata, "config"),
    "[core]\nrepositoryformatversion = 0\nbare = false\nhooksPath = /dev/null\nfsmonitor = false\n",
    { mode: 0o600 },
  );
}
export async function importWorkerChanges(
  s: ExecutionSession,
  trustedPath: string,
  allowedPaths: string[],
  assertLease: (taskId: string, generation: number) => void,
) {
  if (!["stopped", "checkpointed", "prepared"].includes(s.status))
    throw new ControlError(
      "active_work",
      "Stop execution before importing changes",
      409,
    );
  assertLease(s.taskId, s.generation);
  await sanitizeGit(s.path);
  const base = await git(trustedPath, ["rev-parse", "HEAD"]);
  if (base !== s.baseSha)
    throw new ControlError("worker_base", "Trusted task checkout moved", 409);
  await git(s.path, ["merge-base", "--is-ancestor", s.baseSha, "HEAD"]);
  if (await git(s.path, ["status", "--porcelain"]))
    throw new ControlError(
      "worker_checkpoint",
      "Commit or classify all worker source before import",
      409,
    );
  const files = (
    await git(s.path, [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      s.baseSha,
      "HEAD",
    ])
  )
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    if (
      file.startsWith("/") ||
      file.split("/").some((p) => p === ".." || p === ".git") ||
      !allowedPaths.some((scope) => matchesGlob(file, scope))
    )
      throw new ControlError(
        "worker_scope",
        "Worker changes exceed declared paths",
        409,
      );
    const absolute = resolve(s.path, file);
    const info = await lstat(absolute).catch(() => null);
    if (info?.isSymbolicLink()) {
      const target = await realpath(absolute).catch(() => null);
      if (!target || relative(s.path, target).startsWith(".."))
        throw new ControlError(
          "worker_symlink",
          "Worker symlink escapes checkout",
          409,
        );
    }
    // Parent directories cannot redirect patch application through host symlinks.
    let parent = dirname(resolve(trustedPath, file));
    while (parent !== resolve(trustedPath)) {
      if ((await lstat(parent).catch(() => null))?.isSymbolicLink())
        throw new ControlError(
          "worker_symlink",
          "Trusted patch parent is a symlink",
          409,
        );
      parent = dirname(parent);
    }
  }
  const patch = await git(s.path, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    s.baseSha,
    "HEAD",
  ]);
  assertLease(s.taskId, s.generation);
  if (patch) {
    const patchFile = join(dirname(s.path), "validated.patch");
    await writeFile(patchFile, patch + "\n", { mode: 0o600 });
    await git(trustedPath, ["apply", "--check", "--index", patchFile]);
    assertLease(s.taskId, s.generation);
    await git(trustedPath, ["apply", "--index", patchFile]);
  }
  return {
    files,
    workerHead: await git(s.path, ["rev-parse", "HEAD"]),
    baseSha: s.baseSha,
  };
}
export class FakeEnvironment extends DockerEnvironment {
  constructor(registry: EnvironmentRegistry) {
    const containers = new Map<string, any>();
    super(registry, async (args) => {
      if (args[0] === "image")
        return {
          stdout: JSON.stringify(`sha256:${"a".repeat(64)}`),
          stderr: "",
        };
      if (args[0] === "create") {
        const name = args[args.indexOf("--name") + 1];
        const labels = args.flatMap((v, i) =>
          v === "--label" ? [args[i + 1]] : [],
        );
        containers.set(name, {
          Config: {
            Labels: Object.fromEntries(labels.map((l) => l.split("="))),
          },
          State: { Running: false },
        });
      }
      if (args[0] === "inspect") {
        if (!containers.has(args[1]))
          throw Object.assign(new Error("missing"), {
            stderr: "No such object",
          });
        return {
          stdout: JSON.stringify([containers.get(args[1])]),
          stderr: "",
        };
      }
      if (args[0] === "start") containers.get(args[1]).State.Running = true;
      if (args[0] === "stop")
        containers.get(args.at(-1)!).State.Running = false;
      if (args[0] === "rm") containers.delete(args[1]);
      return { stdout: "", stderr: "" };
    });
  }
}
