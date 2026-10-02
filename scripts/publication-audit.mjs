import { readdir, lstat, readFile } from "node:fs/promises";
import { resolve, join, relative, matchesGlob, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { verifySourceArchive } from "./source-bundle-format.mjs";

export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const inventory = JSON.parse(
  await readFile(join(packageRoot, "publication.json"), "utf8"),
);
export function permitted(path, kind = "source") {
  const patterns = inventory[kind];
  return (
    patterns.some((p) => !p.startsWith("!") && matchesGlob(path, p)) &&
    !patterns.some((p) => p.startsWith("!") && matchesGlob(path, p.slice(1)))
  );
}
export async function audit(root = packageRoot, kind = "source", markers = []) {
  root = resolve(root);
  const files = [],
    findings = [];
  async function visit(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const full = join(dir, name),
        path = relative(root, full).replaceAll("\\", "/"),
        info = await lstat(full);
      // Worktrees use a .git pointer file; neither Git representation belongs to exported source.
      if (path === ".git") continue;
      if (info.isSymbolicLink()) {
        findings.push({ path, rule: "symlink_requires_disposition" });
        continue;
      }
      if (info.isDirectory()) {
        if (
          inventory.excludedDirectories.includes(name) &&
          !(kind === "installed" && ["dist", "assets"].includes(name))
        )
          continue;
        if (inventory.prohibitedSegments.includes(name)) {
          findings.push({ path, rule: "prohibited_directory" });
          continue;
        }
        await visit(full);
        continue;
      }
      if (!info.isFile()) {
        findings.push({ path, rule: "non_regular_file" });
        continue;
      }
      if (!permitted(path, kind))
        findings.push({ path, rule: "outside_publication_inventory" });
      if (
        path.split("/").some((p) => inventory.prohibitedSegments.includes(p)) ||
        /^\.env(?:\.|$)/.test(name) ||
        inventory.prohibitedExtensions.includes(extname(name))
      )
        findings.push({ path, rule: "prohibited_file" });
      const data = await readFile(full);
      if (kind === "installed" && path === "assets/source.tar.gz") {
        try {
          const manifest = JSON.parse(
            await readFile(join(root, "assets/source-manifest.json"), "utf8"),
          );
          verifySourceArchive(
            data,
            manifest,
            permitted,
            (sourcePath, bytes) => {
              if (bytes.includes(0))
                findings.push({
                  path: sourcePath,
                  rule: "bundled_binary_requires_disposition",
                });
              const content = bytes.toString("utf8");
              if (
                /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-proj-[A-Za-z0-9_-]{30,}\b/.test(
                  content,
                )
              )
                findings.push({
                  path: sourcePath,
                  rule: "bundled_credential_pattern",
                });
              if (
                markers.some(
                  (m) =>
                    m.length >= 4 &&
                    content.toLowerCase().includes(m.toLowerCase()),
                )
              )
                findings.push({
                  path: sourcePath,
                  rule: "bundled_private_content_marker",
                });
            },
          );
          files.push({
            path,
            bytes: data.length,
            sha256: createHash("sha256").update(data).digest("hex"),
          });
        } catch {
          findings.push({ path, rule: "bundled_source_invalid" });
        }
        continue;
      }
      if (data.includes(0)) {
        findings.push({ path, rule: "binary_requires_disposition" });
        continue;
      }
      const text = data.toString("utf8");
      if (
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-proj-[A-Za-z0-9_-]{30,}\b/.test(
          text,
        )
      )
        findings.push({ path, rule: "credential_pattern" });
      // Marker names and matched content never enter the report or public CI.
      if (
        markers.some(
          (m) => m.length >= 4 && text.toLowerCase().includes(m.toLowerCase()),
        )
      )
        findings.push({ path, rule: "private_content_marker" });
      files.push({
        path,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
    }
  }
  await visit(root);
  return { schemaVersion: 1, kind, passed: !findings.length, files, findings };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const markerPath = process.env.MISSIONCONTROL_PRIVACY_MARKERS;
  const markers = markerPath
    ? JSON.parse(await readFile(resolve(markerPath), "utf8"))
    : [];
  if (!Array.isArray(markers) || !markers.every((m) => typeof m === "string"))
    throw new Error("Private markers must be an array of strings");
  const report = await audit(
    process.argv[2] || packageRoot,
    process.argv[3] || "source",
    markers,
  );
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
