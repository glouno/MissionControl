import { executionContractSchema } from "./executionContract.js";
import { usageSchema } from "./usage.js";
import { z } from "zod";

export const backendSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("fake"), model: z.string().default("fake") })
    .strict(),
  z
    .object({
      kind: z.literal("codex"),
      model: z.string().optional(),
      command: z.literal("codex").default("codex"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("claude-code"),
      model: z.string().optional(),
      command: z.literal("claude").default("claude"),
      maxTurns: z.number().int().min(1).max(100).default(40),
      foundry: z
        .object({
          resource: z.string().regex(/^[a-zA-Z0-9-]+$/),
          credential: z.enum(["identity", "key"]).default("identity"),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("azure"),
      model: z.string().min(1),
      endpoint: z.string().url(),
      reasoningEffort: z.enum(["low", "medium", "high"]).default("medium"),
      maxOutputTokens: z.number().int().min(64).max(8192).default(8192),
      credential: z.enum(["identity", "key"]).default("identity"),
      inputUsdPerMillion: z.number().positive(),
      outputUsdPerMillion: z.number().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bedrock"),
      model: z.string().min(1),
      region: z.string().min(1),
      inputUsdPerMillion: z.number().positive(),
      outputUsdPerMillion: z.number().positive(),
    })
    .strict(),
]);
export const backendSwitchSchema = z
  .object({
    revision: z.number().int().positive(),
    backend: backendSchema,
  })
  .strict();
export const policySchema = z
  .object({
    targetBranch: z.string().min(1).default("development"),
    publish: z.boolean().default(false),
    autoMerge: z.boolean().default(false),
    productionDeploymentExcluded: z.boolean().default(false),
    approvedPaths: z.array(z.string()).default([]),
    protectedPaths: z
      .array(z.string())
      .default([
        "**/auth/**",
        "**/billing/**",
        "**/migrations/**",
        ".github/workflows/**",
      ]),
    requiredChecks: z.array(z.string()).default([]),
  })
  .strict();
export const goalSchema = z
  .object({
    title: z.string().min(1).max(240),
    description: z.string().min(1).max(100000),
    repoPath: z.string().min(1),
    projectId: z.string().optional(),
    publicationSummary: z
      .object({
        title: z.string().min(1).max(240),
        body: z.string().min(1).max(12000),
      })
      .strict()
      .optional(),
    admission: z
      .object({
        configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
        executionMode: z.enum(["fake", "isolated"]),
        providerId: z.string().optional(),
        executionImageDigest: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .optional(),
        authenticationPolicyHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        runtimeHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        contexts: z
          .array(
            z
              .object({
                path: z.string(),
                hash: z.string().regex(/^[a-f0-9]{64}$/),
                content: z.string().max(64000),
              })
              .strict(),
          )
          .max(20)
          .default([]),
        prompts: z
          .array(
            z
              .object({
                id: z.string(),
                hash: z.string().regex(/^[a-f0-9]{64}$/),
                content: z.string().max(64000),
              })
              .strict(),
          )
          .max(20),
      })
      .strict()
      .optional(),
    instructionFiles: z
      .array(z.string().min(1))
      .max(20)
      .default(["AGENTS.md", "README.md"]),
    siblingContracts: z
      .array(
        z
          .object({
            repositoryPath: z.string().min(1),
            revision: z.string().regex(/^[a-f0-9]{40,64}$/),
            files: z.array(z.string().min(1)).min(1).max(20),
          })
          .strict(),
      )
      .max(10)
      .default([]),
    repository: z
      .discriminatedUnion("mode", [
        z
          .object({ mode: z.literal("local"), branch: z.string().min(1) })
          .strict(),
        z
          .object({
            mode: z.literal("remote"),
            remoteUrl: z.string().min(1),
            primaryBranch: z.string().min(1),
            auditedPrimarySha: z.string().regex(/^[a-f0-9]{40,64}$/),
            verificationEnvironment: z.string().min(1),
          })
          .strict(),
      ])
      .optional(),
    executionContract: executionContractSchema.optional(),
    backend: backendSchema.prefault({ kind: "fake" }),
    verificationCommands: z.array(z.string().min(1)).default([]),
    maxCostUsd: z.number().nonnegative().default(0),
    estimatePerRunUsd: z.number().nonnegative().default(0),
    containerNetwork: z.enum(["none", "bridge"]).default("none"),
    containerImage: z
      .string()
      .regex(/^[\w./:@-]+$/)
      .optional(),
    maxWorkers: z.number().int().min(1).max(4).default(2),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    timeoutMs: z.number().int().min(1000).max(3600000).default(3600000),
    maxReplans: z.number().int().min(0).max(10).default(3),
    policy: policySchema.prefault({}),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export const scheduleSchema = z.object({
  config: goalSchema,
  intervalMs: z.number().int().min(60000),
  timezone: z.string().min(1).default("UTC"),
});
export const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
  name: z.string().min(1).max(100),
  family: z.string().min(1).max(100),
  enabled: z.boolean().default(false),
  config: goalSchema,
});
export const taskSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  title: z.string().min(1).max(240),
  description: z.string().min(1),
  dependencies: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  allowedPaths: z.array(z.string()).min(1),
  verificationCommands: z.array(z.string()).default([]),
  capability: z
    .enum([
      "developer",
      "researcher",
      "reviewer",
      "security",
      "performance",
      "ui",
    ])
    .default("developer"),
  priority: z.number().int().default(0),
  resources: z.array(z.string()).default([]),
  cpuUnits: z.number().int().min(1).max(16).default(2),
  memoryMiB: z.number().int().min(128).max(32768).default(2048),
});
export const planSchema = z.object({
  tasks: z.array(taskSchema).min(1).max(100),
});
export const reviewSchema = z.object({
  commit: z.string().min(1),
  verdict: z.enum(["pass", "fail"]),
  findings: z.array(
    z.object({
      summary: z.string(),
      blocking: z.boolean(),
      evidence: z.string(),
    }),
  ),
});
export const questionSchema = z.object({
  question: z.string().min(1),
  reason: z.string().min(1),
  options: z
    .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
    .min(2),
  recoveryAttemptId: z.string().optional(),
  recommendedOption: z.string().optional(),
  commit: z.string().optional(),
  requestedMaxCostUsd: z.number().positive().optional(),
  requestedRunEstimateUsd: z.number().positive().optional(),
  category: z
    .enum(["product", "auth", "billing", "migration", "policy", "spending"])
    .default("product"),
});
export const checkpointSchema = z.object({
  commit: z.string().optional(),
  summary: z.string(),
  messages: z.array(z.unknown()).optional(),
  pendingTool: z
    .object({
      id: z.string(),
      name: z.string(),
      arguments: z.record(z.string(), z.unknown()),
    })
    .optional(),
  costUsd: z.number().nonnegative().optional(),
  usage: usageSchema.optional(),
});
export type GoalInput = z.input<typeof goalSchema>;
export type GoalConfig = z.output<typeof goalSchema>;
export type BackendConfig = z.output<typeof backendSchema>;
export type TaskSpec = z.output<typeof taskSchema>;
export type QuestionInput = z.input<typeof questionSchema>;
export const ownerOperationSchema = z
  .object({
    action: z.string().trim().min(1).max(1000),
    scope: z.string().trim().min(1).max(4000),
    reason: z.string().trim().min(1).max(8000),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();
export type OwnerOperationInput = z.output<typeof ownerOperationSchema>;
export type Review = z.output<typeof reviewSchema>;
export type TaskState =
  | "pending"
  | "ready"
  | "claimed"
  | "running"
  | "verifying"
  | "integrating"
  | "accepted"
  | "waiting_human"
  | "waiting_provider"
  | "retry_wait"
  | "blocked"
  | "failed"
  | "cancelled"
  | "superseded";
export interface Goal {
  id: string;
  status:
    | "planning"
    | "running"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled"
    | "publishing";
  revision: number;
  planRevision: number;
  createdAt: string;
  config: GoalConfig;
  result?: unknown;
}
export interface Task {
  id: string;
  goalId: string;
  key: string;
  status: TaskState;
  generation: number;
  attempts: number;
  revision: number;
  workerId: string | null;
  leaseUntil: number | null;
  retryAt: number | null;
  createdAt: string;
  spec: TaskSpec;
  checkpoint?: z.output<typeof checkpointSchema>;
  result?: unknown;
}
export interface Claim {
  workspace?: { path: string; branch: string; baseCommit: string };
  task: Task;
  goal: Goal;
  generation: number;
  workerId: string;
}
export class ControlError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function validatePlan(input: unknown): TaskSpec[] {
  const { tasks } = planSchema.parse(input);
  const keys = new Set(tasks.map((t) => t.key));
  if (keys.size !== tasks.length)
    throw new ControlError("invalid_plan", "Duplicate task keys");
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key))
      throw new ControlError("invalid_plan", "Dependency cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const d of byKey.get(key)!.dependencies) {
      if (!keys.has(d))
        throw new ControlError("invalid_plan", `Missing dependency: ${d}`);
      visit(d);
    }
    visiting.delete(key);
    visited.add(key);
  }
  tasks.forEach((t) => visit(t.key));
  return tasks;
}

export const limitsSchema = z.object({
  workers: z.number().int().min(1).max(4),
  cpu: z.number().int().positive(),
  memoryMiB: z.number().int().positive(),
  providerWorkers: z.number().int().min(1).max(4),
  repositoryWorkers: z.number().int().min(1).max(4),
});
