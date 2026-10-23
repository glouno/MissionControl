import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const PROJECT_PROFILES = ["CLI", "API", "Dashboard", "Service"] as const;
export const MAX_INPUT_BYTES = 1024 * 1024;
const text = z
  .string()
  .min(1)
  .max(2048)
  .refine((s) => s.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(s));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const image = z.string().regex(/^(?:[\w./:-]+@)?sha256:[a-f0-9]{64}$/);
const unique = (values: string[]) => new Set(values).size === values.length;
const strings = z
  .array(text)
  .min(1)
  .max(32)
  .refine(unique, "Duplicate entries");
const locks = z
  .record(text, hash)
  .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 32);
const pin = z
  .object({
    repository: text,
    commit,
    configurationSha256: hash,
    imageDigest: image,
  })
  .strict();
const pins = z.object({ DependencyA: pin, DependencyB: pin }).strict();
const platform = z
  .object({
    os: z.enum(["linux", "macos", "windows"]),
    hostFingerprintSha256: hash,
  })
  .strict();
const authority = z.object({ principal: text, policySha256: hash }).strict();
const authorities = z
  .object({ protectedIntegration: authority, statusWriter: authority })
  .strict();
const binding = z
  .object({
    repository: text,
    baseCommit: commit,
    candidateCommit: commit,
    configurationSha256: hash,
    dependencyLocks: locks,
    executionImage: image,
    verificationImage: image,
    pins,
    platform,
  })
  .strict();
const expectedProject = binding
  .extend({
    profile: z.enum(PROJECT_PROFILES),
    projectId: text,
    requiredCommands: strings,
    localVerificationDocumentation: strings,
    authorities,
    evidenceRevision: text,
  })
  .strict();
const envelope = { schemaVersion: z.literal(1) };
const expectationsSchema = z
  .object({
    ...envelope,
    scope: z.enum(["fixture", "operator"]),
    projects: z.array(expectedProject).length(4),
  })
  .strict();
// Resolved, secret-free projection: references are not followed by this validator.
const configProject = z
  .object({
    profile: z.enum(PROJECT_PROFILES),
    id: text,
    enabled: z.boolean(),
    executionMode: z.literal("isolated"),
    config: z
      .object({
        repoPath: text,
        repository: z
          .object({
            identity: text,
            baseCommit: commit,
            candidateCommit: commit,
          })
          .strict(),
        verificationCommands: strings,
        containerImage: image,
        executionImage: image,
        dependencyLocks: locks,
        pins,
        platform,
      })
      .strict(),
  })
  .strict();
const configurationSchema = z
  .object({ ...envelope, projects: z.array(configProject).length(4) })
  .strict();
const receiptBinding = binding
  .extend({
    profile: z.enum(PROJECT_PROFILES),
    projectId: text,
    evidenceRevision: text,
  })
  .strict();
const repositorySchema = z
  .object({
    ...envelope,
    receipts: z
      .array(receiptBinding.extend({ clean: z.boolean() }).strict())
      .max(4),
  })
  .strict();
const artifactSchema = z
  .object({
    ...envelope,
    receipts: z
      .array(
        receiptBinding
          .extend({
            artifacts: z
              .array(
                z
                  .object({
                    name: text,
                    sha256: hash,
                    bytes: z
                      .number()
                      .int()
                      .min(1)
                      .max(16 * 1024 * 1024),
                  })
                  .strict(),
              )
              .min(1)
              .max(40),
          })
          .strict(),
      )
      .max(4),
  })
  .strict();
const checkSchema = z
  .object({
    ...envelope,
    receipts: z
      .array(
        receiptBinding
          .extend({
            commands: z
              .array(
                z
                  .object({
                    command: text,
                    status: z.enum([
                      "passed",
                      "failed",
                      "pending",
                      "cancelled",
                    ]),
                    exitCode: z.number().int(),
                  })
                  .strict(),
              )
              .min(1)
              .max(32),
            authorities: z
              .object({
                protectedIntegration: authority.nullable(),
                statusWriter: authority.nullable(),
              })
              .strict(),
            hostStatus: z.enum(["ready", "blocked", "unknown"]),
          })
          .strict(),
      )
      .max(4),
  })
  .strict();

/** Stable hashes bind a resolved project projection, never secret values or referenced files. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const configurationFingerprint = (project: unknown): string =>
  createHash("sha256").update(canonicalJson(project)).digest("hex");

/** Reject duplicate JSON keys before JSON.parse can discard evidence. Bound nesting and token count. */
export function parseQualificationJson(source: string): unknown {
  if (Buffer.byteLength(source) > MAX_INPUT_BYTES)
    throw Error("Input exceeds 1 MiB");
  const tokens =
    source.match(
      /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[a-fA-F0-9]{4}))*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|\S/g,
    ) ?? [];
  if (tokens.length > 20000) throw Error("Input exceeds token bound");
  let i = 0;
  function value(depth: number): void {
    if (depth > 32) throw Error("Input exceeds nesting bound");
    const token = tokens[i++];
    if (token === "{" || token === "[") {
      const end = token === "{" ? "}" : "]",
        keys = new Set<string>();
      if (tokens[i] === end) {
        i++;
        return;
      }
      do {
        if (token === "{") {
          const key = tokens[i++];
          if (!key?.startsWith('"') || tokens[i++] !== ":")
            throw Error("Malformed JSON object");
          const decoded = JSON.parse(key) as string;
          // Zod records omit this key; reject it before evidence can be lost.
          if (decoded === "__proto__") throw Error("Unsupported JSON key");
          if (keys.has(decoded)) throw Error("Duplicate JSON key");
          keys.add(decoded);
        }
        value(depth + 1);
        if (tokens[i] === end) {
          i++;
          return;
        }
      } while (tokens[i++] === ",");
      throw Error("Malformed JSON container");
    }
    if (!token || !/^(?:"|true$|false$|null$|-?\d)/.test(token))
      throw Error("Malformed JSON value");
  }
  value(0);
  if (i !== tokens.length) throw Error("Malformed JSON trailing data");
  return JSON.parse(source);
}

export async function readQualificationInput(file: string): Promise<unknown> {
  const path = resolve(file);
  if ((await realpath(path)) !== path)
    throw Error("Input must be a canonical file without symlinks");
  const before = await lstat(path);
  if (!before.isFile() || before.size > MAX_INPUT_BYTES)
    throw Error("Input must be a bounded regular file");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES)
      throw Error("Input must be a bounded regular file");
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_INPUT_BYTES) throw Error("Input exceeds 1 MiB");
    return parseQualificationJson(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size),
      ),
    );
  } finally {
    await handle.close();
  }
}

export interface QualificationInputs {
  expectations: unknown;
  configuration: unknown;
  repositories: unknown;
  artifacts: unknown;
  checks: unknown;
}
export function qualifyProjects(input: QualificationInputs) {
  const unresolved = {
    toolingDelivery: "requires-mc-check-and-controller-review",
    actualPrivateApplicationAcceptance: "unresolved",
    nativeMacAcceptance: "unresolved",
    liveSubscriptionExecution: "unresolved",
    releaseQualification: "unchanged",
  };
  try {
    // Apply byte/depth/token bounds to API callers too, before schema traversal.
    const bounded = Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        parseQualificationJson(JSON.stringify(value)),
      ]),
    );
    const expectations = expectationsSchema.parse(bounded.expectations);
    const configuration = configurationSchema.parse(bounded.configuration);
    const repositories = repositorySchema.parse(bounded.repositories);
    const artifacts = artifactSchema.parse(bounded.artifacts);
    const checks = checkSchema.parse(bounded.checks);
    const globalIssues: string[] = [];
    for (const [name, rows] of [
      ["expectations", expectations.projects],
      ["configuration", configuration.projects],
      ["repositories", repositories.receipts],
      ["artifacts", artifacts.receipts],
      ["checks", checks.receipts],
    ] as const) {
      if (!unique(rows.map((r) => r.profile)))
        globalIssues.push(`${name}: duplicate profile`);
      if (!unique(rows.map((r) => ("projectId" in r ? r.projectId : r.id))))
        globalIssues.push(`${name}: duplicate project identity`);
    }
    const projects = PROJECT_PROFILES.map((profile) => {
      const issues: string[] = [...globalIssues];
      const expected = expectations.projects.find((r) => r.profile === profile);
      if (!expected)
        return {
          profile,
          qualified: false,
          issues: [...issues, "missing expectations"],
          nextCommands: [] as string[],
        };
      const config = configuration.projects.find((r) => r.profile === profile);
      if (!config) issues.push("missing configuration");
      else {
        if (config.id !== expected.projectId)
          issues.push("configuration: project identity mismatch");
        if (!config.enabled)
          issues.push(
            "configuration: disabled project hold (no enablement authorized)",
          );
        if (configurationFingerprint(config) !== expected.configurationSha256)
          issues.push("configuration: fingerprint mismatch or stale export");
        const projected = {
          repository: config.config.repository.identity,
          baseCommit: config.config.repository.baseCommit,
          candidateCommit: config.config.repository.candidateCommit,
          configurationSha256: configurationFingerprint(config),
          dependencyLocks: config.config.dependencyLocks,
          executionImage: config.config.executionImage,
          verificationImage: config.config.containerImage,
          pins: config.config.pins,
          platform: config.config.platform,
        };
        compare(projected, "configuration");
        if (
          canonicalJson(config.config.verificationCommands) !==
          canonicalJson(expected.requiredCommands)
        )
          issues.push("configuration: required commands mismatch");
      }
      function compare(row: z.infer<typeof binding>, label: string) {
        for (const key of Object.keys(
          binding.shape,
        ) as (keyof typeof binding.shape)[]) {
          if (canonicalJson(row[key]) !== canonicalJson(expected![key]))
            issues.push(`${label}: ${key} mismatch or stale evidence`);
          if (key === "pins") {
            for (const name of ["DependencyA", "DependencyB"] as const)
              if (
                canonicalJson(row.pins[name]) !==
                canonicalJson(expected!.pins[name])
              )
                issues.push(
                  `${label}: stale ${name} pin; exact supplied expectation required`,
                );
          }
        }
      }
      for (const [label, rows] of [
        ["repository", repositories.receipts],
        ["artifact", artifacts.receipts],
        ["check", checks.receipts],
      ] as const) {
        const row = rows.find((r) => r.profile === profile);
        if (!row) {
          issues.push(`missing ${label} receipt (private context unresolved)`);
          continue;
        }
        compare(row, label);
        if (row.projectId !== expected.projectId)
          issues.push(`${label}: project identity mismatch`);
        if (row.evidenceRevision !== expected.evidenceRevision)
          issues.push(`${label}: stale evidence revision`);
      }
      const repo = repositories.receipts.find((r) => r.profile === profile);
      if (repo && !repo.clean) issues.push("repository: dirty candidate");
      const artifact = artifacts.receipts.find((r) => r.profile === profile);
      if (artifact) {
        if (!unique(artifact.artifacts.map((a) => a.name)))
          issues.push("artifact: duplicate names");
        for (const name of [
          "verification.json",
          ...expected.localVerificationDocumentation,
        ])
          if (!artifact.artifacts.some((a) => a.name === name))
            issues.push(`artifact: missing ${name}`);
      }
      const check = checks.receipts.find((r) => r.profile === profile);
      if (check) {
        if (check.hostStatus !== "ready")
          issues.push(`platform/host blocker: ${check.hostStatus}`);
        if (!unique(check.commands.map((c) => c.command)))
          issues.push("check: duplicate commands");
        for (const command of expected.requiredCommands)
          if (!check.commands.some((c) => c.command === command))
            issues.push(`check: missing required command ${command}`);
        for (const command of check.commands)
          if (command.status !== "passed" || command.exitCode !== 0)
            issues.push(
              `check: failed or unresolved command ${command.command}`,
            );
        for (const key of ["protectedIntegration", "statusWriter"] as const)
          if (
            canonicalJson(check.authorities[key]) !==
            canonicalJson(expected.authorities[key])
          )
            issues.push(
              `authority gap: ${key} missing or mismatched; owned evidence required`,
            );
      } else
        issues.push(
          "authority gap: protectedIntegration and statusWriter unresolved",
          "platform/host blocker: unavailable host evidence",
        );
      return {
        profile,
        projectId: expected.projectId,
        qualified: issues.length === 0,
        issues,
        platform: expected.platform,
        nextCommands: issues.length ? expected.requiredCommands : [],
        handoff:
          "Owner: verify host and authority, collect exact candidate receipts and artifact hashes; display-only commands require separate approved execution. Retain verification.json and local verification documentation. Re-run this CLI with all five explicit inputs.",
      };
    });
    const qualified = projects.every((p) => p.qualified);
    return {
      schemaVersion: 1,
      scope: expectations.scope,
      suppliedEvidenceQualified: qualified,
      fixtureOutcome:
        expectations.scope === "fixture"
          ? qualified
            ? "passed"
            : "blocked"
          : "not-run",
      ...unresolved,
      projects,
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      suppliedEvidenceQualified: false,
      fixtureOutcome: "unresolved",
      ...unresolved,
      issues: [
        error instanceof z.ZodError
          ? `Malformed or unknown input fields: ${error.issues.map((issue) => issue.path.join(".") || "document").join(", ")}; missing, duplicate or invalid bindings/commands/pins`
          : error instanceof Error
            ? error.message
            : "Malformed input",
      ],
      projects: [],
    };
  }
}
