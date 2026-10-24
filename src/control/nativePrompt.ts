import type { RunContext } from "./backend.js";

/** Translate only controller-known repository paths; private context is otherwise preserved. */
export function nativePrompt(context: RunContext) {
  if (!context.execution) return context.prompt;
  const workspace = context.execution.workspace;
  const paths = [
    ...new Set([context.workspace, context.claim.goal.config.repoPath]),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const source = context.prompt;
  const delimiter = /[\s"'`<>()\[\]{},;:=]/;
  let prompt = "",
    quote = "";
  for (let index = 0; index < source.length;) {
    const before = source[index - 1];
    const path = paths.find((path) => {
      if (!source.startsWith(path, index)) return false;
      const after = source[index + path.length];
      if (quote) {
        // Punctuation and spaces inside a quoted filename belong to that
        // filename. A colon, comma or semicolon is not a path boundary here.
        return (
          (!before || before === quote || /\s/.test(before)) &&
          (!after || after === "/" || after === quote)
        );
      }
      return (
        (!before || delimiter.test(before)) &&
        (!after ||
          after === "/" ||
          delimiter.test(after) ||
          (/[.!?]/.test(after) &&
            (!source[index + path.length + 1] ||
              delimiter.test(source[index + path.length + 1]))))
      );
    });
    if (path) {
      prompt += workspace;
      index += path.length;
      continue;
    }
    const character = source[index];
    // Preserve escaped quotes, including quotes in JSON strings, without
    // changing the surrounding quoted-path boundary rules.
    if (character === "\\" && source[index + 1]) {
      prompt += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
    } else if (
      /['"`]/.test(character) &&
      (character !== "'" || !before || delimiter.test(before))
    ) {
      quote = character;
    }
    prompt += character;
    index++;
  }
  return `Execution workspace: ${workspace}. Run repository commands from this directory. The supplied source is a private copy at its exact admitted commit. Controller host directories are not mounted; use repository-relative paths inside this workspace.\n\n${prompt}`;
}
