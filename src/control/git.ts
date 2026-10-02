import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { portableWorktreeLink } from "./worktreeLinks.js";
const exec = promisify(execFile);
export async function git(repo: string, args: string[]) {
  const result = (
    await exec(
      "git",
      ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", ...args],
      {
        cwd: repo,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60000,
      },
    )
  ).stdout;
  if (args[0] === "worktree" && args[1] === "add") {
    // The destination precedes the final commit/branch argument in every
    // application call. Skip standalone non-instance fixtures.
    await portableWorktreeLink(repo, args.at(-2)!);
  }
  return args.includes("diff") || args.includes("-z") ? result : result.trim();
}
