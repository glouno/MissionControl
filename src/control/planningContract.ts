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
            cpuUnits: z.number().int().min(minimum.cpuUnits).max(16).optional(),
            memoryMiB: z
              .number()
              .int()
              .min(minimum.memoryMiB)
              .max(32768)
              .optional(),
            verificationCommands: commands.length
              ? z.array(z.enum(commands)).optional()
              : z.array(z.string()).max(0).optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
    { target: "draft-7" },
  );
}

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
