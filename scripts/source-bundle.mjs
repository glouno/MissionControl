import { readFile, mkdir, writeFile, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { audit, packageRoot } from "./publication-audit.mjs";
import { createSourceArchive } from "./source-bundle-format.mjs";

const report = await audit(packageRoot, "source");
if (!report.passed)
  throw Error("Source bundle requires a clean publication inventory");
let sourceCommit = null,
  archiveEpoch = 0;
try {
  if (
    !execFileSync("git", ["status", "--porcelain"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  ) {
    sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: packageRoot,
      encoding: "utf8",
    }).trim();
    archiveEpoch = Number(
      execFileSync("git", ["show", "-s", "--format=%ct", sourceCommit], {
        cwd: packageRoot,
        encoding: "utf8",
      }).trim(),
    );
  }
} catch {
  /* Source archives can build without Git metadata; exact file hashes remain authoritative. */
}
const files = await Promise.all(
  report.files.map(async (f) => ({
    path: f.path,
    data: await readFile(join(packageRoot, f.path)),
  })),
);
const archive = createSourceArchive(files, archiveEpoch);
const target = join(packageRoot, "assets"),
  info = await lstat(target).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
if (info?.isSymbolicLink()) throw Error("Source assets cannot be redirected");
await rm(target, { recursive: true, force: true });
await mkdir(target);
await writeFile(join(target, "source.tar.gz"), archive);
await writeFile(
  join(target, "source-manifest.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      version: JSON.parse(
        await readFile(join(packageRoot, "package.json"), "utf8"),
      ).version,
      sourceCommit,
      archiveEpoch,
      archive: {
        path: "source.tar.gz",
        bytes: archive.length,
        sha256: createHash("sha256").update(archive).digest("hex"),
      },
      files: report.files,
    },
    null,
    2,
  ) + "\n",
);
