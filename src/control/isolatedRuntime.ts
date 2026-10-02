import { reconcileRuntime } from "./runtimeRecovery.js";
import { join } from "node:path";
import { once } from "node:events";
import { AzureCliCredential } from "@azure/identity";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import {
  AzureProvider,
  BedrockProvider,
  type ModelProvider,
} from "./providers.js";
import { backendSchema } from "./schema.js";
import { secretReferenceSchema, readSecret } from "../credentials.js";
import { z } from "zod";
import { sql } from "../sqlite.js";
import { ControlStore } from "./store.js";
import { ControlError, type Goal, type Claim } from "./schema.js";
import type { RunContext } from "./backend.js";
import {
  EnvironmentRegistry,
  DockerEnvironment,
  type ExecutionSession,
} from "./environments.js";
import {
  InferenceGateway,
  type InferenceCapability,
} from "./inferenceGateway.js";
import { GatewayNetworkManager } from "./gatewayNetwork.js";
import { IsolatedBackend } from "./isolatedBackend.js";
import { IsolatedVerifier } from "./isolatedVerifier.js";
import { ExecutionMaintenance } from "./executionMaintenance.js";
import { EnvironmentImageBuilder } from "./environmentBuild.js";
import { StdioGateway } from "./stdioGateway.js";
import { validateBackendContract } from "./executionContract.js";
import { AuthRuntime } from "./authRuntime.js";
import { authPolicyHash, type AuthEnvironment } from "./authEnvironment.js";
import { SubscriptionBackend } from "./subscriptionBackend.js";
import { ImageMaintenance } from "./imageMaintenance.js";
export const isolatedRuntimeSchema = z
  .object({
    environmentImagesRoot: z.string().startsWith("/").optional(),
    // Shared images require a complete operator-declared inventory of every
    // retained sandbox registry before destructive maintenance can be enabled.
    environmentExecutionRoots: z.array(z.string().startsWith("/")).optional(),
    projects: z.record(
      z.string(),
      z
        .object({ imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
        .strict(),
    ),
    providers: z.record(
      z.string(),
      z.discriminatedUnion("protocol", [
        z
          .object({
            protocol: z.literal("subscription"),
            harness: z.enum(["codex", "claude-code"]),
            model: z.string().min(1),
            authentication: z
              .object({
                kind: z.literal("session"),
                reference: z.string().min(1),
              })
              .strict(),
          })
          .strict(),
        z
          .object({
            protocol: z.enum(["responses", "messages"]),
            endpoint: z.string().url(),
            model: z.string().min(1),
            authentication: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("azure-cli") }).strict(),
              z
                .object({
                  kind: z.literal("secret"),
                  reference: secretReferenceSchema,
                  header: z.enum(["api-key", "x-api-key", "Authorization"]),
                  bearer: z.boolean().default(false),
                })
                .strict(),
            ]),
            allowedBetaHeaders: z.array(z.string()).default([]),
          })
          .strict(),
        z
          .object({
            protocol: z.literal("tool-loop"),
            backend: backendSchema.refine(
              (b) => b.kind === "azure" || b.kind === "bedrock",
              "Tool loop requires Azure or Bedrock",
            ),
            authentication: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("azure-cli") }).strict(),
              z
                .object({
                  kind: z.literal("secret"),
                  reference: secretReferenceSchema,
                })
                .strict(),
              z
                .object({
                  kind: z.literal("aws-session"),
                  accessKey: secretReferenceSchema,
                  secretKey: secretReferenceSchema,
                  sessionToken: secretReferenceSchema,
                })
                .strict(),
            ]),
          })
          .strict(),
      ]),
    ),
  })
  .strict();
export type IsolatedRuntimeConfig = z.output<typeof isolatedRuntimeSchema>;
/** Resolve only the exact admitted identity/image/policy. No login or execution. */
export function subscriptionBinding(
  goal: Goal,
  config: IsolatedRuntimeConfig,
  environments: AuthEnvironment[],
  runtimeHash?: string,
) {
  const admitted = goal.config.admission,
    contract = goal.config.executionContract;
  if (runtimeHash && admitted?.runtimeHash !== runtimeHash)
    throw new ControlError(
      "runtime_revision",
      "Admitted runtime configuration changed",
      409,
    );
  const definition = admitted?.providerId
    ? config.providers[admitted.providerId]
    : undefined;
  if (
    !contract ||
    contract.usagePolicy.kind !== "subscription" ||
    contract.authentication.kind !== "session" ||
    definition?.protocol !== "subscription" ||
    definition.harness !== contract.harness ||
    definition.model !== goal.config.backend.model ||
    definition.authentication.reference !== contract.authentication.reference
  )
    throw new ControlError(
      "execution_contract",
      "Subscription runtime differs from admitted harness/model/authentication",
      409,
    );
  validateBackendContract(goal.config.backend, contract);
  const auth = environments.find(
    (a) => a.id === definition.authentication.reference,
  );
  const image = goal.config.projectId
    ? config.projects[goal.config.projectId]?.imageDigest
    : undefined;
  if (
    !auth ||
    auth.harness !== definition.harness ||
    image !== auth.imageDigest ||
    admitted?.executionImageDigest !== image ||
    admitted?.authenticationPolicyHash !== authPolicyHash(auth)
  )
    throw new ControlError(
      "auth_policy_revision",
      "Subscription image or authentication policy differs from admitted configuration",
      409,
    );
  return { auth, image: auth.imageDigest, definition };
}
export function assertSessionAuthority(
  store: ControlStore,
  session: ExecutionSession,
  cap?: InferenceCapability,
) {
  const spec = session.spec;
  if (!spec.goalId || !spec.workerId || spec.authorityGeneration === undefined)
    throw new ControlError(
      "session_authority",
      "Execution has no recorded controller authority",
      409,
    );
  if (
    cap &&
    (cap.goalId !== spec.goalId ||
      cap.taskId !== session.taskId ||
      cap.generation !== session.generation ||
      cap.sessionId !== session.id)
  )
    throw new ControlError(
      "stale_lease",
      "Inference capability differs from session authority",
      409,
    );
  const goal = store.getGoal(spec.goalId);
  if (["paused", "cancelled", "completed", "failed"].includes(goal.status))
    throw new ControlError(
      "stale_lease",
      "Goal no longer authorizes execution",
      409,
    );
  if (spec.authorityGeneration === 0) {
    if (
      !spec.operationReservationId ||
      !store.db.one(
        `SELECT id FROM control_attempts WHERE id=${sql(spec.operationReservationId)} AND goal_id=${sql(goal.id)} AND task_id IS NULL AND outcome='active'`,
      )
    )
      throw new ControlError(
        "stale_lease",
        "Goal review reservation is no longer active",
        409,
      );
  } else
    store.assertLease(session.taskId, spec.workerId, spec.authorityGeneration);
}
export async function createIsolatedRuntime(
  store: ControlStore,
  root: string,
  input: IsolatedRuntimeConfig,
  relayScript: string,
  secretsDir?: string,
  runtimeHash?: string,
  authEnvironments: AuthEnvironment[] = [],
) {
  store.fenceStartup();
  const config = isolatedRuntimeSchema.parse(input),
    registry = new EnvironmentRegistry(join(root, "sandbox"), store.db),
    environment = new DockerEnvironment(registry),
    db = store.db;
  const portableProviders: Record<string, ModelProvider> = {};
  const upstreams: Record<
    string,
    import("./inferenceGateway.js").TrustedUpstream
  > = {};
  for (const [name, p] of Object.entries(config.providers)) {
    if (p.protocol === "subscription") {
      const auth = authEnvironments.find(
        (a) => a.id === p.authentication.reference,
      );
      if (!secretsDir || !auth || auth.harness !== p.harness)
        throw Error(
          "Subscription runtime requires its explicit dedicated authentication environment and secrets root",
        );
      continue;
    }
    if (p.protocol === "tool-loop") {
      const b = p.backend;
      if (b.kind === "azure") {
        let headers: () => Promise<Record<string, string>>;
        if (p.authentication.kind === "azure-cli") {
          if (b.credential !== "identity")
            throw new Error(
              "Azure tool-loop authentication differs from admitted provider",
            );
          const credential = new AzureCliCredential();
          headers = async () => ({
            Authorization: `Bearer ${(await credential.getToken("https://cognitiveservices.azure.com/.default")).token}`,
          });
        } else if (p.authentication.kind === "secret") {
          if (!secretsDir || b.credential !== "key")
            throw new Error(
              "Azure tool loop requires explicit private key reference",
            );
          const secret = await readSecret(
            p.authentication.reference,
            secretsDir,
          );
          store.redactor.register(secret);
          headers = async () => ({ "api-key": secret });
        } else throw new Error("Azure provider cannot use AWS authentication");
        const url = new URL(b.endpoint);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error(
            "Azure requires fixed credential-free HTTPS endpoint",
          );
        portableProviders[name] = new AzureProvider(b, fetch, headers);
      } else if (b.kind === "bedrock") {
        if (!secretsDir || p.authentication.kind !== "aws-session")
          throw new Error(
            "Bedrock requires dedicated explicit AWS session references",
          );
        if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(b.region))
          throw new Error("Invalid Bedrock region");
        const auth = p.authentication,
          accessKeyId = await readSecret(auth.accessKey, secretsDir),
          secretAccessKey = await readSecret(auth.secretKey, secretsDir),
          sessionToken = await readSecret(auth.sessionToken, secretsDir);
        for (const value of [accessKeyId, secretAccessKey, sessionToken])
          store.redactor.register(value);
        portableProviders[name] = new BedrockProvider(
          b,
          new BedrockRuntimeClient({
            region: b.region,
            credentials: { accessKeyId, secretAccessKey, sessionToken },
            maxAttempts: 1,
          }),
        );
      } else throw new Error("Unsupported metered tool-loop provider");
      continue;
    }

    let headers: () => Promise<Record<string, string>>;
    if (p.authentication.kind === "azure-cli") {
      const credential = new AzureCliCredential();
      headers = async () => ({
        Authorization: `Bearer ${(await credential.getToken("https://cognitiveservices.azure.com/.default")).token}`,
      });
    } else {
      if (!secretsDir)
        throw new Error(
          "Configured provider credential requires explicit secrets directory",
        );
      const auth = p.authentication,
        secret = await readSecret(auth.reference, secretsDir);
      store.redactor.register(secret);
      headers = async () => ({
        [auth.header]: (auth.bearer ? "Bearer " : "") + secret,
      });
    }
    upstreams[name] = {
      protocol: p.protocol,
      endpoint: p.endpoint,
      allowedBetaHeaders: p.allowedBetaHeaders,
      headers,
    };
  }
  const gateway = new InferenceGateway(db, upstreams, (cap) => {
    const provider = config.providers[cap.provider];
    if (
      !provider ||
      provider.protocol === "tool-loop" ||
      provider.protocol === "subscription" ||
      provider.model !== cap.model
    )
      throw new ControlError(
        "model_scope",
        "Runtime model is not authorized",
        403,
      );
    assertSessionAuthority(store, registry.get(cap.sessionId), cap);
  });
  const server = gateway.server();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const bridge = new StdioGateway(
      gateway,
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    const networks = new GatewayNetworkManager(
      db,
      (id) => gateway.revoke(id),
      undefined,
      bridge,
    );
    const maintenance = new ExecutionMaintenance(
      registry,
      environment,
      async (session) => {
        if (!session.spec.goalId) return true; // Legacy source needs explicit reconciliation.
        const activeTask = store
          .tasks(session.spec.goalId)
          .some((t) => t.workerId !== null);
        const activeReview = Boolean(
          store.db.one(
            `SELECT id FROM control_budgets WHERE goal_id=${sql(session.spec.goalId)} AND status IN ('reserved','unresolved') UNION ALL SELECT id FROM control_attempts WHERE goal_id=${sql(session.spec.goalId)} AND outcome IN ('active','recovering')`,
          ),
        );
        return activeTask || activeReview;
      },
    );
    const imageBuilder = config.environmentImagesRoot
      ? new EnvironmentImageBuilder(
          config.environmentImagesRoot,
          undefined,
          undefined,
          store.db,
        )
      : undefined;
    const imageMaintenance = imageBuilder
      ? new ImageMaintenance(imageBuilder, async () => {
          const pins = new Set(
            Object.values(config.projects).map((p) => p.imageDigest),
          );
          for (const session of registry
            .all()
            .filter((s) => s.status !== "destroyed")) {
            const digest = session.imageDigest ?? session.image;
            if (!/^sha256:[a-f0-9]{64}$/.test(digest))
              throw new ControlError(
                "cache_pin",
                "Retained execution has unresolved image",
                409,
              );
            pins.add(digest);
          }
          for (const executionRoot of config.environmentExecutionRoots ?? []) {
            // Refuse treating a missing registry as an empty set of pins.
            const { access } = await import("node:fs/promises");
            await access(join(executionRoot, "execution-registry.db"));
            const retained = new EnvironmentRegistry(executionRoot);
            try {
              for (const session of retained
                .all()
                .filter((s) => s.status !== "destroyed")) {
                const digest = session.imageDigest ?? session.image;
                if (!/^sha256:[a-f0-9]{64}$/.test(digest))
                  throw new ControlError(
                    "cache_pin",
                    "Retained execution has unresolved image",
                    409,
                  );
                pins.add(digest);
              }
            } finally {
              retained.db.close();
            }
          }
          return pins;
        })
      : undefined;
    try {
      await reconcileRuntime(store, registry, environment, networks, (id) =>
        gateway.revoke(id),
      );
      await maintenance.reconcile();
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
    const socketDirectory = join(root, "inference-relay");
    const image = (goal: Goal) => {
      const project =
        goal.config.projectId && config.projects[goal.config.projectId];
      if (!project)
        throw new ControlError(
          "environment_onboarding",
          "Project has no approved runtime image",
          409,
        );
      return project.imageDigest;
    };
    const backend = (goal: Goal) => {
      if (runtimeHash && goal.config.admission?.runtimeHash !== runtimeHash)
        throw new ControlError(
          "runtime_revision",
          "Admitted runtime configuration changed; retain this goal and submit a new goal with reviewed configuration",
          409,
        );
      if (goal.config.executionContract?.usagePolicy.kind === "subscription") {
        const binding = subscriptionBinding(
          goal,
          config,
          authEnvironments,
          runtimeHash,
        );
        // Config cannot claim qualification. Live receipts and a reviewed release gate are still required.
        if (!binding.auth.qualified)
          throw new ControlError(
            "subscription_unqualified",
            "Subscription live qualification is incomplete; coding admission remains disabled",
            409,
          );
        return new SubscriptionBackend(
          new AuthRuntime(store, root, secretsDir!, binding.auth),
          environment,
          registry,
          (context) => {
            assertSessionAuthority(store, {
              id: "context",
              taskId: context.claim.task.id,
              generation: Math.max(1, context.claim.generation),
              spec: {
                goalId: context.claim.goal.id,
                workerId: context.claim.workerId,
                authorityGeneration: context.claim.generation,
                operationReservationId: context.operationReservationId,
              },
            } as ExecutionSession);
          },
        );
      }
      const kind = goal.config.backend.kind,
        portable = kind === "azure" || kind === "bedrock";
      const protocol = portable
        ? "tool-loop"
        : kind === "codex"
          ? "responses"
          : kind === "claude-code"
            ? "messages"
            : null;
      const admitted = goal.config.admission?.providerId,
        definition = admitted ? config.providers[admitted] : undefined;
      const provider =
        admitted &&
        definition?.protocol === protocol &&
        (definition.protocol === "tool-loop"
          ? JSON.stringify(definition.backend) ===
            JSON.stringify(goal.config.backend)
          : definition.model === goal.config.backend.model)
          ? admitted
          : undefined;
      if (!provider)
        throw new ControlError(
          "model_scope",
          "No authorized runtime provider/model for this harness",
          409,
        );
      if (goal.config.executionContract) {
        const c = goal.config.executionContract;
        if (
          c.authentication.kind !== "controller" ||
          c.authentication.reference !== provider ||
          c.usagePolicy.kind !== "metered"
        )
          throw new ControlError(
            "execution_contract",
            "Runtime authentication differs from admitted provider contract",
            409,
          );
        if (!portable && c.provider !== "azure")
          throw new ControlError(
            "execution_contract",
            "Native gateway mode currently qualifies only Azure; other modes require dedicated runtime integration",
            409,
          );
      }
      return new IsolatedBackend(environment, registry, networks, gateway, {
        imageDigest: image(goal),
        provider,
        ...(portable ? { portableProvider: portableProviders[provider] } : {}),
        socketDirectory,
        relayScript,
        assertLease: () => {}, // Context authority supplies owner identity and operation reservation.
        assertContext: (context: RunContext) => {
          const generation = Math.max(1, context.claim.generation);
          assertSessionAuthority(store, {
            id: "context",
            taskId: context.claim.task.id,
            generation,
            spec: {
              goalId: context.claim.goal.id,
              workerId: context.claim.workerId,
              authorityGeneration: context.claim.generation,
              operationReservationId: context.operationReservationId,
            },
          } as ExecutionSession);
        },
      });
    };
    return {
      registry,
      gateway,
      networks,
      environment,
      backend,
      verify: (claim: Claim, path: string) => {
        // A separate container receives source only, never the authentication store.
        const digest =
          claim.goal.config.executionContract?.usagePolicy.kind ===
          "subscription"
            ? subscriptionBinding(
                claim.goal,
                config,
                authEnvironments,
                runtimeHash,
              ).image
            : image(claim.goal);
        return new IsolatedVerifier(environment, digest).verify(claim, path);
      },
      maintenance: (apply = false) => maintenance.maintain(apply),
      imageMaintenance: imageMaintenance
        ? (apply = false) =>
            imageMaintenance.maintain(
              apply && Boolean(config.environmentExecutionRoots?.length),
            )
        : undefined,
      close: async () => {
        try {
          for (const record of networks.records())
            gateway.revoke(record.sessionId);
          for (const session of registry.all())
            if (!["destroyed", "destroying"].includes(session.status))
              await environment.reset(session.id);
          await networks.reconcile();
        } finally {
          await new Promise<void>((r) => server.close(() => r()));
        }
      },
    };
  } catch (error) {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}
