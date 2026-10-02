import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { packageRoot, permitted, inventory } from "./publication-audit.mjs";
const historyRoot = process.argv[3] ? resolve(process.argv[3]) : packageRoot;

const run = (args, encoding = "utf8") =>
  execFileSync("git", args, {
    cwd: historyRoot,
    encoding,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const markerFile = process.env.MISSIONCONTROL_PRIVACY_MARKERS;
const markers = markerFile
  ? JSON.parse(await readFile(markerFile, "utf8"))
  : [];
if (!Array.isArray(markers) || markers.some((m) => typeof m !== "string"))
  throw Error("Private markers must be strings");
const findings = [],
  commits = run(["rev-list", "--all"]).trim().split("\n").filter(Boolean);
const objects = run(["rev-list", "--objects", "--all", "--no-object-names"])
  .trim()
  .split("\n")
  .filter(Boolean);
const credential =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-proj-[A-Za-z0-9_-]{30,}\b/;
for (const commit of commits) {
  const entries = run(["ls-tree", "-r", "-z", commit])
    .split("\0")
    .filter(Boolean);
  for (const entry of entries) {
    const [, mode, type, oid, path] =
      /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry) ?? [];
    if (
      !path ||
      type !== "blob" ||
      !["100644", "100755"].includes(mode) ||
      !permitted(path, "source") ||
      path
        .split("/")
        .some((segment) => inventory.prohibitedSegments.includes(segment)) ||
      path.split("/").some((segment) => /^\.env(?:\.|$)/.test(segment))
    )
      findings.push({
        commit,
        rule: "historical_path_or_type_requires_review",
      });
  }
}
let blobs = 0;
for (const oid of objects) {
  const type = run(["cat-file", "-t", oid]).trim();
  if (!["blob", "commit", "tag"].includes(type)) continue;
  const data = run(["cat-file", type, oid], null);
  if (type === "blob") blobs++;
  if (data.includes(0)) {
    findings.push({ object: oid, rule: "historical_binary_requires_review" });
    continue;
  }
  const text = data.toString("utf8");
  if (credential.test(text))
    findings.push({ object: oid, rule: "historical_credential_pattern" });
  if (
    markers.some(
      (m) => m.length >= 4 && text.toLowerCase().includes(m.toLowerCase()),
    )
  )
    findings.push({ object: oid, rule: "historical_private_content_marker" });
}
const report = {
  schemaVersion: 1,
  passed: !findings.length,
  commits: commits.length,
  blobs,
  refs: run(["for-each-ref", "--format=%(refname)"])
    .trim()
    .split("\n")
    .filter(Boolean).length,
  findings,
};
if (process.argv[2])
  await writeFile(
    resolve(process.argv[2]),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
console.log(
  JSON.stringify({
    passed: report.passed,
    commits: report.commits,
    blobs,
    refs: report.refs,
    findings: findings.length,
  }),
);
process.exitCode = report.passed ? 0 : 1;
