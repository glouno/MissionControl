import test from "node:test";
import assert from "node:assert/strict";
import { HumanWait, OwnerWait } from "./backend.js";
import { parseHandoff, responseHandoff } from "./workerHandoff.js";
const operation = {
  action: "Provision test service",
  scope: "development",
  reason: "Integration fixture needs an endpoint",
  idempotencyKey: "service-1",
};
test("worker handoffs validate bounded requests and exclude controller authority", () => {
  assert.ok(
    parseHandoff("missioncontrol_owner_operation", operation) instanceof
      OwnerWait,
  );
  for (const invalid of [
    { ...operation, scope: " " },
    { ...operation, taskId: "other-task" },
    { ...operation, token: "operator" },
    { ...operation, reason: "x".repeat(8001) },
  ])
    assert.throws(() =>
      parseHandoff("missioncontrol_owner_operation", invalid),
    );
  assert.throws(() => parseHandoff("owner_execute", operation));
  assert.throws(() =>
    responseHandoff(
      { text: "wait", question: null, ownerOperation: operation },
      false,
    ),
  );
  const question = {
    question: "Which endpoint?",
    reason: "Configuration",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  };
  assert.ok(
    responseHandoff({ text: "wait", question }, true).wait instanceof HumanWait,
  );
  assert.throws(() =>
    responseHandoff(
      { text: "wait", question, ownerOperation: operation },
      true,
    ),
  );
});
