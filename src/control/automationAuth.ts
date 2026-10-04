import { z } from "zod";
import { ControlStore, type Principal } from "./store.js";
import { ControlError } from "./schema.js";
import { sql } from "../sqlite.js";

export const automationPolicySchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    projectIds: z.array(z.string().min(1).max(120)).min(1).max(100),
    permissions: z
      .array(z.enum(["goals:read", "goals:create", "goals:control"]))
      .min(1)
      .max(3),
    expiresInHours: z.number().int().min(1).max(8760).default(24),
  })
  .strict();
export type AutomationPolicy = z.output<typeof automationPolicySchema> & {
  expiresAt: number;
  revoked: boolean;
};

export function provisionAutomation(store: ControlStore, input: unknown) {
  const parsed = automationPolicySchema.parse(input);
  for (const projectId of parsed.projectIds)
    if (!store.projects().some((p) => p.id === projectId && p.enabled))
      throw new ControlError(
        "project",
        "Select an enabled configured project",
        409,
      );
  return store.db.transaction(() => {
    // Rotation invalidates every prior token for this identity, including streams.
    store.db.exec(
      `DELETE FROM control_tokens WHERE role='automation' AND actor=${sql(parsed.id)}`,
    );
    const policy: AutomationPolicy = {
      ...parsed,
      expiresAt: Date.parse(store.now()) + parsed.expiresInHours * 3600000,
      revoked: false,
    };
    store.setting(`automation:${parsed.id}`, policy);
    const token = store.createToken(parsed.id, "automation");
    store.event("AUTOMATION_PROVISIONED", "operator", {
      id: parsed.id,
      projectIds: parsed.projectIds,
      permissions: parsed.permissions,
      expiresAt: policy.expiresAt,
    });
    return { token, policy };
  });
}
export function revokeAutomation(store: ControlStore, id: string) {
  return store.db.transaction(() => {
    const policy = store.setting(`automation:${id}`) as
      AutomationPolicy | undefined;
    if (!policy)
      throw new ControlError("not_found", "Automation identity not found", 404);
    store.db.exec(
      `DELETE FROM control_tokens WHERE role='automation' AND actor=${sql(id)}`,
    );
    store.setting(`automation:${id}`, { ...policy, revoked: true });
    store.event("AUTOMATION_REVOKED", "operator", { id });
    return { id, revoked: true };
  });
}
export function automationPolicies(store: ControlStore) {
  return store.db
    .query<{ value: string }>(
      "SELECT value FROM control_settings WHERE key LIKE 'automation:%'",
    )
    .map((r) => JSON.parse(r.value) as AutomationPolicy);
}
export function automationPolicy(store: ControlStore, principal: Principal) {
  const policy = store.setting(`automation:${principal.actor}`) as
    AutomationPolicy | undefined;
  if (
    principal.role !== "automation" ||
    !policy ||
    policy.revoked ||
    policy.expiresAt <= Date.parse(store.now())
  )
    throw new ControlError(
      "unauthorized",
      "Automation identity has expired or been revoked",
      401,
    );
  return policy;
}
export function authorizeAutomation(
  store: ControlStore,
  principal: Principal,
  path: string,
  method: string,
  body: unknown,
  goalId?: string,
) {
  const policy = automationPolicy(store, principal);
  const backlog = /^\/backlog(?:\/[^/]+(?:\/(?:archive|launch))?)?$/.test(path);
  const read =
    method === "GET" &&
    (/^\/goals(?:\/[^/]+(?:\/(?:tasks|attempts|artifacts|findings|evidence))?)?$/.test(
      path,
    ) ||
      backlog ||
      path === "/projects" ||
      path === "/events" ||
      /^\/tasks\/[^/]+$/.test(path) ||
      /^\/artifacts\/[^/]+\/content$/.test(path));
  const create =
    method === "POST" &&
    (path === "/goals" || path === "/goal-drafts" || backlog);
  const control = method === "POST" && /^\/goals\/[^/]+\/state$/.test(path);
  const permission = read
    ? "goals:read"
    : create
      ? "goals:create"
      : control
        ? "goals:control"
        : undefined;
  if (!permission || !policy.permissions.includes(permission))
    throw new ControlError(
      "forbidden",
      "Automation identity does not grant this operation",
      403,
    );
  let projectId: string | undefined;
  if (create && backlog)
    projectId = z
      .object({ projectId: z.string().min(1) })
      .parse(body).projectId;
  else if (create)
    projectId = z
      .object({
        projectId: z.string().min(1),
        description: z.string().min(1).max(100000),
      })
      .strict()
      .parse(body).projectId;
  else if (goalId) projectId = store.getGoal(goalId).config.projectId;
  if (
    (goalId || create) &&
    (!projectId || !policy.projectIds.includes(projectId))
  )
    throw new ControlError(
      "forbidden",
      "Project is outside automation scope",
      403,
    );
  return policy;
}
