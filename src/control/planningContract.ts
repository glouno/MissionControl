import { planSchema, taskSchema, type GoalConfig } from "./schema.js";
import { z } from "zod";

/** Constrain structured output with the same prerequisites used by admission. */
export function plannerOutputSchema(config: GoalConfig) {
  const minimum = planningContract(config).minimumResources;
  const commands = [
    ...new Set([
      ...config.verificationCommands,
      ...config.trustedAdditionalVerificationCommands,
    ]),
  ];
  return z.toJSONSchema(
    planSchema.extend({
      tasks: z
        .array(
          taskSchema.extend({
            description: z.string().min(1).max(4000),
            dependencies: z
              .array(z.string().min(1).max(80))
              .max(100)
              .optional(),
            acceptanceCriteria: z
              .array(z.string().min(1).max(500))
              .min(1)
              .max(12),
            allowedPaths: z.array(z.string().min(1).max(500)).min(1).max(100),
            resources: z.array(z.string().min(1).max(240)).max(20).optional(),
            cpuUnits: z.number().int().min(minimum.cpuUnits).max(16).optional(),
            memoryMiB: z
              .number()
              .int()
              .min(minimum.memoryMiB)
              .max(32768)
              .optional(),
            verificationCommands: commands.length
              ? z.array(z.enum(commands)).max(commands.length).optional()
              : z.array(z.string()).max(0).optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
    { target: "draft-7" },
  );
}

export const planningInstructions =
  "Planning only: identify the smallest useful implementation DAG from the goal and necessary source files. Do not implement changes, run the full baseline/test suite, install dependencies, or investigate unrelated infrastructure. A fully specified single task needs one task. Each description is a concise implementation brief (at most 4000 characters), with at most 12 short acceptance criteria. Do not embed source code, test output, documentation copies, or the final implementation in the plan. Use the structured output schema; return the completed plan once the scope and checks are known.";

/** Trusted project prerequisites, shared by planning and independent verification. */
export function planningContract(config: GoalConfig) {
  return {
    minimumResources: config.executionResources ?? {
      cpuUnits: 2,
      memoryMiB: 2048,
    },
    requiredChecks: config.verificationCommands,
    allowedAdditionalChecks: config.trustedAdditionalVerificationCommands,
    approvedPaths: config.policy.approvedPaths,
    network:
      "Inference gateway only; public documentation and package downloads are unavailable. Use supplied repository documentation; report missing context without trying network setup.",
    verification:
      "Required project checks always run. Task verificationCommands must be empty or exact strings from requiredChecks or allowedAdditionalChecks; never invent shell wrappers or replacement checks.",
    resources:
      "Task CPU and memory must meet minimumResources. Omit resource fields to inherit the qualified project minimum. These are execution prerequisites, not estimates of task complexity.",
  };
}

export function inheritPlanResources(input: unknown, config: GoalConfig) {
  const parsed = planSchema.parse(input);
  const raw = input as { tasks: Record<string, unknown>[] };
  const minimum = planningContract(config).minimumResources;
  return {
    tasks: parsed.tasks.map((task, index) => ({
      ...task,
      cpuUnits:
        raw.tasks[index].cpuUnits === undefined
          ? minimum.cpuUnits
          : task.cpuUnits,
      memoryMiB:
        raw.tasks[index].memoryMiB === undefined
          ? minimum.memoryMiB
          : task.memoryMiB,
    })),
  };
}
