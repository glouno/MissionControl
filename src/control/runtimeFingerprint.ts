import { createHash } from "node:crypto";
import { authPolicyHash, type AuthEnvironment } from "./authEnvironment.js";
import type { IsolatedRuntimeConfig } from "./isolatedRuntime.js";
import { ControlError, type GoalInput } from "./schema.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
/** Bind only the selected execution identity. Admission budgets remain immutable goal data. */
export function executionRuntimeHash(
  goal: Pick<
    GoalInput,
    | "projectId"
    | "backend"
    | "executionContract"
    | "admission"
    | "containerImage"
  >,
  runtime: IsolatedRuntimeConfig | undefined,
  environments: AuthEnvironment[],
) {
  const contract = goal.executionContract;
  const authentication = contract?.authentication;
  const auth =
    authentication?.kind === "session"
      ? environments.find((a) => a.id === authentication.reference)
      : undefined;
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          version: 2,
          projectId: goal.projectId,
          providerId: goal.admission?.providerId,
          executionMode: goal.admission?.executionMode,
          backend: goal.backend,
          verificationImage: goal.containerImage,
          contract: contract && {
            harness: contract.harness,
            provider: contract.provider,
            authentication: contract.authentication,
            execution: contract.execution,
          },
          project: goal.projectId
            ? runtime?.projects[goal.projectId]
            : undefined,
          provider: goal.admission?.providerId
            ? runtime?.providers[goal.admission.providerId]
            : undefined,
          authenticationPolicyHash: auth && authPolicyHash(auth),
        }),
      ),
    )
    .digest("hex");
}
export function assertRuntimeBinding(
  goal: GoalInput,
  runtime: IsolatedRuntimeConfig,
  environments: AuthEnvironment[],
  expected?: string,
) {
  if (
    goal.admission?.runtimeHashVersion !== 2 ||
    goal.admission.runtimeHash !==
      executionRuntimeHash(goal, runtime, environments) ||
    (expected !== undefined && goal.admission.runtimeHash !== expected)
  )
    throw new ControlError(
      "runtime_revision",
      "Admitted execution runtime changed or uses a legacy binding; retain this goal and submit a new goal with reviewed configuration",
      409,
    );
}
