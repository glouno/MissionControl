import { assertSubscriptionQualification } from "./control/subscriptionQualification.js";
import { readFile, realpath, lstat, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, join, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  executionContractSchema,
  validateBackendContract,
  validateExecutionLimits,
} from "./control/executionContract.js";
import { z } from "zod";
import { userPaths } from "./paths.js";
import { backendSchema, goalSchema, type GoalInput } from "./control/schema.js";
import { secretReferenceSchema } from "./credentials.js";
export { readSecret } from "./credentials.js";
import { humanBindingSchema } from "./control/human.js";
import { storageDefaults } from "./control/storage.js";
import { isolatedRuntimeSchema } from "./control/isolatedRuntime.js";
import {
  authEnvironmentSchema,
  authPolicyHash,
} from "./control/authEnvironment.js";
import { backupPolicySchema, resolveBackupPolicy } from "./backupPolicy.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/);
export const installationSchema = z
  .object({
    schemaVersion: z.literal(1),
    stateDir: z.string().min(1),
    secretsDir: z.string().min(1),
    backup: backupPolicySchema.prefault({}),
    server: z
      .object({
        port: z
          .number()
          .int()
          .min(1024)
          .max(65535)
          .refine(
            (p) => ![43190, 17443].includes(p),
            "Port is reserved for the existing installation",
          )
          .default(43201),
        allowedOrigins: z.array(z.string().url()).default([]),
      })
      .strict()
      .prefault({}),
    authority: z
      .object({
        allowedProviders: z.array(z.string()).default([]),
        allowedExecutionModes: z
          .array(z.enum(["fake", "isolated"]))
          .default(["fake"]),
        publish: z.boolean().default(false),
        autoMerge: z.boolean().default(false),
        maxGoalCostUsd: z.number().nonnegative().default(0),
        maxTotalAdmittedCostUsd: z.number().nonnegative().default(0),
      })
      .strict()
      .prefault({}),
    contextRoots: z
      .array(z.object({ id, path: z.string().min(1) }).strict())
      .default([]),
    storage: z
      .object({
        mergedRetentionMs: z
          .number()
          .int()
          .nonnegative()
          .default(storageDefaults.mergedRetentionMs),
        archiveRetentionMs: z
          .number()
          .int()
          .nonnegative()
          .default(storageDefaults.archiveRetentionMs),
        archiveBudgetBytes: z
          .number()
          .int()
          .nonnegative()
          .default(storageDefaults.archiveBudgetBytes),
        cacheBudgetBytes: z
          .number()
          .int()
          .nonnegative()
          .default(storageDefaults.cacheBudgetBytes),
        freeReserveBytes: z
          .number()
          .int()
          .nonnegative()
          .default(storageDefaults.freeReserveBytes),
      })
      .strict()
      .prefault({}),
    files: z
      .object({
        projects: z.array(z.string()).default([]),
        providers: z.array(z.string()).default([]),
        connectors: z.array(z.string()).default([]),
        profiles: z.array(z.string()).default([]),
        hosts: z.array(z.string()).default([]),
        prompts: z.array(z.string()).default([]),
        schedules: z.array(z.string()).default([]),
        auth: z.array(z.string()).default([]),
      })
      .strict()
      .prefault({}),
  })
  .strict();
// Zod defaults inside partial objects must not override earlier configuration
// layers merely because a project omitted a key.
const goalDefaultsSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => {
    const parsed = goalSchema.partial().strict().parse(raw);
    const result = Object.fromEntries(
      Object.keys(raw).map((key) => [
        key,
        (parsed as Record<string, unknown>)[key],
      ]),
    );
    if (raw.policy && typeof raw.policy === "object") {
      result.policy = Object.fromEntries(
        Object.keys(raw.policy).map((key) => [
          key,
          (parsed.policy as unknown as Record<string, unknown>)[key],
        ]),
      );
    }
    return result as Partial<GoalInput>;
  });
export const projectFileSchema = z
  .object({
    id,
    name: z.string().min(1),
    family: z.string().default("Projects"),
    enabled: z.boolean().default(false),
    profile: id.optional(),
    provider: id.optional(),
    executionMode: z.enum(["fake", "isolated"]).default("fake"),
    promptIds: z.array(id).max(20).default([]),
    contextFiles: z
      .array(z.object({ rootId: id, path: z.string().min(1) }).strict())
      .max(20)
      .default([]),
    config: goalDefaultsSchema,
  })
  .strict();
const providerFileSchema = z
  .object({
    id,
    enabled: z.boolean().default(false),
    backend: backendSchema,
    executionContract: executionContractSchema.optional(),
    credential: secretReferenceSchema.optional(),
    runtime: isolatedRuntimeSchema.optional(),
  })
  .strict();
const profileFileSchema = z
  .object({ id, defaults: goalDefaultsSchema })
  .strict();
const promptFileSchema = z.object({ id, path: z.string().min(1) }).strict();
const connectorFileSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id,
      kind: z.literal("telegram"),
      enabled: z.boolean().default(false),
      credential: secretReferenceSchema.optional(),
      bindings: z.array(humanBindingSchema).default([]),
      settings: z
        .object({
          quietHours: z
            .object({
              start: z.number().int().min(0).max(23),
              end: z.number().int().min(0).max(23),
              timezone: z.string(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("matrix"),
      enabled: z.boolean().default(false),
      credential: secretReferenceSchema.optional(),
      controllerCredential: secretReferenceSchema.optional(),
      bindings: z.array(humanBindingSchema).default([]),
      settings: z
        .object({
          binary: z.string().min(1).optional(),
          companionConfig: z.string().min(1).optional(),
          homeserver: z.string().url().optional(),
          roomId: z.string().optional(),
          stateDir: z.string().optional(),
          verified: z.boolean().default(false),
        })
        .strict(),
    })
    .strict(),
]);
const hostFileSchema = z
  .object({ id, isolatedRuntime: isolatedRuntimeSchema.optional() })
  .strict();
const scheduleFileSchema = z
  .object({
    id,
    projectId: id,
    description: z.string().min(1),
    intervalMs: z.number().int().min(60000),
    enabled: z.boolean().default(false),
  })
  .strict();

export interface LoadedConfiguration {
  root: string;
  hash: string;
  runtimeHash: string;
  settings: z.output<typeof installationSchema>;
  projects: z.output<typeof projectFileSchema>[];
  providers: z.output<typeof providerFileSchema>[];
  connectors: z.output<typeof connectorFileSchema>[];
  profiles: z.output<typeof profileFileSchema>[];
  hosts: z.output<typeof hostFileSchema>[];
  schedules: z.output<typeof scheduleFileSchema>[];
  auth: z.output<typeof authEnvironmentSchema>[];
  contexts: Record<string, { path: string; content: string; hash: string }[]>;
  prompts: { id: string; content: string; hash: string }[];
}
function within(root: string, path: string) {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}
export async function loadConfiguration(
  directory: string,
): Promise<LoadedConfiguration> {
  const root = await realpath(resolve(directory)),
    hashes: Record<string, string> = {};
  const read = async (file: string) => {
    const path = resolve(root, file),
      canonical = await realpath(path);
    if (!within(root, canonical) || (await lstat(path)).isSymbolicLink())
      throw new Error(
        "Configuration reference escapes configDir or is a symlink",
      );
    const text = await readFile(path, "utf8");
    hashes[relative(root, path)] = createHash("sha256")
      .update(text)
      .digest("hex");
    return { path, text };
  };
  const settings = installationSchema.parse(
    JSON.parse((await read("config.json")).text),
  );
  settings.contextRoots = settings.contextRoots.map((r) => ({
    ...r,
    path: resolve(root, r.path),
  }));
  if (
    new Set(settings.contextRoots.map((r) => r.id)).size !==
    settings.contextRoots.length
  )
    throw new Error("Duplicate approved context root ID");
  settings.stateDir = resolve(root, settings.stateDir);
  settings.secretsDir = resolve(root, settings.secretsDir);
  settings.backup = resolveBackupPolicy(
    settings.backup,
    root,
    settings.stateDir,
    settings.secretsDir,
  );
  if (within(root, settings.stateDir) || within(root, settings.secretsDir))
    throw new Error(
      "State and secrets must live outside the configuration repository",
    );
  const group = async <T>(
    files: string[],
    schema: z.ZodType<T>,
    paths: string[] = [],
  ) => {
    const records: T[] = [];
    for (const file of files) {
      const source = await read(file),
        parsed = JSON.parse(source.text);
      for (const p of paths)
        if (typeof parsed[p] === "string")
          parsed[p] = resolve(dirname(source.path), parsed[p]);
      for (const defaults of [parsed.config, parsed.defaults]) {
        if (defaults?.repoPath)
          defaults.repoPath = resolve(dirname(source.path), defaults.repoPath);
        if (defaults?.siblingContracts)
          for (const c of defaults.siblingContracts)
            c.repositoryPath = resolve(dirname(source.path), c.repositoryPath);
      }
      if (parsed.isolatedRuntime) {
        for (const key of ["environmentImagesRoot"])
          if (parsed.isolatedRuntime[key])
            parsed.isolatedRuntime[key] = resolve(
              dirname(source.path),
              parsed.isolatedRuntime[key],
            );
        if (parsed.isolatedRuntime.environmentExecutionRoots)
          parsed.isolatedRuntime.environmentExecutionRoots =
            parsed.isolatedRuntime.environmentExecutionRoots.map(
              (path: string) => resolve(dirname(source.path), path),
            );
      }
      if (parsed.kind === "matrix")
        for (const key of ["stateDir", "binary", "companionConfig"])
          if (parsed.settings?.[key])
            parsed.settings[key] = resolve(
              dirname(source.path),
              parsed.settings[key],
            );
      records.push(schema.parse(parsed));
    }
    const ids = records.map((r) => (r as { id: string }).id);
    if (new Set(ids).size !== ids.length)
      throw new Error("Duplicate configuration ID");
    return records;
  };
  const builtinText = await readFile(
    fileURLToPath(new URL("../profiles/synthetic.json", import.meta.url)),
    "utf8",
  );
  hashes["builtin:profiles/synthetic.json"] = createHash("sha256")
    .update(builtinText)
    .digest("hex");
  const builtins = [profileFileSchema.parse(JSON.parse(builtinText))];
  const providers = await group(settings.files.providers, providerFileSchema),
    profiles = [
      ...builtins,
      ...(await group(settings.files.profiles, profileFileSchema)),
    ],
    projects = await group(settings.files.projects, projectFileSchema),
    connectors = await group(settings.files.connectors, connectorFileSchema),
    hosts = await group(settings.files.hosts, hostFileSchema),
    schedules = await group(settings.files.schedules, scheduleFileSchema);
  if (new Set(profiles.map((p) => p.id)).size !== profiles.length)
    throw new Error("Built-in profile IDs cannot be overridden");
  const prompts = [];
  for (const file of settings.files.prompts) {
    const s = await read(file),
      p = promptFileSchema.parse(JSON.parse(s.text)),
      content = (await read(relative(root, resolve(dirname(s.path), p.path))))
        .text;
    if (content.length > 64000)
      throw new Error("Prompt exceeds bounded context limit");
    prompts.push({
      id: p.id,
      content,
      hash: createHash("sha256").update(content).digest("hex"),
    });
  }
  if (new Set(prompts.map((p) => p.id)).size !== prompts.length)
    throw new Error("Duplicate prompt ID");
  const contexts: LoadedConfiguration["contexts"] = {};
  for (const project of projects) {
    for (const promptId of project.promptIds)
      if (!prompts.some((p) => p.id === promptId))
        throw new Error(`Unknown prompt ${promptId} for project ${project.id}`);
    contexts[project.id] = [];
    let bytes = 0;
    for (const ref of project.contextFiles) {
      const approved = settings.contextRoots.find((r) => r.id === ref.rootId);
      if (!approved)
        throw new Error(`Unknown approved context root ${ref.rootId}`);
      const contextRoot = await realpath(approved.path),
        path = resolve(contextRoot, ref.path),
        canonical = await realpath(path);
      if (
        !within(contextRoot, path) ||
        canonical !== path ||
        (await lstat(path)).isSymbolicLink()
      )
        throw new Error(
          "Selected context escapes its approved root or traverses a symlink",
        );
      const content = await readFile(path, "utf8");
      bytes += Buffer.byteLength(content);
      if (bytes > 64000)
        throw new Error("Selected private context exceeds bounded input limit");
      const hash = createHash("sha256").update(content).digest("hex");
      hashes[`context:${project.id}:${ref.rootId}:${ref.path}`] = hash;
      contexts[project.id].push({
        path: `${ref.rootId}:${ref.path}`,
        content,
        hash,
      });
    }
  }
  const auth = await group(settings.files.auth, authEnvironmentSchema);
  const authPaths = auth.map((a) => resolve(settings.secretsDir, a.sessionDir));
  for (const path of authPaths)
    if (
      path === settings.secretsDir ||
      !within(settings.secretsDir, path) ||
      authPaths.some(
        (other) =>
          other !== path && (within(other, path) || within(path, other)),
      )
    )
      throw new Error(
        "Authentication stores must be distinct dedicated directories inside secretsDir",
      );
  if (new Set(authPaths).size !== authPaths.length)
    throw new Error("Authentication stores cannot share a session directory");
  if (hosts.filter((h) => h.isolatedRuntime).length > 1)
    throw Error(
      "Configure exactly one installation isolated runtime host; multiple runtimes are not supported",
    );
  const runtimeHash = createHash("sha256")
    .update(JSON.stringify({ hosts, providers, auth }))
    .digest("hex");
  const loaded = {
    root,
    hash: createHash("sha256")
      .update(JSON.stringify(Object.entries(hashes).sort()))
      .digest("hex"),
    settings,
    projects,
    providers,
    profiles,
    connectors,
    hosts,
    schedules,
    prompts,
    contexts,
    runtimeHash,
    auth,
  };
  for (const provider of providers) {
    if (provider.backend.kind === "fake") {
      if (provider.executionContract)
        validateBackendContract(provider.backend, provider.executionContract);
      continue;
    }
    if (!provider.executionContract)
      throw Error(
        `Provider ${provider.id} requires an explicit executionContract`,
      );
    const contract = validateBackendContract(
      provider.backend,
      provider.executionContract,
    );
    if (!provider.backend.model)
      throw Error(`Provider ${provider.id} requires an explicit model`);
    if (provider.credential || provider.runtime)
      throw Error(
        `Provider ${provider.id}: configure credentials and runtime in the explicit host/auth environment`,
      );
    const definitions = hosts.flatMap((h) =>
      h.isolatedRuntime?.providers[provider.id]
        ? [h.isolatedRuntime.providers[provider.id]]
        : [],
    );
    if (definitions.length !== 1)
      throw Error(
        `Provider ${provider.id} requires exactly one explicit host runtime definition`,
      );
    const definition = definitions[0];
    if (contract.authentication.kind === "session") {
      const reference = contract.authentication.reference;
      const environment = auth.find((a) => a.id === reference);
      if (!environment || environment.harness !== contract.harness)
        throw Error(
          `Provider ${provider.id} requires a matching dedicated authentication environment`,
        );
      if (
        definition.protocol !== "subscription" ||
        definition.harness !== contract.harness ||
        definition.model !== provider.backend.model ||
        definition.authentication.reference !== reference
      )
        throw Error(
          `Provider ${provider.id} subscription runtime differs from harness/model/authentication`,
        );
      for (const project of projects.filter(
        (p) => p.provider === provider.id,
      )) {
        const image = hosts.find((h) => h.isolatedRuntime)?.isolatedRuntime
          ?.projects[project.id]?.imageDigest;
        if (image !== environment.imageDigest)
          throw Error(
            `Project ${project.id} requires the same pinned image as its dedicated authentication environment`,
          );
      }
    } else if (contract.authentication.kind === "controller") {
      if (contract.authentication.reference !== provider.id)
        throw Error(
          `Provider ${provider.id} controller authentication must reference its own runtime provider ID`,
        );
      if (definition.protocol === "tool-loop") {
        if (
          JSON.stringify(definition.backend) !==
          JSON.stringify(provider.backend)
        )
          throw Error(
            `Provider ${provider.id} runtime backend differs from its admitted configuration`,
          );
        if (
          provider.backend.kind === "bedrock"
            ? definition.authentication.kind !== "aws-session"
            : provider.backend.kind !== "azure" ||
              (provider.backend.credential === "key"
                ? definition.authentication.kind !== "secret"
                : definition.authentication.kind !== "azure-cli")
        )
          throw Error(
            `Provider ${provider.id} runtime authentication differs from its backend`,
          );
      } else if (
        definition.protocol === "subscription" ||
        definition.protocol !==
          (contract.harness === "codex"
            ? "responses"
            : contract.harness === "claude-code"
              ? "messages"
              : "tool-loop") ||
        definition.model !== provider.backend.model
      )
        throw Error(
          `Provider ${provider.id} runtime protocol/model differs from its harness`,
        );
    }
  }
  for (const project of projects)
    effectiveGoal(loaded, project.id, "Configuration validation", {}, false);
  for (const schedule of schedules)
    if (!projects.some((p) => p.id === schedule.projectId))
      throw new Error(`Unknown scheduled project ${schedule.projectId}`);
  for (const connector of connectors) {
    if (
      connector.kind === "telegram" &&
      connector.bindings.some((b) => b.enabled && b.requireVerifiedDevice)
    )
      throw new Error(
        "Telegram bindings cannot provide verified device evidence; select Matrix or explicitly configure plaintext Telegram trust",
      );
    if (
      connector.enabled &&
      (!(connector.kind === "matrix"
        ? connector.controllerCredential
        : connector.credential) ||
        !connector.bindings.some((b) => b.enabled))
    )
      throw new Error(
        `Enabled connector ${connector.id} requires explicit credentials and enabled bindings`,
      );
    for (const binding of connector.bindings) {
      if (
        binding.connectorId !== connector.id ||
        binding.kind !== connector.kind
      )
        throw new Error("Connector binding identity mismatch");
      for (const project of binding.projectIds)
        if (!projects.some((p) => p.id === project))
          throw new Error(`Unknown connector project ${project}`);
    }
  }
  return loaded;
}
export function effectiveGoal(
  config: LoadedConfiguration,
  projectId: string,
  description: string,
  overrides: Partial<GoalInput> = {},
  requireQualification = true,
): z.output<typeof goalSchema> {
  const p = config.projects.find((p) => p.id === projectId);
  if (!p) throw new Error(`Unknown project ${projectId}`);
  const profile = p.profile
    ? config.profiles.find((v) => v.id === p.profile)
    : undefined;
  if (p.profile && !profile) throw new Error(`Unknown profile ${p.profile}`);
  const provider = p.provider
    ? config.providers.find((v) => v.id === p.provider)
    : undefined;
  if (p.provider && !provider)
    throw new Error(`Unknown provider ${p.provider}`);
  const authentication = provider?.executionContract?.authentication;
  const admittedAuth =
    authentication?.kind === "session"
      ? config.auth.find((a) => a.id === authentication.reference)
      : undefined;
  const baseline = goalSchema.parse({
    backend: { kind: "fake" },
    ...profile?.defaults,
    ...p.config,
    policy: { ...profile?.defaults.policy, ...p.config.policy },
    ...(provider
      ? {
          backend: provider.backend,
          executionContract: provider.executionContract,
        }
      : {}),
    admission: {
      configurationHash: config.hash,
      runtimeHash: config.runtimeHash,
      executionImageDigest: config.hosts.find((h) => h.isolatedRuntime)
        ?.isolatedRuntime?.projects[p.id]?.imageDigest,
      authenticationPolicyHash: admittedAuth
        ? authPolicyHash(admittedAuth)
        : undefined,
      contexts: config.contexts[p.id] ?? [],
      executionMode: p.executionMode,
      providerId: provider?.id,
      prompts: config.prompts.filter((prompt) =>
        p.promptIds.includes(prompt.id),
      ),
    },
    projectId,
    title: description.slice(0, 100),
    description,
  });
  if (baseline.executionContract) {
    const contract = validateBackendContract(
      baseline.backend,
      baseline.executionContract,
    );
    if (contract.execution !== p.executionMode)
      throw Error("Project execution mode differs from provider contract");
    if (contract.usagePolicy.kind === "subscription") {
      const auth = config.auth.find(
        (a) =>
          a.id ===
          (contract.authentication.kind === "session"
            ? contract.authentication.reference
            : ""),
      );
      if (!auth || auth.harness !== contract.harness)
        throw Error(
          "Subscription requires a configured dedicated authentication environment",
        );
      if (requireQualification && p.enabled && provider?.enabled)
        assertSubscriptionQualification(
          config.settings.stateDir,
          baseline,
          auth,
        );
    }
    if (
      contract.usagePolicy.kind === "metered" &&
      (baseline.maxCostUsd > contract.usagePolicy.maxCostUsd ||
        baseline.estimatePerRunUsd > contract.usagePolicy.estimatePerRunUsd)
    )
      throw Error("Goal dollar limits exceed provider usage policy");
  }
  // A configured project fixes execution authority. Goals may describe work and
  // reduce limits, but cannot change repositories, checks, instructions or policy.
  for (const [key, value] of Object.entries(overrides)) {
    if (
      [
        "title",
        "description",
        "projectId",
        "scheduledAt",
        "maxCostUsd",
        "maxWorkers",
        "maxAttempts",
        "timeoutMs",
        "maxReplans",
      ].includes(key)
    )
      continue;
    if (
      JSON.stringify(value) !==
      JSON.stringify((baseline as unknown as Record<string, unknown>)[key])
    )
      throw new Error(`Goal cannot override configured ${key}`);
  }
  if (p.enabled && p.executionMode === "isolated" && !baseline.containerImage)
    throw new Error(
      "Enabled isolated projects require an explicit project verification image (containerImage)",
    );
  const result = goalSchema.parse({
    ...baseline,
    ...overrides,
    projectId,
    title: description.slice(0, 100),
    description,
  });
  validateExecutionLimits(result);
  for (const key of [
    "maxCostUsd",
    "maxWorkers",
    "maxAttempts",
    "timeoutMs",
    "maxReplans",
  ] as const)
    if (result[key] > baseline[key])
      throw new Error(`Goal cannot increase configured ${key}`);
  const a = config.settings.authority;
  if (!a.allowedExecutionModes.includes(p.executionMode))
    throw new Error("Project execution mode is not authorized");
  if (p.executionMode === "fake" && result.backend.kind !== "fake")
    throw new Error("Real providers require isolated execution");
  if (
    result.backend.kind !== "fake" &&
    p.enabled &&
    (!provider?.enabled || !a.allowedProviders.includes(provider.id))
  )
    throw new Error("Provider is not enabled and authorized");
  if (
    (result.policy.publish && !a.publish) ||
    (result.policy.autoMerge && !a.autoMerge) ||
    result.maxCostUsd > a.maxGoalCostUsd
  )
    throw new Error("Goal exceeds installation authority");
  return result;
}
export async function initializeConfiguration(
  root: string,
  stateDir?: string,
  secretsDir?: string,
) {
  const paths = userPaths();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const settings = installationSchema.parse({
    schemaVersion: 1,
    stateDir: stateDir || paths.state,
    secretsDir: secretsDir || paths.secrets,
  });
  await writeFile(
    join(root, "config.json"),
    JSON.stringify(settings, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return loadConfiguration(root);
}
