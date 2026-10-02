import test from "node:test";
import assert from "node:assert/strict";
import { executionUsage, usageSchema, knownCost } from "./usage.js";
test("admitted billing mode rejects mismatched receipts and never infers subscription measurements", () => {
  const subscription = {
    backend: { kind: "codex" },
    executionContract: { usagePolicy: { kind: "subscription" } },
  };
  assert.deepEqual(
    executionUsage({ inputTokens: 0, outputTokens: 0 }, subscription),
    { kind: "subscription", status: "unknown" },
  );
  const reported = {
    kind: "subscription" as const,
    status: "reported" as const,
    inputTokens: 0,
    elapsedMs: 100,
  };
  assert.deepEqual(executionUsage({ usage: reported }, subscription), reported);
  assert.equal(knownCost(reported), undefined);
  assert.throws(() => executionUsage({ costUsd: 0 }, subscription), /dollar/);
  assert.throws(
    () =>
      executionUsage(
        { usage: { kind: "metered", status: "unknown" } },
        subscription,
      ),
    /differs/,
  );
  assert.throws(() =>
    usageSchema.parse({
      kind: "subscription",
      status: "reported",
      elapsedMs: 100,
    }),
  );
  const metered = {
    backend: { kind: "azure" },
    executionContract: { usagePolicy: { kind: "metered" } },
  };
  assert.throws(
    () => executionUsage({ usage: { kind: "synthetic" } }, metered),
    /differs/,
  );
  assert.throws(() => executionUsage({ usage: reported }, metered), /differs/);
  assert.deepEqual(JSON.parse(JSON.stringify(executionUsage({}, metered))), {
    kind: "metered",
    status: "unknown",
  });
});
