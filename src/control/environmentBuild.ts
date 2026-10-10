import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  writeFile,
  rename,
  lstat,
  statfs,
  readFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteStore, sql, registryDatabase } from "../sqlite.js";
import { ControlError } from "./schema.js";
import { git } from "./git.js";
import { StatePaths } from "./statePaths.js";
import { ownedBuildCache } from "./buildCache.js";
import {
  resolveEnvironmentManifest,
  type EnvironmentManifest,
} from "./environmentManifest.js";
const exec = promisify(execFile);
export interface EnvironmentBuildRecord {
  id: string;
  projectId: string;
  version: string;
  revision: string;
  baseImageDigest: string;
  imageTag: string;
  imageDigest?: string;
  context: string;
  cachePath?: string;
  cacheRemovalVerified?: boolean;
  status:
    "preparing" | "building" | "built" | "failed" | "evicting" | "evicted";
  createdAt: number;
  updatedAt: number;
  inputs: unknown;
  error?: string;
  ownerPid?: number;
  ownerIdentity?: { bootId: string; startTicks: string };
  lastUsedAt?: number;
}
export async function processIdentity(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff)
    return undefined;
  if (process.platform === "darwin") {
    // PROC_PIDTBSDINFO includes microsecond start time, unlike ps lstart.
    // Pair it with the boot UUID to fence PID reuse and previous boot owners.
    const script = `import ctypes,errno,json,struct,sys
lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
lib.proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]
lib.proc_pidinfo.restype=ctypes.c_int
buf=ctypes.create_string_buffer(136)
n=lib.proc_pidinfo(int(sys.argv[1]),3,0,buf,136)
if n==0 and ctypes.get_errno()==errno.ESRCH: sys.exit(0)
if n!=136: sys.exit(1)
seconds,micros=struct.unpack_from('=QQ',buf.raw,120)
if not seconds or micros>=1000000: sys.exit(1)
print(json.dumps([seconds,micros]))
`;
    const [boot, start] = await Promise.all([
      exec("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        timeout: 5000,
      }),
      exec("python3", ["-I", "-c", script, String(pid)], {
        timeout: 5000,
        env: { PATH: process.env.PATH },
      }),
    ]);
    const bootId = boot.stdout.trim();
    if (!/^[a-f0-9-]{36}$/i.test(bootId))
      throw new Error("Build boot identity unavailable");
    if (!start.stdout.trim()) return undefined;
    const [seconds, micros] = JSON.parse(start.stdout) as number[];
    return { bootId, startTicks: `${seconds}:${micros}` };
  }
  if (process.platform !== "linux")
    throw new Error("Build process identity unsupported on this platform");
  try {
    const [bootId, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!startTicks) throw new Error("Build process identity unavailable");
    return { bootId: bootId.trim(), startTicks };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
// Operator-owned recipes only; never build a Dockerfile supplied by a coding goal.
// The context contains exact dependency blobs, not a human/source checkout.
export class EnvironmentImageBuilder {
  readonly db: SqliteStore;
  readonly paths: StatePaths;
  constructor(
    readonly root: string,
    readonly docker: (
      args: string[],
    ) => Promise<{ stdout: string; stderr: string }> = (args: string[]) =>
      exec("docker", args, { timeout: 900000, maxBuffer: 4 * 1024 * 1024 }),
    readonly admission = async () => {
      const disk = await statfs(root);
      if (disk.bavail * disk.bsize < 50 * 1024 ** 3)
        throw new ControlError(
          "storage_pressure",
          "Image build requires fifty GiB free storage",
          409,
        );
    },
    applicationDb?: SqliteStore,
  ) {
    this.db = applicationDb ?? registryDatabase(root, "environment-images.db");
    this.paths = new StatePaths(root, this.db);
    if (applicationDb) return;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS environment_images(id TEXT PRIMARY KEY,record TEXT NOT NULL)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS environment_maintenance(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL)",
    );
  }
  records(): EnvironmentBuildRecord[] {
    return this.db
      .query<{ record: string }>("SELECT record FROM environment_images")
      .map((r) => {
        const record: EnvironmentBuildRecord = JSON.parse(r.record);
        return {
          ...record,
          context: this.paths.decode(record.context),
          cachePath: record.cachePath
            ? this.paths.decode(record.cachePath)
            : undefined,
        };
      });
  }
  private save(record: EnvironmentBuildRecord) {
    record = { ...record, updatedAt: Date.now() };
    this.db.exec(
      `INSERT INTO environment_images VALUES(${sql(record.id)},${sql(this.db.redactor.json({ ...record, context: this.paths.encode(record.context), cachePath: record.cachePath ? this.paths.encode(record.cachePath) : undefined }))}) ON CONFLICT(id) DO UPDATE SET record=excluded.record`,
    );
    return record;
  }
  async build(
    manifest: EnvironmentManifest,
    repository: string,
    revision: string,
    recipe: string,
    baseImageDigest: string,
  ) {
    if (
      !/^sha256:[a-f0-9]{64}$/.test(baseImageDigest) ||
      !recipe.startsWith("ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n")
    )
      throw new ControlError(
        "environment_recipe",
        "Trusted recipe must require a pinned base image",
        409,
      );
    const resolved = await resolveEnvironmentManifest(
      manifest,
      repository,
      revision,
      `${baseImageDigest}\n${recipe}`,
    );
    const id = `${manifest.projectId}_${resolved.version}`;
    let record = this.records().find((r) => r.id === id);
    if (record?.status === "built") {
      if (
        this.db.one(
          `SELECT owner FROM environment_maintenance WHERE expires>=${Date.now()} LIMIT 1`,
        )
      )
        throw new ControlError(
          "active_work",
          "Image maintenance is leased",
          409,
        );
      await this.verify(record);
      record = this.save({ ...record, lastUsedAt: Date.now() });
      await this.evidence(record);
      return record;
    }
    if (record?.status === "evicting")
      throw new ControlError(
        "active_work",
        "Reconcile image eviction before rebuilding",
        409,
      );
    if (record && ["preparing", "building"].includes(record.status))
      throw new ControlError(
        "environment_build_active",
        "Reconcile previous image build before retry",
        409,
      );
    const context = join(
      this.root,
      "builds",
      `${id}_${randomUUID().replaceAll("-", "")}`,
    );
    const cachePath = join(
      this.root,
      "caches",
      `${id}_${randomUUID().replaceAll("-", "")}`,
    );
    await this.admission();
    const ownerIdentity = await processIdentity(process.pid);
    if (!ownerIdentity) throw new Error("Build owner identity unavailable");
    record = this.db.transaction(() => {
      const current = this.records().find((r) => r.id === id);
      if (
        this.db.one(
          `SELECT owner FROM environment_maintenance WHERE expires>=${Date.now()} LIMIT 1`,
        )
      )
        throw new ControlError(
          "active_work",
          "Image maintenance is leased",
          409,
        );
      if (current && !["failed", "evicted"].includes(current.status))
        throw new ControlError(
          "environment_build_active",
          "Image build ownership changed; retry or reconcile",
          409,
        );
      return this.save({
        id,
        projectId: manifest.projectId,
        version: resolved.version,
        revision,
        baseImageDigest,
        imageTag: `missioncontrol/project-${manifest.projectId.toLowerCase()}:${resolved.version}`,
        context,
        cachePath,
        status: "preparing",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        inputs: resolved.inputs,
        ownerPid: process.pid,
        ownerIdentity,
      });
    });
    try {
      await mkdir(context, { recursive: true, mode: 0o700 });
      await writeFile(join(context, "Dockerfile"), recipe, { mode: 0o600 });
      let bytes = 0;
      for (const dependency of resolved.inputs.dependencies) {
        if (["Dockerfile", ".dockerignore"].includes(dependency.path))
          throw new ControlError(
            "environment_context",
            "Dependency cannot overwrite build controls",
            409,
          );
        const size = Number(
          await git(repository, ["cat-file", "-s", dependency.blob]),
        );
        bytes += size;
        if (!Number.isSafeInteger(size) || size < 0 || bytes > 16 * 1024 * 1024)
          throw new ControlError(
            "environment_context",
            "Dependency context exceeds sixteen MiB",
            409,
          );
        const blob = await exec(
          "git",
          [
            "--no-replace-objects",
            "-c",
            "core.hooksPath=/dev/null",
            "cat-file",
            "blob",
            dependency.blob,
          ],
          { cwd: repository, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
        );
        const path = join(context, dependency.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, blob.stdout, { mode: 0o600, flag: "wx" });
      }
      record = this.save({ ...record, status: "building" });
      await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
      const priorCache = this.records()
        .filter(
          (r) =>
            r.projectId === manifest.projectId &&
            r.id !== id &&
            r.status === "built" &&
            r.cachePath,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const cacheFrom =
        priorCache && (await ownedBuildCache(this.root, priorCache)).present
          ? ["--cache-from", `type=local,src=${priorCache.cachePath}`]
          : [];
      const baseTag = `missioncontrol/build-base:${baseImageDigest.slice(7)}`;
      await this.docker(["image", "tag", baseImageDigest, baseTag]);
      if (
        JSON.parse((await this.docker(["image", "inspect", baseTag])).stdout)[0]
          .Id !== baseImageDigest
      )
        throw new ControlError(
          "environment_image",
          "Build base changed before execution",
          409,
        );
      await this.docker([
        "build",
        ...cacheFrom,
        "--cache-to",
        `type=local,dest=${cachePath},mode=max`,
        "--build-arg",
        `BASE_IMAGE=${baseTag}`,
        "--label",
        `missioncontrol.environment.version=${record.version}`,
        "--label",
        `missioncontrol.environment.project=${record.projectId}`,
        "--label",
        `missioncontrol.environment.base=${baseImageDigest}`,
        "--tag",
        record.imageTag,
        context,
      ]);
      const image = JSON.parse(
        (await this.docker(["image", "inspect", record.imageTag])).stdout,
      )[0];
      record = { ...record, imageDigest: image.Id };
      if (
        JSON.parse((await this.docker(["image", "inspect", baseTag])).stdout)[0]
          .Id !== baseImageDigest
      )
        throw new ControlError(
          "environment_image",
          "Build base changed during execution",
          409,
        );
      await this.verify(record);
      if (!(await ownedBuildCache(this.root, record)).present)
        throw new ControlError(
          "cache_format",
          "Dependency build did not export its recorded cache",
          409,
        );
      record = this.save({ ...record, status: "built" });
      await this.evidence(record);
      return record;
    } catch (error) {
      this.save({
        ...record,
        status: "failed",
        error: (error as Error).message.slice(0, 2000),
      });
      throw error;
    }
  }
  async verify(record: EnvironmentBuildRecord) {
    if (
      !record.imageDigest ||
      !/^sha256:[a-f0-9]{64}$/.test(record.imageDigest)
    )
      throw new ControlError(
        "environment_image",
        "Build has no pinned image",
        409,
      );
    const image = JSON.parse(
      (await this.docker(["image", "inspect", record.imageDigest])).stdout,
    )[0];
    if (
      image.Id !== record.imageDigest ||
      image.Config?.Labels?.["missioncontrol.environment.version"] !==
        record.version ||
      image.Config?.Labels?.["missioncontrol.environment.project"] !==
        record.projectId ||
      image.Config?.Labels?.["missioncontrol.environment.base"] !==
        record.baseImageDigest
    )
      throw new ControlError(
        "environment_image",
        "Image provenance differs from recorded build",
        409,
      );
  }
  private async evidence(record: EnvironmentBuildRecord) {
    const path = join(this.root, `${record.id}.json`),
      temporary = `${path}.${randomUUID()}`;
    await writeFile(
      temporary,
      JSON.stringify(
        this.db.redactor.value({
          ...record,
          context: this.paths.encode(record.context),
          cachePath: record.cachePath
            ? this.paths.encode(record.cachePath)
            : undefined,
        }),
        null,
        2,
      ),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    await rename(temporary, path);
  }
  async reconcile() {
    for (let record of this.records().filter((r) =>
      ["preparing", "building"].includes(r.status),
    )) {
      if (
        record.ownerPid &&
        record.ownerIdentity &&
        JSON.stringify(await processIdentity(record.ownerPid)) ===
          JSON.stringify(record.ownerIdentity)
      )
        continue;
      // A daemon error is not evidence of image absence. Keep the intent pending.
      const images = (
        await this.docker([
          "image",
          "ls",
          "--no-trunc",
          "--format",
          "json",
          record.imageTag,
        ])
      ).stdout
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s));
      if (images.length !== 1) {
        this.save({
          ...record,
          status: "failed",
          error:
            "Interrupted build has no unique resulting image; context retained",
        });
        continue;
      }
      record = { ...record, imageDigest: images[0].ID };
      try {
        await this.verify(record);
        await lstat(record.context);
        if (
          record.cachePath &&
          !(await ownedBuildCache(this.root, record)).present
        )
          throw new ControlError(
            "cache_format",
            "Interrupted build cache is missing",
            409,
          );
      } catch (error) {
        // Deterministic provenance/missing-context errors allow operator retries.
        // Daemon outages remain pending and fail visibly without claiming absence.
        if (
          !(
            error instanceof ControlError &&
            [
              "environment_image",
              "cache_format",
              "cache_path",
              "cache_owner",
            ].includes(error.code)
          ) &&
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        )
          throw error;
        this.save({
          ...record,
          status: "failed",
          error: (error as Error).message,
        });
        continue;
      }
      record = this.save({ ...record, status: "built" });
      await this.evidence(record);
    }
  }
}
