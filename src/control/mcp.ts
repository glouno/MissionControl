import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ControlClient } from "./client.js";
import { usageReconciliationSchema } from "./usage.js";
import { goalSchema, backendSwitchSchema, projectSchema } from "./schema.js";
export async function runMcp(client: ControlClient) {
  const server = new McpServer({ name: "mission-control", version: "1.0.0" });
  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  for (const [name, path] of [
    ["reliability_incidents", "incidents"],
    ["inference_diagnostics", "inference-diagnostics"],
    ["controller_readiness", "readiness"],
  ])
    server.registerTool(
      name,
      {
        description: "Operator: inspect private reliability diagnostics",
        inputSchema: {
          goalId: z.string().optional(),
          attemptId: z.string().optional(),
          after: z.string().optional(),
        },
      },
      async (input) =>
        text(
          await client.request(
            `/${path}?${new URLSearchParams(Object.entries(input).filter(([, v]) => v !== undefined) as [string, string][]).toString()}`,
          ),
        ),
    );
  server.registerTool(
    "recovery_inspect",
    {
      description: "Operator: inspect retained resources and blockers",
      inputSchema: { goalId: z.string() },
    },
    async ({ goalId }) =>
      text(
        await client.request(`/goals/${encodeURIComponent(goalId)}/recovery`),
      ),
  );
  server.registerTool(
    "recovery_resume",
    {
      description: "Operator: record inspection and resume safe work",
      inputSchema: {
        goalId: z.string(),
        revision: z.number().int().positive(),
        explanation: z.string().min(1).max(4096),
      },
    },
    async ({ goalId, ...input }) =>
      text(
        await client.request(
          `/goals/${encodeURIComponent(goalId)}/recovery`,
          "POST",
          input,
        ),
      ),
  );
  server.registerTool(
    "support_bundle_preview",
    {
      description:
        "Operator: preview selected metadata-only failure evidence; private export through CLI",
      inputSchema: { goalId: z.string(), attemptId: z.string() },
    },
    async ({ goalId, attemptId }) =>
      text(
        await client.request(
          `/goals/${encodeURIComponent(goalId)}/support-bundle?attemptId=${encodeURIComponent(attemptId)}`,
        ),
      ),
  );
  server.registerTool(
    "goal_replace",
    {
      description:
        "Operator: create an immutable successor within retained family and installation allowance",
      inputSchema: {
        goalId: z.string(),
        revision: z.number().int().positive(),
        input: goalSchema,
        explanation: z.string().min(1).max(4096),
      },
    },
    async ({ goalId, ...body }) =>
      text(
        await client.request(
          `/goals/${encodeURIComponent(goalId)}/replacement`,
          "POST",
          body,
        ),
      ),
  );

  server.registerTool(
    "connector_health",
    {
      description:
        "Operator: inspect connector observations and delivery backlog; observations do not qualify device trust",
      inputSchema: {},
    },
    async () => text(await client.request("/connectors")),
  );
  server.registerTool(
    "usage_unresolved",
    {
      description: "Operator: inspect unresolved usage reservations",
      inputSchema: {},
    },
    async () => text(await client.request("/usage/unresolved")),
  );
  server.registerTool(
    "usage_reconcile",
    {
      description:
        "Operator: reconcile a closed metered attempt from registered evidence; retains original unknown usage",
      inputSchema: usageReconciliationSchema.extend({ attemptId: z.string() }),
    },
    async ({ attemptId, ...input }) =>
      text(
        await client.request(
          `/attempts/${encodeURIComponent(attemptId)}/usage-reconciliation`,
          "POST",
          input,
        ),
      ),
  );
  server.registerTool(
    "storage_policy",
    {
      description:
        "Inspect or configure progressive hourly storage maintenance with operator authority",
      inputSchema: {
        mode: z.enum(["preview", "workspaces", "branches"]).optional(),
      },
    },
    async ({ mode }) =>
      text(
        await client.request(
          "/storage-policy",
          mode ? "POST" : "GET",
          mode ? { mode } : undefined,
        ),
      ),
  );
  server.registerTool(
    "execution_maintenance",
    {
      description:
        "Inspect or reclaim verified temporary execution source with operator authority; unfinished/imported source stays retained",
      inputSchema: { apply: z.boolean().default(false) },
    },
    async ({ apply }) =>
      text(await client.request("/execution-maintenance", "POST", { apply })),
  );
  server.registerTool(
    "project_list",
    {
      description: "List configured project repositories and readiness",
      inputSchema: {},
    },
    async () => text(await client.request("/projects")),
  );
  server.registerTool(
    "configuration_apply",
    {
      description: "Explicitly apply a validated external configuration hash",
      inputSchema: { hash: z.string().regex(/^[a-f0-9]{64}$/) },
    },
    async ({ hash }) =>
      text(await client.request("/configuration", "POST", { hash })),
  );
  server.registerTool(
    "goal_create",
    {
      description: "Create an autonomous goal within configured authority",
      inputSchema: {
        projectId: z.string(),
        description: z.string().min(1).max(100000),
        idempotencyKey: z.string().min(1).max(200),
      },
    },
    async ({ idempotencyKey, ...input }) =>
      text(await client.request("/goals", "POST", input, idempotencyKey)),
  );
  server.registerTool(
    "goal_list",
    {
      description:
        "List goals visible to this identity with bounded pagination",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(50),
        after: z.string().default(""),
      },
    },
    async ({ limit, after }) =>
      text(
        await client.request(
          `/goals?limit=${limit}&after=${encodeURIComponent(after)}`,
        ),
      ),
  );
  server.registerTool(
    "goal_draft",
    {
      description:
        "Validate a goal against configured project authority without creating work",
      inputSchema: {
        projectId: z.string(),
        description: z.string().min(1).max(100000),
      },
    },
    async (input) => text(await client.request("/goal-drafts", "POST", input)),
  );
  server.registerTool(
    "goal_control",
    {
      description:
        "Pause, resume or cancel an authorized goal at its current revision",
      inputSchema: {
        id: z.string(),
        status: z.enum(["paused", "running", "cancelled"]),
        revision: z.number().int().positive(),
        idempotencyKey: z.string().min(1).max(200),
      },
    },
    async ({ id, idempotencyKey, ...body }) =>
      text(
        await client.request(
          `/goals/${encodeURIComponent(id)}/state`,
          "POST",
          body,
          idempotencyKey,
        ),
      ),
  );
  server.registerTool(
    "goal_tasks",
    {
      description: "Inspect goal dependency tasks",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text(await client.tasks(id)),
  );
  server.registerTool(
    "goal_evidence",
    {
      description: "Inspect recorded checks and review evidence",
      inputSchema: {
        id: z.string(),
        limit: z.number().int().min(1).max(500).default(100),
        after: z.string().default(""),
      },
    },
    async ({ id, limit, after }) =>
      text(
        await client.request(
          `/goals/${encodeURIComponent(id)}/evidence?limit=${limit}&after=${encodeURIComponent(after)}`,
        ),
      ),
  );
  server.registerTool(
    "task_inspect",
    {
      description: "Inspect an authorized task",
      inputSchema: { id: z.string() },
    },
    async ({ id }) =>
      text(await client.request(`/tasks/${encodeURIComponent(id)}`)),
  );
  server.registerTool(
    "question_list",
    { description: "Operator: list pending human decisions", inputSchema: {} },
    async () => text(await client.request("/questions")),
  );
  server.registerTool(
    "schedule_list",
    {
      description: "Operator: inspect explicitly applied schedules",
      inputSchema: {},
    },
    async () => text(await client.request("/schedules")),
  );
  server.registerTool(
    "goal_attempts",
    {
      description: "Inspect admitted attempts, usage and recorded evidence",
      inputSchema: {
        id: z.string(),
        limit: z.number().int().min(1).max(500).default(100),
        after: z.string().default(""),
      },
    },
    async ({ id, limit, after }) =>
      text(
        await client.request(
          `/goals/${encodeURIComponent(id)}/attempts?limit=${limit}&after=${encodeURIComponent(after)}`,
        ),
      ),
  );
  server.registerTool(
    "goal_inspect",
    {
      description: "Inspect durable goal state",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text(await client.goal(id)),
  );
  server.registerTool(
    "goal_switch_backend",
    {
      description:
        "Switch a paused, drained goal backend with operator authority; preserves portable checkpoints",
      inputSchema: backendSwitchSchema.extend({ id: z.string() }),
    },
    async ({ id, backend, revision }) =>
      text(await client.switchBackend(id, backend, revision)),
  );
  server.registerTool(
    "task_claim",
    {
      description:
        "Claim ready work for an existing approved controller dispatch; arbitrary remote workers are unsupported",
      inputSchema: {
        workerId: z.string(),
        goalId: z.string().optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    async ({ workerId, goalId, idempotencyKey }) =>
      text(await client.claim(workerId, goalId, idempotencyKey)),
  );
  for (const operation of [
    "heartbeat",
    "checkpoint",
    "finding",
    "release",
    "result",
    "question",
    "operation",
  ] as const) {
    server.registerTool(
      `task_${operation}`,
      {
        description: `Publish task ${operation} with a valid lease`,
        inputSchema: {
          taskId: z.string(),
          workerId: z.string(),
          generation: z.number().int(),
          payload: z.record(z.string(), z.unknown()),
        },
      },
      async ({ taskId, workerId, generation, payload }) =>
        text(
          await client.request(`/tasks/${taskId}/${operation}`, "POST", {
            ...payload,
            workerId,
            generation,
          }),
        ),
    );
  }
  server.registerTool(
    "owner_operations",
    {
      description:
        "Inspect pending owner operations; reconcile external actions before retrying",
      inputSchema: {},
    },
    async () => text(await client.request("/operations")),
  );
  server.registerTool(
    "owner_operation_respond",
    {
      description:
        "Record trusted owner execution intent or terminal result; does not execute infrastructure automatically",
      inputSchema: {
        id: z.string(),
        status: z.enum(["executing", "completed", "rejected"]),
        explanation: z.string().min(1),
        resultArtifact: z.string().optional(),
      },
    },
    async ({ id, ...response }) =>
      text(await client.request(`/operations/${id}`, "POST", response)),
  );
  server.registerTool(
    "question_answer",
    {
      description: "Answer a human question with operator authority",
      inputSchema: {
        id: z.string(),
        option: z.string(),
        revision: z.number().int(),
      },
    },
    async ({ id, ...body }) =>
      text(await client.request(`/questions/${id}/answer`, "POST", body)),
  );
  server.registerTool(
    "events",
    {
      description: "Read events after a durable cursor",
      inputSchema: {
        after: z.number().int().nonnegative().default(0),
        goalId: z.string().optional(),
      },
    },
    async ({ after, goalId }) =>
      text(
        await client.request(
          `/events?after=${after}${goalId ? `&goalId=${encodeURIComponent(goalId)}` : ""}`,
        ),
      ),
  );
  await server.connect(new StdioServerTransport());
  return server;
}
