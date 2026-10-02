// Collect actual shipped dependency notices for review; never declares legal qualification.
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  lstat,
  realpath,
} from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const source = fileURLToPath(new URL("../", import.meta.url)),
  destination = process.argv[2];
if (!destination)
  throw Error("Supply a new private license-review destination outside source");
const root = resolve(destination),
  rel = relative(source, root);
if (!rel.startsWith(".."))
  throw Error("License evidence must be outside source");
await mkdir(root, { mode: 0o700 });
const lock = JSON.parse(
  await readFile(join(source, "package-lock.json"), "utf8"),
);
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--manifest-path",
      "connectors/matrix/Cargo.toml",
    ],
    {
      cwd: source,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ),
);
// cargo metadata includes inactive optional, dev and foreign-target packages.
// Keep that inventory separately; target-specific normal/build trees define the
// conservative supported-binary review set (including build-time obligations).
const targets = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
];
const targetReceipts = [],
  targetPackages = new Map();
for (const target of targets) {
  const tree = execFileSync(
    "cargo",
    [
      "tree",
      "--locked",
      "--manifest-path",
      "connectors/matrix/Cargo.toml",
      "--target",
      target,
      "--edges",
      "normal,build",
      "--prefix",
      "none",
      "--format",
      "{p}",
    ],
    {
      cwd: source,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const keys = new Set();
  for (const line of tree.trim().split("\n")) {
    const parsed = /^([A-Za-z0-9_-]+) v([^\s]+)(?:\s|$)/.exec(line);
    if (!parsed)
      throw Error(
        "Unrecognized Cargo tree entry; review target inventory before release",
      );
    const key = `${parsed[1]}@${parsed[2]}`;
    if (
      !metadata.packages.some(
        (p) => p.name === parsed[1] && p.version === parsed[2],
      )
    )
      throw Error("Cargo target tree differs from locked metadata");
    keys.add(key);
    targetPackages.set(key, [
      ...new Set([...(targetPackages.get(key) ?? []), target]),
    ]);
  }
  targetReceipts.push({
    target,
    packages: keys.size,
    treeSha256: createHash("sha256").update(tree).digest("hex"),
    binaryBuilt: false,
    platformQualified: false,
  });
}
const rustLock = await readFile(
  join(source, "connectors/matrix/Cargo.lock"),
  "utf8",
);
const checksums = new Map();
for (const block of rustLock.split("[[package]]").slice(1)) {
  const name = /^name = "([^"]+)"$/m.exec(block)?.[1],
    version = /^version = "([^"]+)"$/m.exec(block)?.[1],
    checksum = /^checksum = "([a-f0-9]{64})"$/m.exec(block)?.[1];
  if (name && version && checksum)
    checksums.set(`${name}@${version}`, checksum);
}
const supplementPath = process.argv[3] ? resolve(process.argv[3]) : undefined;
const supplement = supplementPath
  ? JSON.parse(await readFile(supplementPath, "utf8"))
  : undefined;
if (
  supplement &&
  (supplement.schemaVersion !== 1 || !Array.isArray(supplement.packages))
)
  throw Error("Unsupported supplemental notice manifest");
const packages = [];
for (const [path, pkg] of Object.entries(lock.packages))
  if (path && !pkg.dev) {
    const pathRoot = join(source, path),
      meta = JSON.parse(await readFile(join(pathRoot, "package.json"), "utf8"));
    if (meta.version !== pkg.version)
      throw Error("Installed npm version differs from lock");
    packages.push({
      ecosystem: "npm",
      name: meta.name,
      version: meta.version,
      license: meta.license,
      origin: meta.repository ?? meta.homepage,
      integrity: pkg.integrity,
      root: pathRoot,
    });
  }
for (const pkg of metadata.packages.filter(
  (p) => p.source && targetPackages.has(`${p.name}@${p.version}`),
))
  packages.push({
    ecosystem: "cargo",
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    origin: pkg.repository ?? pkg.source,
    root: dirname(pkg.manifest_path),
    targets: targetPackages.get(`${pkg.name}@${pkg.version}`),
    checksum: checksums.get(`${pkg.name}@${pkg.version}`),
  });
const report = {
  schemaVersion: 1,
  qualification:
    "unqualified: collected notices require redistribution/corresponding-source review",
  packages: [],
  targets: targetReceipts,
  cargoMetadataInventory: metadata.packages
    .filter((p) => p.source)
    .map((p) => ({
      name: p.name,
      version: p.version,
      inSupportedReview: targetPackages.has(`${p.name}@${p.version}`),
    })),
  cargoSelection:
    "Normal/build dependencies for supported targets; conservative review scope, not proof of linked binary contents",
  findings: [],
  vendorBinariesShipped: false,
  imagesShipped: false,
};
for (const pkg of packages) {
  const key = `${pkg.ecosystem}/${pkg.name.replaceAll("/", "__")}/${pkg.version}`,
    notices = [];
  if (
    report.packages.some(
      (p) =>
        p.ecosystem === pkg.ecosystem &&
        p.name === pkg.name &&
        p.version === pkg.version,
    )
  )
    continue;
  async function walk(directory, depth = 0) {
    if (depth > 10) throw Error("Notice traversal bound exceeded");
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        info = await lstat(path);
      if (info.isSymbolicLink()) {
        report.findings.push({
          package: key,
          path: relative(pkg.root, path),
          rule: "symlink_requires_review",
        });
        continue;
      }
      if (info.isDirectory()) {
        if (
          ![
            "node_modules",
            ".git",
            "target",
            "tests",
            "test",
            "benches",
          ].includes(name)
        )
          await walk(path, depth + 1);
        continue;
      }
      if (
        !info.isFile() ||
        !(
          /^(?:licen[cs]e|copying|copyright|notice)(?:[._-]|$)/i.test(name) ||
          /licen[cs]e/i.test(name)
        )
      )
        continue;
      if (info.size > 4 * 1024 * 1024)
        throw Error("Notice size bound exceeded");
      const bytes = await readFile(path);
      if (bytes.includes(0)) {
        report.findings.push({
          package: key,
          path: relative(pkg.root, path),
          rule: "binary_notice_requires_review",
        });
        continue;
      }
      const entry = relative(pkg.root, path).replaceAll("\\", "/"),
        target = join(root, "notices", key, entry);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      notices.push({
        path: entry,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  if ((await realpath(pkg.root)) !== pkg.root)
    throw Error("Package notice root is redirected");
  await walk(pkg.root);
  let vcs, sourceArchive;
  if (pkg.ecosystem === "cargo") {
    try {
      const candidate = JSON.parse(
        await readFile(join(pkg.root, ".cargo_vcs_info.json"), "utf8"),
      );
      if (
        !/^[a-f0-9]{40}$/.test(candidate.git?.sha1) ||
        (candidate.path_in_vcs !== undefined &&
          typeof candidate.path_in_vcs !== "string") ||
        (candidate.path_in_vcs ?? "").split("/").includes("..")
      )
        throw Error("Invalid VCS provenance");
      vcs = { revision: candidate.git.sha1, path: candidate.path_in_vcs ?? "" };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const archive = join(
      dirname(dirname(pkg.root)),
      "..",
      "cache",
      dirname(pkg.root).split("/").at(-1),
      `${pkg.name}-${pkg.version}.crate`,
    );
    try {
      const info = await lstat(archive);
      if (!info.isFile() || info.isSymbolicLink())
        throw Error("Dependency source archive is redirected");
      const bytes = await readFile(archive),
        sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== pkg.checksum)
        throw Error("Published Cargo archive checksum differs from lockfile");
      sourceArchive = { sha256, bytes: bytes.length, checksumVerified: true };
      // Keep exact published source private until its packaging/privacy/notice review.
      if (/MPL|LGPL|GPL/.test(pkg.license ?? "")) {
        const file = `sources/${pkg.name}-${pkg.version}.crate`;
        await mkdir(join(root, "sources"), { recursive: true, mode: 0o700 });
        await writeFile(join(root, file), bytes, { flag: "wx", mode: 0o600 });
        sourceArchive.file = file;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      report.findings.push({
        package: key,
        rule: "published_source_archive_unavailable",
      });
    }
  }
  const supplemental = supplement?.packages.find((p) => p.package === key);
  if (supplemental) {
    if (!vcs?.revision || !Array.isArray(supplemental.notices))
      throw Error("Supplement requires package VCS provenance");
    for (const notice of supplemental.notices) {
      if (
        notice.revision !== vcs.revision ||
        typeof notice.file !== "string" ||
        notice.file.startsWith("/") ||
        notice.file.split("/").some((p) => !p || p === ".." || p === ".")
      )
        throw Error("Supplemental license revision/path differs");
      const url = new URL(notice.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !["raw.githubusercontent.com", "codeberg.org"].includes(url.hostname) ||
        !url.pathname.split("/").includes(vcs.revision)
      )
        throw Error("Supplement requires an exact upstream revision URL");
      // The manifest is evidence, not authority: validate the upstream repository too.
      const origin = String(pkg.origin)
        .replace(/\.git$/, "")
        .replace(/\/$/, "");
      const expected = origin.startsWith("https://github.com/")
        ? new URL(origin).pathname.split("/").slice(1, 3).join("/")
        : new URL(origin).pathname.slice(1);
      const expectedHost = origin.startsWith("https://github.com/")
        ? "raw.githubusercontent.com"
        : "codeberg.org";
      if (
        url.hostname !== expectedHost ||
        !url.pathname.startsWith(`/${expected}/`)
      )
        throw Error(
          "Supplemental license comes from a different upstream repository",
        );
      const from = resolve(dirname(supplementPath), notice.file),
        info = await lstat(from);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (await realpath(from)) !== from
      )
        throw Error("Supplemental notice is redirected");
      const bytes = await readFile(from),
        sha256 = createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.length !== notice.bytes ||
        bytes.length > 4 * 1024 * 1024 ||
        bytes.includes(0) ||
        sha256 !== notice.sha256
      )
        throw Error("Supplemental notice content differs from receipt");
      const basename = url.pathname.split("/").at(-1);
      if (
        !/^(?:LICENSE|COPYING|COPYRIGHT|NOTICE)[A-Za-z0-9._-]*$/i.test(
          basename ?? "",
        )
      )
        throw Error("Supplemental notice filename is unsafe");
      const path = `supplemental/${basename}`,
        target = join(root, "notices", key, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      notices.push({
        path,
        bytes: bytes.length,
        sha256,
        provenance: { url: notice.url, revision: vcs.revision },
        reviewComplete: false,
      });
    }
  }
  const { root: privatePath, ...publicMetadata } = pkg;
  report.packages.push({
    ...publicMetadata,
    vcs,
    sourceArchive,
    notices,
    correspondingSourceRequired: /MPL|LGPL|GPL/.test(pkg.license ?? ""),
    reviewComplete: false,
  });
  if (!notices.length)
    report.findings.push({ package: key, rule: "no_packaged_license_text" });
  if (!pkg.license)
    report.findings.push({ package: key, rule: "no_declared_license" });
}
report.lockfiles = {};
for (const path of ["package-lock.json", "connectors/matrix/Cargo.lock"])
  report.lockfiles[path] = createHash("sha256")
    .update(await readFile(join(source, path)))
    .digest("hex");
await writeFile(
  join(root, "license-review.json"),
  JSON.stringify(report, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(
  JSON.stringify({
    packages: report.packages.length,
    notices: report.packages.reduce((n, p) => n + p.notices.length, 0),
    findings: report.findings.length,
    reviewComplete: false,
  }),
);
