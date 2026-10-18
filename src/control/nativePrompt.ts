import type { RunContext } from "./backend.js";

/** Translate only controller-known repository paths; private context is otherwise preserved. */
export function nativePrompt(context: RunContext) {
  if (!context.execution) return context.prompt;
  const workspace = context.execution.workspace;
  let prompt = context.prompt;
  for (const path of [
    ...new Set([context.workspace, context.claim.goal.config.repoPath]),
  ].sort((a, b) => b.length - a.length)) {
    if (!path || path === workspace) continue;
    prompt = prompt.split(path).join(workspace);
  }
  return `Execution workspace: ${workspace}. Run repository commands from this directory. The supplied source is a private copy at its exact admitted commit. Controller host directories are not mounted; use repository-relative paths inside this workspace.\n\n${prompt}`;
}
