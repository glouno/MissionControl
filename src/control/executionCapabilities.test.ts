import test from "node:test";
import assert from "node:assert/strict";
import {
  executionCapabilities,
  executionCapabilitiesSchema,
} from "./executionCapabilities.js";
import { goalSchema, type GoalConfig } from "./schema.js";
import { portableTools } from "./backends.js";
import { nativeBinding, nativeProfileSchema } from "./nativeConfig.js";

test("native capabilities preserve local customization and do not claim container isolation", () => {
  for (const permissions of ["devbox", "workspace-write"] as const) {
    const config = goalSchema.parse({
      title: "Native fixture",
      description: "Native fixture",
      repoPath: "/fixture/repository",
      backend: { kind: "codex", command: "codex", model: "fixture-model" },
      executionContract: {
        harness: "codex",
        provider: "codex-subscription",
        authentication: { kind: "local", reference: "fixture-login" },
        execution: "native",
        usagePolicy: { kind: "observed" },
      },
      admission: {
        configurationHash: "a".repeat(64),
        executionMode: "native",
        prompts: [],
        contexts: [],
        nativeProfile: nativeProfileSchema.parse({
          executable: "/fixture/codex",
          codexHome: "/fixture/codex-home",
          home: "/fixture/home",
          path: "/fixture/bin",
          permissions,
        }),
      },
    });
    config.admission!.runtimeHash = nativeBinding(config);
    const projection = executionCapabilities(config);
    assert.equal(projection.path, "native_codex_exec");
    assert.equal(projection.features.nativeCustomization.state, "supported");
    assert.equal(projection.features.integrations.state, "supported");
    assert.equal(projection.features.sessionContinuation.state, "supported");
    assert.equal(projection.features.isolation.state, "unavailable");
    assert.equal(projection.features.boundedEgress.state, "unavailable");
    assert.equal(
      projection.features.nativeApprovals.state,
      "disabled_by_policy",
    );
    assert.ok(!JSON.stringify(projection).includes("/fixture/"));
    executionCapabilitiesSchema.parse(projection);
    config.admission!.nativeProfile!.path += ":/changed";
    assert.equal(executionCapabilities(config).path, "unavailable");
  }
});

function capabilityFixture(
  kind: "codex" | "azure" | "bedrock" | "vertex" | "claude-code",
  subscription = false,
): GoalConfig {
  return goalSchema.parse({
    title: "Fixture",
    description: "Fixture",
    repoPath: "/synthetic-private-path",
    backend:
      kind === "azure"
        ? {
            kind,
            model: "fixture",
            endpoint: "https://example.invalid",
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          }
        : kind === "bedrock"
          ? {
              kind,
              model: "fixture",
              region: "fixture",
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            }
          : kind === "vertex"
            ? {
                kind,
                project: "fixture-project",
                quotaProject: "fixture-quota",
                location: "global",
                model: "gemini-4-argon",
                thinkingLevel: "high",
                maxInputTokens: 8192,
                maxOutputTokens: 1024,
                maxRequestCostUsd: 1,
                pricing: [
                  {
                    version: "fixture",
                    currency: "USD",
                    effectiveFrom: "2026-01-01T00:00:00Z",
                    effectiveUntil: "2027-01-01T00:00:00Z",
                    inputUsdPerMillion: 1,
                    cachedInputUsdPerMillion: 1,
                    outputUsdPerMillion: 1,
                    thinkingUsdPerMillion: 1,
                    evidenceUrl: "https://example.invalid/pricing",
                  },
                ],
              }
            : { kind, model: "synthetic-private-model" },
    maxCostUsd: subscription ? 0 : 1,
    estimatePerRunUsd: subscription ? 0 : 1,
    maxWorkers: 1,
    maxAttempts: 1,
    timeoutMs: 1000,
    executionContract: {
      harness: ["azure", "bedrock", "vertex"].includes(kind)
        ? "tool-loop"
        : kind,
      provider: subscription
        ? kind === "codex"
          ? "codex-subscription"
          : "claude-subscription"
        : ["codex", "claude-code"].includes(kind)
          ? "azure"
          : kind,
      authentication: {
        kind: subscription ? "session" : "controller",
        reference: "synthetic-private-auth",
      },
      execution: "isolated",
      usagePolicy: subscription
        ? {
            kind: "subscription",
            maxAttempts: 1,
            timeoutMs: 1000,
            maxConcurrency: 1,
          }
        : { kind: "metered", maxCostUsd: 1, estimatePerRunUsd: 1 },
    },
  });
}
test("projection distinguishes all three execution paths and does not equate source support with admission", () => {
  const paid = executionCapabilities(capabilityFixture("codex"));
  const subscription = executionCapabilities(capabilityFixture("codex", true));
  const portable = executionCapabilities(capabilityFixture("azure"));
  assert.equal(paid.path, "paid_codex_app_server");
  assert.equal(subscription.path, "subscription_codex_exec");
  assert.equal(portable.path, "portable_tool_loop");
  assert.equal(paid.features.integrations.state, "unavailable");
  assert.equal(subscription.features.integrations.state, "disabled_by_policy");
  assert.equal(portable.features.integrations.state, "unavailable");
  assert.equal(subscription.features.boundedEgress.state, "supported");
  assert.equal(paid.features.boundedEgress.state, "unavailable");
  assert.equal(portable.features.ownerHandoff.state, "unavailable");
  assert.equal(paid.features.ownerHandoff.state, "supported");
  assert.equal(portable.features.sessionContinuation.state, "supported");
  assert.equal(
    subscription.features.sessionContinuation.state,
    "disabled_by_policy",
  );
  assert.deepEqual(
    portableTools.map((t) => t.name),
    [
      "read_file",
      "write_file",
      "list_files",
      "shell",
      "request_human_input",
      "checkpoint",
    ],
  );
  for (const c of [paid, subscription, portable]) {
    assert.deepEqual(executionCapabilitiesSchema.parse(c), c);
    for (const name of [
      "tools",
      "instructions",
      "isolation",
      "humanHandoff",
      "structuredOutput",
      "usage",
    ] as const)
      assert.equal(c.features[name].state, "supported");
    for (const name of [
      "networkAccess",
      "nativeApprovals",
      "publication",
      "autoMerge",
    ] as const)
      assert.equal(c.features[name].state, "disabled_by_policy");
    assert.deepEqual(Object.keys(c), ["version", "basis", "path", "features"]);
  }
  for (const kind of ["bedrock", "vertex"] as const)
    assert.deepEqual(executionCapabilities(capabilityFixture(kind)), portable);
  assert.equal(
    executionCapabilities(capabilityFixture("claude-code")).features
      .integrations.state,
    "disabled_by_policy",
  );
});
test("missing or mismatched contracts do not invent native support; synthetic and admitted policy stay explicit", () => {
  const config = capabilityFixture("codex");
  const missing = { ...config, executionContract: undefined };
  for (const c of [
    missing,
    {
      ...config,
      executionContract: capabilityFixture("azure").executionContract,
    },
  ]) {
    const projection = executionCapabilities(c);
    assert.equal(projection.path, "unavailable");
    assert.ok(
      Object.values(projection.features).every(
        (f) => f.state === "unavailable",
      ),
    );
  }
  const synthetic = executionCapabilities(
    goalSchema.parse({
      title: "Fixture",
      description: "Fixture",
      repoPath: "/fixture",
    }),
  );
  assert.equal(synthetic.path, "synthetic");
  assert.equal(synthetic.features.tools.state, "unavailable");
  const allowed = executionCapabilities({
    ...config,
    policy: { ...config.policy, publish: true, autoMerge: true },
  });
  assert.equal(allowed.features.publication.state, "supported");
  assert.equal(allowed.features.autoMerge.state, "supported");
  assert.equal(allowed.features.nativeApprovals.state, "disabled_by_policy");
});
