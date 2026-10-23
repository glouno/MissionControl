import test from "node:test";
import assert from "node:assert/strict";
import type { RunContext } from "./backend.js";
import { nativePrompt } from "./nativePrompt.js";

function context(
  prompt: string,
  repoPath = "/repos/app",
  workspace = "/workspace",
): RunContext {
  return {
    workspace: "/controller/task",
    claim: { goal: { config: { repoPath } } },
    execution: { workspace },
    prompt,
  } as RunContext;
}

function expected(prompt: string, workspace = "/workspace") {
  return `Execution workspace: ${workspace}. Run repository commands from this directory. The supplied source is a private copy at its exact admitted commit. Controller host directories are not mounted; use repository-relative paths inside this workspace.\n\n${prompt}`;
}

test("native prompt preserves sibling-prefix and embedded repository paths", () => {
  const prompt = [
    "/repos/app-other/README.md",
    "/repos/application",
    "/repos/app_backup",
    "/repos/app.git/config",
    "/repos/app2",
    "/repos/appé/file.ts",
    "/controller/task-other/file.ts",
    "/backup/repos/app/file.ts",
    "./repos/app/file.ts",
  ].join("\n");
  assert.equal(nativePrompt(context(prompt)), expected(prompt));
});

test("native prompt translates repository roots and repository-relative paths", () => {
  assert.equal(nativePrompt(context("/repos/app")), expected("/workspace"));
  assert.equal(
    nativePrompt(context("repo=/repos/app; inspect /repos/app.")),
    expected("repo=/workspace; inspect /workspace."),
  );
  assert.equal(
    nativePrompt(
      context(
        'Inspect /repos/app/src/main.ts and /controller/task/README.md. Run from `/repos/app`, ("/controller/task"). Keep src/main.ts.',
      ),
    ),
    expected(
      'Inspect /workspace/src/main.ts and /workspace/README.md. Run from `/workspace`, ("/workspace"). Keep src/main.ts.',
    ),
  );
});

test("native prompt treats source and replacement paths literally", () => {
  const repoPath = "/repos/a[1]+(app).git";
  const prompt = `${repoPath}/src/main.ts ${repoPath}-other/src/main.ts /repos/a1appXgit/src/main.ts`;
  assert.equal(
    nativePrompt(context(prompt, repoPath, "/workspace/$&")),
    expected(
      `/workspace/$&/src/main.ts ${repoPath}-other/src/main.ts /repos/a1appXgit/src/main.ts`,
      "/workspace/$&",
    ),
  );
});

test("native prompt leaves execution workspace paths intact", () => {
  assert.equal(
    nativePrompt(context("/workspace/src/main.ts", "/workspace")),
    expected("/workspace/src/main.ts"),
  );
});

test("native prompt preserves the original prompt without native execution", () => {
  const original = context(
    "Inspect /repos/app/src/main.ts and /repos/app-other.",
  );
  assert.equal(
    nativePrompt({ ...original, execution: undefined }),
    original.prompt,
  );
});

test("quoted sibling filenames retain punctuation and spaces while admitted paths translate", () => {
  for (const quote of ['"', "'", "`"]) {
    for (const suffix of [
      ":backup",
      ";backup",
      ",backup",
      "=backup",
      " backup",
      "(backup)",
      "[backup]",
      "{backup}",
      ".",
      "!",
      "?",
    ]) {
      const sibling = `/repos/app${suffix}/file`;
      const prompt = `Inspect ${quote}${sibling}${quote} and ${quote}/repos/app/file${quote} from ${quote}/repos/app${quote}.`;
      assert.equal(
        nativePrompt(context(prompt)),
        expected(
          `Inspect ${quote}${sibling}${quote} and ${quote}/workspace/file${quote} from ${quote}/workspace${quote}.`,
        ),
        prompt,
      );
    }
  }
});

test("quoted paths with escaped quotes and JSON context keep sibling boundaries", () => {
  const prompt = JSON.stringify({
    sibling: "/repos/app:backup/file",
    source: "/repos/app/file",
    instruction: 'Inspect "quoted" /repos/app/file',
  });
  assert.equal(
    nativePrompt(context(prompt)),
    expected(
      JSON.stringify({
        sibling: "/repos/app:backup/file",
        source: "/workspace/file",
        instruction: 'Inspect "quoted" /workspace/file',
      }),
    ),
  );
});

test("overlapping admitted roots and replacement prefixes translate once", () => {
  const input = context(
    "/repos/app/task/file /repos/app/file /repos/app/task-other/file",
    "/repos/app",
    "/repos/app/task/execution",
  );
  input.workspace = "/repos/app/task";
  assert.equal(
    nativePrompt(input),
    expected(
      "/repos/app/task/execution/file /repos/app/task/execution/file /repos/app/task/execution/task-other/file",
      "/repos/app/task/execution",
    ),
  );
});
