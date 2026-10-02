// Prepare an independent publication tree; never contacts a remote or imports Git history.
import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  lstat,
  realpath,
  chmod,
} from "node:fs/promises";
import { join, dirname, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { audit, packageRoot } from "./publication-audit.mjs";

process.umask(0o077);
const destination = process.argv[2] && resolve(process.argv[2]);
if (!destination || !relative(packageRoot, destination).startsWith(".."))
  throw Error("Supply a new public-export destination outside source");
const parent = dirname(destination);
if ((await realpath(parent)) !== parent)
  throw Error("Export parent is redirected");
try {
  await lstat(destination);
  throw Error("Export destination already exists");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const run = (args, cwd = packageRoot, extra = {}) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...extra,
  });
const cleanGitEnvironment = {
  PATH: process.env.PATH,
  LANG: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
if (run(["status", "--porcelain"]).trim())
  throw Error("Commit the reviewed source before export");
const sourceCommit = run(["rev-parse", "HEAD"]).trim();
const markers = process.env.MISSIONCONTROL_PRIVACY_MARKERS
  ? JSON.parse(
      await readFile(process.env.MISSIONCONTROL_PRIVACY_MARKERS, "utf8"),
    )
  : [];
if (!Array.isArray(markers) || markers.some((m) => typeof m !== "string"))
  throw Error("Invalid private markers");
const report = await audit(packageRoot, "source", markers);
if (!report.passed) throw Error("Source export privacy review failed");
await mkdir(destination, { mode: 0o700 });
for (const file of report.files) {
  const from = join(packageRoot, file.path),
    to = join(destination, file.path);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  // Public source has no runtime secrets and no host-derived executable modes.
  await chmod(to, 0o644);
}
const exported = await audit(destination, "source", markers);
if (
  !exported.passed ||
  JSON.stringify(report.files) !== JSON.stringify(exported.files)
)
  throw Error("Export content differs from reviewed source");
run(["-c", "init.templateDir=", "init", "--initial-branch=main"], destination, {
  env: cleanGitEnvironment,
});
run(["add", "--all"], destination, { env: cleanGitEnvironment });
run(
  [
    "-c",
    "user.name=MissionControl contributors",
    "-c",
    "user.email=contributors@missioncontrol.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--no-verify",
    "-m",
    "Initial public MissionControl preview",
  ],
  destination,
  {
    env: cleanGitEnvironment,
  },
);
const publicCommit = run(["rev-parse", "HEAD"], destination).trim();
if (
  run(["remote"], destination).trim() ||
  run(["rev-list", "--count", "HEAD"], destination).trim() !== "1"
)
  throw Error("Export history or remote differs from publication contract");
const receipt = {
  schemaVersion: 1,
  sourceCommit,
  publicCommit,
  files: report.files.length,
  inventorySha256: createHash("sha256")
    .update(JSON.stringify(report.files))
    .digest("hex"),
  originalHistoryImported: false,
  remoteConfigured: false,
  published: false,
  attribution:
    "MissionControl contributors <contributors@missioncontrol.invalid>",
};
// Receipt is private beside the exported tree; never put development provenance in public source.
await writeFile(
  destination + ".receipt.json",
  JSON.stringify(receipt, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(
  JSON.stringify({
    prepared: true,
    publicCommit,
    files: receipt.files,
    published: false,
  }),
);
