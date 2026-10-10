import "./canonical-temp.mjs";
// Run on the real target machine. No login, paid inference or service activation.
import { mkdir, writeFile, readFile, lstat, realpath } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { platform, arch, release } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile),
  source = fileURLToPath(new URL("../", import.meta.url));
const [expected, imageFile, destination] = process.argv.slice(2);
if (!["linux", "darwin"].includes(expected) || platform() !== expected)
  throw Error("Run on the requested actual linux or darwin machine");
if (!imageFile || !destination)
  throw Error(
    "Supply expected platform, reviewed image digest file and new private evidence directory",
  );
const root = resolve(destination),
  rel = relative(source, root);
if (!rel.startsWith(".."))
  throw Error("Evidence must be outside source and Git");
const image = (await readFile(imageFile, "utf8")).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image))
  throw Error("Supply reviewed immutable image digest");
const run = (command, args, timeout = 120000) =>
  exec(command, args, {
    cwd: source,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
  });
const commit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
if ((await run("git", ["status", "--porcelain"])).stdout.trim())
  throw Error("Commit the reviewed source before platform qualification");
await mkdir(root, { mode: 0o700 });
const info = await lstat(root);
if (
  info.mode & 0o077 ||
  info.isSymbolicLink() ||
  (await realpath(root)) !== root
)
  throw Error("Evidence destination must be private and canonical");
const stages = [
  ["fresh-install", [process.execPath, ["--test", "dist/install.test.js"]]],
  [
    "gateway",
    [process.execPath, ["scripts/qualify-gateway.mjs", resolve(imageFile)]],
  ],
  [
    "subscription-egress",
    [
      process.execPath,
      ["scripts/qualify-subscription-egress.mjs", resolve(imageFile)],
    ],
  ],
  [
    "logged-out-auth",
    [
      process.execPath,
      ["scripts/qualify-auth-environment.mjs", resolve(imageFile)],
    ],
  ],
  [
    "synthetic-subscription-coding",
    [
      process.execPath,
      ["scripts/qualify-subscription-coding.mjs", resolve(imageFile)],
    ],
  ],
  [
    "active-recovery",
    [
      process.execPath,
      ["scripts/qualify-runtime-recovery.mjs", resolve(imageFile)],
    ],
  ],
];
const receipt = {
  schemaVersion: 1,
  candidate: commit,
  platform: platform(),
  architecture: arch(),
  osRelease: release(),
  node: process.version,
  image,
  stages: [],
  qualified: false,
  liveSubscriptionQualified: false,
  servicesStarted: false,
  inferenceSpendUsd: 0,
};
receipt.lockfiles = {};
for (const path of ["package-lock.json", "connectors/matrix/Cargo.lock"])
  receipt.lockfiles[path] = createHash("sha256")
    .update(await readFile(join(source, path)))
    .digest("hex");
receipt.docker = JSON.parse(
  (await run("docker", ["version", "--format", "{{json .}}"])).stdout,
);
if (expected === "darwin")
  receipt.macOS = (await run("sw_vers", [])).stdout.trim();
receipt.image = JSON.parse(
  (await run("docker", ["image", "inspect", image])).stdout,
)[0].Id;
if (receipt.image !== image) throw Error("Installed image differs");
for (const [name, [command, args]] of stages) {
  try {
    const result = await run(command, args, 180000),
      bytes = Buffer.from(result.stdout + result.stderr);
    await writeFile(join(root, `${name}.log`), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    receipt.stages.push({
      name,
      passed: true,
      evidence: `${name}.log`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } catch (error) {
    const bytes = Buffer.from(
      String(error.stdout ?? "") + String(error.stderr ?? ""),
    );
    await writeFile(join(root, `${name}.log`), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    receipt.stages.push({
      name,
      passed: false,
      evidence: `${name}.log`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    process.exitCode = 1;
    break;
  }
  await writeFile(
    join(root, "platform-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { mode: 0o600 },
  );
}
receipt.deterministicChecksPassed =
  receipt.stages.length === stages.length &&
  receipt.stages.every((s) => s.passed);
await writeFile(
  join(root, "platform-receipt.json"),
  JSON.stringify(receipt, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    platform: receipt.platform,
    deterministicChecksPassed: receipt.deterministicChecksPassed,
    qualified: false,
    liveSubscriptionQualified: false,
  }),
);
