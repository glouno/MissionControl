import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { readContractSnapshot } from "./contractSnapshots.js";
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
  const limit = goal.config.contextMaxCharacters ?? 256000;
  let remaining = limit;
  const manifest: { path: string; characters: number; injected: boolean }[] =
    [];
  const account = (path: string, source: string, injected = true) => {
    manifest.push({ path, characters: source.length, injected });
    if (!injected) return;
    remaining -= source.length;
  };
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
      content: source,
      truncated: false,
    });
    account(file, source);
  }
  const siblingContracts: {
    revision: string;
    files: { path: string; content: string }[];
  }[] = [];
  const contracts = goal.config.siblingContracts ?? [];
  const snapshot = await readContractSnapshot(contracts);
  for (const [index, contract] of contracts.entries()) {
    const files = [];
    if (contract.injectedFiles?.some((path) => !contract.files.includes(path)))
      throw new ControlError(
        "contract_path",
        "Injected files must belong to the pinned snapshot",
        409,
      );
    for (const path of contract.files) {
      const bytes = snapshot.contents.find(
        (file) => file.path === `${index}/${path}`,
      )!.content;
      const injected =
        contract.injectedFiles === undefined ||
        contract.injectedFiles.includes(path);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: injected }).decode(bytes);
      } catch {
        throw new ControlError(
          "contract_text",
          "Injected contract files require valid UTF-8",
          409,
        );
      }
      account(`${contract.revision}:${path}`, content, injected);
      if (injected) files.push({ path, content });
    }
    siblingContracts.push({ revision: contract.revision, files });
  }
  account("runtimeInstructions", goal.config.runtimeInstructions ?? "");
  if (remaining < 0)
    throw new ControlError(
      "context_limit",
      `Effective instruction and contract context uses ${limit - remaining} characters; configured limit ${limit}. Files: ${JSON.stringify(manifest)}`,
      409,
    );
  return {
    contextBudget: {
      limitCharacters: limit,
      injectedCharacters: limit - remaining,
      files: manifest,
    },
    runtimeInstructions: goal.config.runtimeInstructions ?? "",
    instructions,
    siblingContracts,
    configuredPrompts: goal.config.admission?.prompts ?? [],
  };
}
