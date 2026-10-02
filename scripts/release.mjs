import {
  mkdir,
  copyFile,
  readFile,
  writeFile,
  lstat,
  chmod,
} from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  audit,
  inventory,
  permitted,
  packageRoot,
} from "./publication-audit.mjs";
import {
  qualificationFingerprints,
  loadQualification,
} from "./qualification.mjs";

process.umask(0o077);
const destination = process.argv[2];
if (!destination)
  throw new Error(
    "Supply a new release destination outside the source checkout",
  );
const root = resolve(destination),
  path = relative(packageRoot, root);
if (!path.startsWith("..") || root === packageRoot)
  throw new Error("Release destination must be outside the source checkout");
try {
  await lstat(root);
  throw new Error("Release destination already exists");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const markers = process.env.MISSIONCONTROL_PRIVACY_MARKERS
  ? JSON.parse(
      await readFile(process.env.MISSIONCONTROL_PRIVACY_MARKERS, "utf8"),
    )
  : [];
const report = await audit(packageRoot, "source", markers);
if (!report.passed)
  throw new Error(
    "Source privacy audit failed; review path/rule findings privately",
  );
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: packageRoot,
  encoding: "utf8",
}).trim();
const status = execFileSync("git", ["status", "--porcelain"], {
  cwd: packageRoot,
  encoding: "utf8",
});
if (status)
  throw new Error("Commit the reviewed candidate before creating a release");
// Ignored dist may belong to an older commit. Build the exact reviewed source.
execFileSync("npm", ["run", "build"], {
  cwd: packageRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
// Test-only builds are excluded by the same inventory used for source export.
const pack = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
  }),
)[0];
for (const f of pack.files)
  if (!permitted(f.path, "installed"))
    throw new Error(`Unexpected npm payload: ${f.path}`);
await mkdir(root, { mode: 0o700 });
const files = [];
for (const f of report.files) {
  const target = join(root, "source", f.path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(packageRoot, f.path), target);
}
const installedFiles = [...pack.files];
if (!installedFiles.some((f) => f.path === "package-lock.json"))
  installedFiles.push({ path: "package-lock.json" });
for (const f of installedFiles) {
  if (!permitted(f.path, "installed"))
    throw new Error("Release file is outside installed inventory");
  const from = join(packageRoot, f.path),
    data = await readFile(from),
    target = join(root, "installed", f.path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(from, target);
  files.push({
    path: `installed/${f.path}`,
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
  });
}
const installed = await audit(join(root, "installed"), "installed", markers);
if (!installed.passed)
  throw new Error("Installed payload privacy audit failed");
const sourceAudit = await audit(join(root, "source"), "source", markers);
if (
  !sourceAudit.passed ||
  JSON.stringify(sourceAudit.files) !== JSON.stringify(report.files)
)
  throw Error("Exported source differs from reviewed tree");
const version = JSON.parse(
  await readFile(join(packageRoot, "package.json")),
).version;
const migrationSource = await readFile(
  join(packageRoot, "src/control/store.ts"),
  "utf8",
);
const applicationSchemaVersion = Math.max(
  ...[...migrationSource.matchAll(/PRAGMA user_version\s*=\s*(\d+)/g)].map(
    (m) => Number(m[1]),
  ),
);
if (
  !Number.isSafeInteger(applicationSchemaVersion) ||
  applicationSchemaVersion < 6
)
  throw Error("Application migration version unavailable");
const fingerprints = qualificationFingerprints(
  commit,
  report.files,
  await readFile(join(packageRoot, "package-lock.json")),
  await readFile(join(packageRoot, "connectors/matrix/Cargo.lock")),
);
const qualification = await loadQualification(
  process.argv[3],
  fingerprints,
  applicationSchemaVersion,
);
const archives = [];
const archiveEpoch = Number(
  execFileSync("git", ["show", "-s", "--format=%ct", commit], {
    cwd: packageRoot,
    encoding: "utf8",
  }).trim(),
);
if (!Number.isSafeInteger(archiveEpoch) || archiveEpoch < 0)
  throw Error("Invalid candidate timestamp");
const archiveTool = new URL("./release-archive.py", import.meta.url).pathname;
for (const [kind, entries] of [
  ["source", report.files],
  ["installed", installed.files],
]) {
  const name = `mission-control-${version}-${kind}.tar.gz`;
  // Explicit reviewed entries with reproducible ownership, modes and timestamps.
  execFileSync("python3", [archiveTool, "create", join(root, name)], {
    input: JSON.stringify({
      root: join(root, kind),
      files: entries,
      epoch: archiveEpoch,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bytes = await readFile(join(root, name));
  archives.push({
    path: name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const actual = JSON.parse(
  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", root, "--json"],
    { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ),
)[0];
for (const f of actual.files)
  if (!permitted(f.path, "installed"))
    throw Error("Actual npm package escaped publication inventory");
if (
  JSON.stringify(actual.files.map((f) => f.path).sort()) !==
  JSON.stringify(pack.files.map((f) => f.path).sort())
)
  throw Error("Actual npm package differs from reviewed preview");
const npmBytes = await readFile(join(root, actual.filename));
archives.push({
  path: actual.filename,
  bytes: npmBytes.length,
  sha256: createHash("sha256").update(npmBytes).digest("hex"),
});
await writeFile(
  join(root, "SHA256SUMS"),
  archives.map((f) => `${f.sha256}  ${f.path}`).join("\n") + "\n",
);
await writeFile(
  join(root, "release-manifest.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      archiveEpoch,
      npmFiles: pack.files.map((f) => ({
        path: f.path,
        bytes: f.size,
        sha256: files.find((x) => x.path === `installed/${f.path}`).sha256,
      })),
      commit,
      version,
      qualification: qualification.qualified
        ? "Qualified Linux/WSL public preview; optional integrations remain experimental"
        : "Unqualified preview; mandatory acceptance gaps remain",
      previewQualification: qualification,
      fingerprints,
      applicationSchemaVersion,
      configSchemaVersion: 1,
      inventoryHash: createHash("sha256")
        .update(JSON.stringify(inventory))
        .digest("hex"),
      source: report.files,
      files,
      archives,
      matrixBinaries: [],
      dependencyReviewComplete:
        qualification.passedGates.includes("dependency-notices"),
      acceptanceComplete: qualification.qualified,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    prepared: root,
    commit,
    sourceFiles: report.files.length,
    installedFiles: files.length,
  }),
);

// Archives are prepared privately; publication is a separate explicit action.
for (const entry of archives) await chmod(join(root, entry.path), 0o600);
