import { lstat, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const directory = new URL("../dist/", import.meta.url);
const info = await lstat(directory).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
if (info?.isSymbolicLink()) throw new Error("Build output cannot be a symlink");
await rm(directory, { recursive: true, force: true });
const compiled = spawnSync(
  process.execPath,
  [new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname],
  { stdio: "inherit" },
);
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
await import("./chmod-bin.mjs");
await import("./source-bundle.mjs");
