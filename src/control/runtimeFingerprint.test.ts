import test from "node:test";
import assert from "node:assert/strict";
import { authEnvironmentSchema } from "./authEnvironment.js";
import { goalSchema } from "./schema.js";
import { isolatedRuntimeSchema } from "./isolatedRuntime.js";
import {
  executionRuntimeHash,
  assertRuntimeBinding,
} from "./runtimeFingerprint.js";

function fixture() {
  const runtime = isolatedRuntimeSchema.parse({
    projects: { sample: { imageDigest: `sha256:${"a".repeat(64)}` } },
    providers: {
      cloud: {
        protocol: "responses",
        endpoint: "https://models.example/responses",
        model: "synthetic",
        authentication: { kind: "azure-cli" },
      },
    },
  });
  const goal = goalSchema.parse({
    title: "Synthetic",
    description: "Synthetic",
    repoPath: "/synthetic",
    maxCostUsd: 10,
    projectId: "sample",
    backend: { kind: "codex", model: "synthetic" },
    executionContract: {
      harness: "codex",
      provider: "azure",
      execution: "isolated",
      authentication: { kind: "controller", reference: "cloud" },
      usagePolicy: { kind: "metered", maxCostUsd: 10, estimatePerRunUsd: 1 },
    },
    admission: {
      configurationHash: "c".repeat(64),
      executionMode: "isolated",
      providerId: "cloud",
      runtimeHashVersion: 2,
      prompts: [],
    },
  });
  goal.admission!.runtimeHash = executionRuntimeHash(goal, runtime, []);
  return { goal, runtime };
}
test("runtime identity ignores unrelated providers, projects, auth and admission budgets", () => {
  const { goal, runtime } = fixture();
  const changed = structuredClone(runtime);
  changed.projects.other = { imageDigest: `sha256:${"b".repeat(64)}` };
  changed.providers.other = { ...changed.providers.cloud };
  const unrelatedAuth = authEnvironmentSchema.parse({
    id: "unrelated",
    harness: "codex",
    sessionDir: "unrelated",
    imageDigest: `sha256:${"b".repeat(64)}`,
    egress: { hosts: ["unrelated.example"] },
  });
  assertRuntimeBinding(goal, changed, [unrelatedAuth]);
  const budget = structuredClone(goal);
  if (budget.executionContract?.usagePolicy.kind === "metered")
    budget.executionContract.usagePolicy.maxCostUsd = 50;
  assert.equal(
    executionRuntimeHash(budget, changed, []),
    goal.admission!.runtimeHash,
  );
  assert.equal(goal.executionContract!.usagePolicy.kind, "metered");
  assert.equal(goal.maxCostUsd, 10);
});
test("selected endpoint, model, auth, image and harness changes fence admitted goals", () => {
  const { goal, runtime } = fixture();
  for (const mutate of [
    (r: any) =>
      (r.providers.cloud.endpoint = "https://other.example/responses"),
    (r: any) => (r.providers.cloud.model = "other"),
    (r: any) =>
      (r.providers.cloud.authentication = {
        kind: "secret",
        reference: { kind: "file", path: "synthetic-token" },
        header: "api-key",
      }),
    (r: any) => (r.projects.sample.imageDigest = `sha256:${"b".repeat(64)}`),
  ]) {
    const changed = structuredClone(runtime);
    mutate(changed);
    assert.throws(
      () => assertRuntimeBinding(goal, changed, []),
      /runtime changed/,
    );
  }
  const harness = structuredClone(goal);
  harness.executionContract!.harness = "claude-code";
  assert.throws(
    () => assertRuntimeBinding(harness, runtime, []),
    /runtime changed/,
  );
  assert.throws(
    () => assertRuntimeBinding(goal, runtime, [], "e".repeat(64)),
    /runtime changed/,
  );
});
test("legacy global hashes require a fresh admission even when their bytes match", () => {
  const { goal, runtime } = fixture();
  delete goal.admission!.runtimeHashVersion;
  assert.throws(
    () => assertRuntimeBinding(goal, runtime, []),
    /legacy binding/,
  );
});

test("selected session auth policy is bound while unrelated environments are ignored", () => {
  const { goal, runtime } = fixture();
  const auth = authEnvironmentSchema.parse({
    id: "selected",
    harness: "codex",
    sessionDir: "selected",
    imageDigest: `sha256:${"a".repeat(64)}`,
    egress: { hosts: ["provider.example"] },
  });
  goal.executionContract!.authentication = {
    kind: "session",
    reference: auth.id,
  };
  goal.admission!.runtimeHash = executionRuntimeHash(goal, runtime, [auth]);
  assertRuntimeBinding(goal, runtime, [auth]);
  const changed = structuredClone(auth);
  changed.egress.hosts = ["other.example"];
  assert.throws(
    () => assertRuntimeBinding(goal, runtime, [changed]),
    /runtime changed/,
  );
});
