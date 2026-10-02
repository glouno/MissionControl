import { readFile, lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { audit, permitted } from "./publication-audit.mjs";
import {
  qualificationFingerprints,
  loadQualification,
  PREVIEW_GATES,
} from "./qualification.mjs";
const root = resolve(process.argv[2] ?? "");
const archiveTool = new URL("./release-archive.py", import.meta.url).pathname;
if (!process.argv[2]) throw Error("Supply exact release directory");
for (const path of [root, join(root, "source"), join(root, "installed")]) {
  const meta = await lstat(path);
  if (!meta.isDirectory() || meta.isSymbolicLink())
    throw Error("Release root is redirected");
}
const manifest = JSON.parse(
  await readFile(join(root, "release-manifest.json"), "utf8"),
);
const sourceManifest = JSON.parse(
  await readFile(join(root, "installed/assets/source-manifest.json"), "utf8"),
);
if (
  sourceManifest.sourceCommit !== manifest.commit ||
  sourceManifest.version !== manifest.version ||
  JSON.stringify(sourceManifest.files) !== JSON.stringify(manifest.source)
)
  throw Error("Installed corresponding source differs from release source");
const fingerprints = qualificationFingerprints(
  manifest.commit,
  manifest.source,
  await readFile(join(root, "source/package-lock.json")),
  await readFile(join(root, "source/connectors/matrix/Cargo.lock")),
);
if (JSON.stringify(fingerprints) !== JSON.stringify(manifest.fingerprints))
  throw Error("Release fingerprints differ");
const declared = manifest.previewQualification;
if (
  !declared ||
  declared.scope !== "linux-wsl-preview" ||
  JSON.stringify(declared.mandatoryGates) !== JSON.stringify(PREVIEW_GATES)
)
  throw Error("Preview qualification scope is missing");
const qualification = await loadQualification(
  process.argv[3],
  fingerprints,
  manifest.applicationSchemaVersion,
);
if (
  process.argv[3] &&
  JSON.stringify(qualification) !== JSON.stringify(declared)
)
  throw Error("Private qualification receipt differs from release declaration");
if (
  declared.qualified &&
  (!manifest.acceptanceComplete ||
    !manifest.dependencyReviewComplete ||
    declared.pendingGates.length ||
    JSON.stringify(declared.passedGates) !== JSON.stringify(PREVIEW_GATES))
)
  throw Error("Incomplete declared preview qualification");
if (
  manifest.schemaVersion !== 1 ||
  !Array.isArray(manifest.archives) ||
  manifest.archives.length !== 3 ||
  new Set(manifest.archives.map((f) => f.path)).size !== 3 ||
  !manifest.archives.some((f) => f.path.endsWith("-source.tar.gz")) ||
  !manifest.archives.some((f) => f.path.endsWith("-installed.tar.gz")) ||
  !manifest.archives.some((f) => f.path.endsWith(".tgz"))
)
  throw Error("Unsupported release manifest");
const markerPath = process.env.MISSIONCONTROL_PRIVACY_MARKERS,
  markers = markerPath ? JSON.parse(await readFile(markerPath, "utf8")) : [];
for (const kind of ["source", "installed"]) {
  const report = await audit(join(root, kind), kind, markers);
  const expected =
    kind === "source"
      ? manifest.source
      : manifest.files.map((f) => ({
          ...f,
          path: f.path.replace(/^installed\//, ""),
        }));
  if (!report.passed || report.files.length !== expected.length)
    throw Error("Release payload audit differs from manifest");
  for (const file of expected) {
    const actual = report.files.find((f) => f.path === file.path);
    if (!actual || actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
      throw Error("Release file hash differs");
  }
}
for (const entry of manifest.archives) {
  if (
    entry.path !== entry.path.split("/").at(-1) ||
    !/^[\w.-]+\.(tar\.gz|tgz)$/.test(entry.path)
  )
    throw Error("Invalid archive name");
  const path = join(root, entry.path),
    info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw Error("Release archive is redirected");
  const bytes = await readFile(path);
  if (
    bytes.length !== entry.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== entry.sha256
  )
    throw Error("Release archive hash differs");
  const source = entry.path.endsWith("-source.tar.gz"),
    npm = entry.path.endsWith(".tgz");
  const expected = source
    ? manifest.source
    : npm
      ? manifest.npmFiles
      : manifest.files.map((f) => ({
          ...f,
          path: f.path.replace(/^installed\//, ""),
        }));
  if (!expected?.length || !Number.isSafeInteger(manifest.archiveEpoch))
    throw Error(
      "Release archive inventory/epoch missing; rebuild reviewed candidate",
    );
  for (const file of expected)
    if (!permitted(file.path, source ? "source" : "installed"))
      throw Error("Archive inventory escaped publication policy");
  execFileSync("python3", [archiveTool, "verify", path], {
    input: JSON.stringify({
      files: expected,
      prefix: npm ? "package/" : "",
      epoch: manifest.archiveEpoch,
      allowMetadata: npm,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
}
const checksum =
  manifest.archives.map((f) => `${f.sha256}  ${f.path}`).join("\n") + "\n";
if ((await readFile(join(root, "SHA256SUMS"), "utf8")) !== checksum)
  throw Error("Release checksum list differs");
const allowed = new Set([
  "source",
  "installed",
  "release-manifest.json",
  "SHA256SUMS",
  ...manifest.archives.map((f) => f.path),
]);
if ((await readdir(root)).some((f) => !allowed.has(f)))
  throw Error("Unexpected release payload");
console.log(
  JSON.stringify({
    verified: true,
    commit: manifest.commit,
    sourceFiles: manifest.source.length,
    installedFiles: manifest.files.length,
    archives: manifest.archives.length,
    qualified: qualification.qualified && declared.qualified === true,
    qualificationReceiptVerified: Boolean(process.argv[3]),
    acceptanceComplete: manifest.acceptanceComplete === true,
    dependencyReviewComplete: manifest.dependencyReviewComplete === true,
  }),
);
