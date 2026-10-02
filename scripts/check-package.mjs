import { execFileSync } from "node:child_process";
import { permitted, packageRoot } from "./publication-audit.mjs";
const pack = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
  }),
)[0];
for (const file of pack.files)
  if (!permitted(file.path, "installed"))
    throw new Error(`Unexpected npm payload: ${file.path}`);
for (const path of [
  "dist/cli.js",
  "profiles/synthetic.json",
  "LICENSE",
  "publication.json",
  "assets/source.tar.gz",
  "assets/source-manifest.json",
  "THIRD_PARTY_NOTICES.md",
])
  if (!pack.files.some((f) => f.path === path))
    throw new Error(`Missing required package asset: ${path}`);
console.log(
  JSON.stringify({
    passed: true,
    files: pack.files.length,
    scriptsExecuted: false,
  }),
);
