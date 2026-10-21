import test from "node:test";
import assert from "node:assert/strict";
import { goalSchema } from "./schema.js";
import { executionLimits } from "./executionLimits.js";

test("effective limits expose deployment output caps without inventing unavailable native limits", () => {
  const config = goalSchema.parse({
    title: "Fixture",
    description: "Fixture",
    repoPath: "/fixture",
    backend: { kind: "codex", maxOutputTokens: 65536 },
    timeoutMs: 600000,
    planning: { maxRequests: 12 },
    admission: {
      configurationHash: "a".repeat(64),
      executionMode: "isolated",
      providerId: "fixture",
      prompts: [],
    },
  });
  assert.equal(executionLimits(config).outputTokensPerRequest, null);
  const limits = executionLimits(config, {
    hosts: [
      {
        isolatedRuntime: { providers: { fixture: { maxOutputTokens: 32768 } } },
      },
    ],
  });
  assert.equal(limits.outputTokensPerRequest, 32768);
  assert.equal(limits.planning.timeoutMs, 600000);
  assert.equal(limits.planning.maxRequests, 12);
  assert.equal(limits.harness, "Codex app-server");
  assert.match(limits.outputLimitMeaning, /truncate/);
});
