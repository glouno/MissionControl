import test from "node:test";
import assert from "node:assert/strict";
import { goalSchema } from "./schema.js";
import { plannerOutputSchema, planningContract } from "./planningContract.js";
import {
  nativeOutputSchema,
  normalizeNativeOutput,
} from "./nativeOutputSchema.js";
import { inheritPlanResources } from "./planningContract.js";

test("planner schema carries qualified minima and exact trusted checks without granting network access", () => {
  const config = goalSchema.parse({
    title: "Fixture",
    description: "Fixture",
    repoPath: "/fixture",
    executionResources: { cpuUnits: 2, memoryMiB: 8192 },
    verificationCommands: ["mc-check"],
    trustedAdditionalVerificationCommands: ["git diff --check"],
  });
  const output = plannerOutputSchema(config) as any;
  const properties = output.properties.tasks.items.properties;
  assert.equal(properties.cpuUnits.minimum, 2);
  assert.equal(properties.memoryMiB.minimum, 8192);
  assert.deepEqual(properties.verificationCommands.items.enum, [
    "mc-check",
    "git diff --check",
  ]);
  assert.match(planningContract(config).network, /unavailable/);
  const native = nativeOutputSchema(output);
  assert.ok(native.properties.tasks.items.required.includes("cpuUnits"));
  const plan = normalizeNativeOutput(
    {
      tasks: [
        {
          key: "one",
          title: "One",
          description: "Implement one thing",
          acceptanceCriteria: ["Works"],
          allowedPaths: ["src/**"],
          cpuUnits: null,
          memoryMiB: null,
          verificationCommands: null,
        },
      ],
    },
    output,
  );
  const inherited = inheritPlanResources(plan, config);
  assert.equal(inherited.tasks[0].cpuUnits, 2);
  assert.equal(inherited.tasks[0].memoryMiB, 8192);
  assert.deepEqual(inherited.tasks[0].verificationCommands, []);
});
