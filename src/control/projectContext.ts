import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.js";
import { ControlError } from "./schema.js";
import { resolve } from "node:path";
import { repositoryIdentity } from "./repositories.js";
import type { Goal, Task } from "./schema.js";
export function projectIdentity(g: Goal) {
  return g.config.repository?.mode === "remote"
    ? repositoryIdentity(g.config.repository.remoteUrl)
    : resolve(g.config.repoPath);
}
export function pathsOverlap(left: string, right: string) {
  const prefix = (value: string) => {
    if (
      value.startsWith("/") ||
      value.split("/").includes("..") ||
      value.includes("\\")
    )
      return ""; // Unknown/invalid declarations conservatively own the whole repository.
    const wildcard = value.search(/[?*[{]/);
    const fixed = wildcard < 0 ? value : value.slice(0, wildcard);
    return fixed.replace(/\/$/, "");
  };
  const a = prefix(left),
    b = prefix(right);
  // Conservative glob-prefix intersection. False positives ask the owner; no LLM lock.
  return !a || !b || a === b || a.startsWith(b) || b.startsWith(a);
}
export function overlapEvidence(
  goal: Goal,
  tasks: Task[],
  other: Goal,
  otherTasks: Task[],
) {
  if (goal.id === other.id || projectIdentity(goal) !== projectIdentity(other))
    return [];
  const active = (t: Task) =>
    !["superseded", "cancelled", "failed"].includes(t.status);
  const pairs: {
    task: string;
    path: string;
    otherTask: string;
    otherPath: string;
  }[] = [];
  for (const task of tasks.filter(active))
    for (const sibling of otherTasks.filter(active))
      for (const path of task.spec.allowedPaths)
        for (const otherPath of sibling.spec.allowedPaths)
          if (pathsOverlap(path, otherPath))
            pairs.push({
              task: task.id,
              path,
              otherTask: sibling.id,
              otherPath,
            });
  return pairs;
}

export async function instructionManifest(goal: Goal, workspace: string) {
  let remaining = 64000;
  const instructions: { path: string; content: string; truncated: boolean }[] =
    [];
  const root = await realpath(workspace);
  for (const file of goal.config.instructionFiles ?? [
    "AGENTS.md",
    "README.md",
  ]) {
    if (file.startsWith("/") || file.split("/").includes(".."))
      throw new ControlError(
        "instruction_path",
        "Instructions must be repository-relative",
      );
    const path = join(root, file);
    const canonical = await realpath(path).catch(() => null);
    if (!canonical) continue;
    if (!canonical.startsWith(root + "/"))
      throw new ControlError(
        "instruction_path",
        "Instruction file escapes workspace",
      );
    const source = await readFile(path, "utf8");
    instructions.push({
      path: file,
      content: source.slice(0, remaining),
      truncated: source.length > remaining,
    });
    remaining = Math.max(0, remaining - source.length);
    if (!remaining) break;
  }
  const siblingContracts: {
    revision: string;
    files: { path: string; content: string }[];
  }[] = [];
  for (const contract of goal.config.siblingContracts ?? []) {
    const files = [];
    for (const path of contract.files) {
      if (
        path.startsWith("/") ||
        path.split("/").includes("..") ||
        /(^|\/)(\.env|\.ssh|\.azure|credentials)/.test(path)
      )
        throw new ControlError(
          "contract_path",
          "Sibling snapshots require explicit non-secret paths",
        );
      const content = await git(contract.repositoryPath, [
        "show",
        `${contract.revision}:${path}`,
      ]);
      if (content.length > remaining)
        throw new ControlError(
          "context_limit",
          "Declared contracts exceed bounded context",
        );
      remaining -= content.length;
      files.push({ path, content });
    }
    siblingContracts.push({ revision: contract.revision, files });
  }
  return { instructions, siblingContracts, configuredPrompts: goal.config.admission?.prompts ?? [] };
}
