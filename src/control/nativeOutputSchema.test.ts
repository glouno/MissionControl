import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  nativeOutputSchema,
  normalizeNativeOutput,
} from "./nativeOutputSchema.js";
import { workerResponseSchema, responseHandoff } from "./workerHandoff.js";
import { planSchema } from "./schema.js";

function assertStrict(schema: any) {
  if (!schema || typeof schema !== "object") return;
  if (schema.properties) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, Object.keys(schema.properties));
  }
  Object.values(schema).forEach((value) => {
    if (Array.isArray(value)) value.forEach(assertStrict);
    else assertStrict(value);
  });
}

test("native worker and planning schemas satisfy recursive strict object requirements", () => {
  for (const schema of [workerResponseSchema, planSchema]) {
    const original = z.toJSONSchema(schema, { io: "input", target: "draft-7" });
    const before = JSON.stringify(original);
    assertStrict(nativeOutputSchema(original));
    assert.equal(JSON.stringify(original), before);
  }
});

test("optional wire nulls preserve valid question handoffs and required nulls stay invalid", () => {
  const original = z.toJSONSchema(workerResponseSchema, {
    io: "input",
    target: "draft-7",
  });
  const normalized = normalizeNativeOutput(
    {
      text: "Decision needed",
      ownerOperation: null,
      question: {
        question: "Which?",
        reason: "Select behavior",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        category: null,
        recommendedOption: null,
        recoveryAttemptId: null,
        commit: null,
        requestedMaxCostUsd: null,
        requestedRunEstimateUsd: null,
      },
    },
    original,
  );
  const handoff = responseHandoff(normalized, true);
  assert.ok(handoff.wait);
  assert.equal(handoff.response.question?.category, "product");
  assert.equal(handoff.response.question?.recommendedOption, undefined);
  assert.throws(() =>
    responseHandoff(
      normalizeNativeOutput({ text: null, question: null }, original),
      true,
    ),
  );
  assert.throws(() =>
    responseHandoff(
      normalizeNativeOutput(
        { text: "ok", question: null, extra: null },
        original,
      ),
      true,
    ),
  );
});
