import { createHash } from "node:crypto";
import { z } from "zod";
import { backendSchema } from "./control/schema.js";
import { projectFileSchema } from "./config.js";
import {
  executionContractSchema,
  validateBackendContract,
  validateExecutionLimits,
} from "./control/executionContract.js";
import { SUBSCRIPTION_GATES } from "./control/subscriptionQualification.js";

const label = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._/:@+-]*$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const image = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time = z.string().datetime();
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable();
const unique = <T extends z.ZodType>(schema: T, limit: number) =>
  z
    .array(schema)
    .max(limit)
    .refine((a) => new Set(a.map((x) => JSON.stringify(x))).size === a.length);
const context = z.object({ id: label, sha256: nullable(sha) }).strict();
const requirements = z
  .object({
    repository: nullable(label),
    targetBranch: nullable(label),
    exactBase: nullable(commit),
    requiredChecks: unique(label, 30),
    context: z.array(context).max(40),
    projectHash: nullable(sha),
    configHash: nullable(sha),
    runtimeHash: nullable(sha),
    implementationHash: nullable(sha),
    providerId: nullable(label),
    model: nullable(label),
    contract: nullable(executionContractSchema),
    runtime: nullable(
      z
        .object({
          protocol: z.enum([
            "subscription",
            "responses",
            "messages",
            "bedrock",
            "vertex",
          ]),
          model: label,
          authenticationReference: label,
        })
        .strict(),
    ),
    authenticationPolicyHash: nullable(sha),
    executionImage: nullable(image),
    verificationImage: nullable(image),
    platform: nullable(z.enum(["linux", "darwin"])),
    architecture: nullable(z.enum(["x64", "arm64"])),
  })
  .strict();
export const GATE_ASSERTIONS = {
  "login-restart": ["dedicated-login", "restart-retains-login"],
  "refresh-expiry": ["refresh-success", "expired-auth-denied"],
  "network-denial": ["unapproved-egress-denied"],
  "native-policy": ["native-policy-enforced"],
  "bounded-coding": ["bounded-candidate-produced"],
  "independent-check-review": [
    "exact-candidate-checks-passed",
    "independent-review-passed",
  ],
  "controller-lifecycle": [
    "controller-restart-recovery",
    "unknown-usage-fenced",
  ],
} as const;
const assertion = z.enum(Object.values(GATE_ASSERTIONS).flat());
const gateEvidence = z
  .object({
    schemaVersion: z.literal(1),
    gate: z.enum(SUBSCRIPTION_GATES),
    passed: z.literal(true),
    requirementsHash: sha,
    observedAt: time,
    assertions: unique(assertion, 10),
  })
  .strict();
const qualification = z
  .object({
    schemaVersion: z.literal(1),
    requirementsHash: sha,
    expiresAt: time,
    gates: z
      .array(
        z
          .object({
            id: z.enum(SUBSCRIPTION_GATES),
            sha256: sha,
            evidence: nullable(gateEvidence),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
const configurationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("project-readiness-config"),
    exportedAt: time,
    projects: z
      .array(
        z
          .object({
            id: label,
            project: z.unknown(),
            providerEnabled: nullable(z.boolean()),
            requirements,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const statusSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("project-readiness-status"),
    exportedAt: time,
    projects: z
      .array(
        z
          .object({
            id: label,
            requirementsHash: nullable(sha),
            reportedReady: nullable(z.boolean()),
            paused: nullable(z.boolean()),
            unknownUsageHold: nullable(z.boolean()),
            hostPolicyAllowsExecution: nullable(z.boolean()),
            dockerAvailable: nullable(z.boolean()),
            executionImage: nullable(image),
            verificationImage: nullable(image),
            authPrepared: nullable(z.boolean()),
            authWriterActive: nullable(z.boolean()),
            qualification: nullable(qualification),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type ReadinessConfigurationExport = z.input<typeof configurationSchema>;
export type ReadinessStatusExport = z.input<typeof statusSchema>;
/** Canonical object-key order, preserving array order. No host data is consulted. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function evidenceHash(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
/** Enablement is an admission switch, separate from execution acceptance. */
export function projectSnapshotHash(project: unknown) {
  if (
    project !== null &&
    typeof project === "object" &&
    !Array.isArray(project)
  ) {
    const { enabled: _enabled, ...snapshot } = project as Record<
      string,
      unknown
    >;
    return evidenceHash(snapshot);
  }
  return evidenceHash(project);
}
export const REPORTED_OPERATOR_CONTEXT: string[] = [];
const FRESHNESS_MS = 24 * 60 * 60 * 1000;
const MAX_ACCEPTANCE_MS = 30 * FRESHNESS_MS;
export function auditProjectReadiness(
  configInput: unknown,
  statusInput: unknown,
  asOf: string,
) {
  const c = configurationSchema.safeParse(configInput),
    s = statusSchema.safeParse(statusInput);
  if (!time.safeParse(asOf).success || !c.success || !s.success)
    return {
      schemaVersion: 1 as const,
      inputValid: false,
      exitCode: 2,
      errors: [
        ...(!c.success ? ["invalid_or_missing_config_export"] : []),
        ...(!s.success ? ["invalid_or_missing_status_export"] : []),
        ...(!time.safeParse(asOf).success ? ["invalid_as_of"] : []),
      ],
      projects: [],
      reportedOperatorContext: REPORTED_OPERATOR_CONTEXT,
    };
  const config = c.data,
    status = s.data,
    now = Date.parse(asOf);
  if (
    new Set(config.projects.map((p) => p.id)).size !== config.projects.length ||
    new Set(status.projects.map((p) => p.id)).size !== status.projects.length ||
    status.projects.some((p) => !config.projects.some((c) => c.id === p.id))
  )
    return {
      schemaVersion: 1 as const,
      inputValid: false,
      exitCode: 2,
      errors: ["conflicting_project_ids"],
      projects: [],
      reportedOperatorContext: REPORTED_OPERATOR_CONTEXT,
    };
  const fresh = (date: string) =>
    Date.parse(date) <= now && now - Date.parse(date) <= FRESHNESS_MS;
  const projects = [...config.projects]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => {
      const r = p.requirements,
        hash = evidenceHash(r),
        st = status.projects.find((x) => x.id === p.id);
      const parsed = (() => {
        try {
          return projectFileSchema.safeParse(p.project);
        } catch {
          return { success: false as const };
        }
      })();
      const gaps: string[] = [],
        blockers: string[] = [];
      const gap = (code: string) => gaps.push(code);
      if (!parsed.success || (parsed.success && parsed.data.id !== p.id))
        gap("project_schema_invalid");
      const project = parsed.success ? parsed.data : null;
      if (!fresh(config.exportedAt)) gap("config_export_stale_or_future");
      if (!fresh(status.exportedAt)) gap("status_export_stale_or_future");
      if (!st) gap("project_status_missing");
      else if (st.requirementsHash !== hash)
        gap("status_requirements_binding_mismatch");
      for (const [key, value] of Object.entries(r))
        if (value === null) gap(`${key}_unknown`);
      if (!r.requiredChecks.length) gap("required_checks_missing");
      if (!r.context.length) gap("selected_context_missing");
      if (new Set(r.context.map((c) => c.id)).size !== r.context.length)
        gap("context_ids_conflicting");
      for (const ctx of r.context)
        if (!ctx.sha256) gap(`context_hash_unknown:${ctx.id}`);
      if (r.projectHash !== projectSnapshotHash(p.project))
        gap("project_snapshot_binding_mismatch");
      if (project) {
        if (!project.enabled) blockers.push("project_disabled");
        if (project.provider !== r.providerId) gap("project_provider_mismatch");
        if (project.executionMode !== r.contract?.execution)
          gap("execution_mode_mismatch");
        const cfg = project.config;
        if (cfg.policy?.targetBranch !== r.targetBranch)
          gap("target_branch_mismatch");
        if (
          canonical(cfg.policy?.requiredChecks ?? []) !==
          canonical(r.requiredChecks)
        )
          gap("required_checks_mismatch");
        if (!cfg.verificationCommands?.length)
          gap("verification_commands_missing");
        if (
          cfg.repository?.mode === "remote" &&
          (cfg.repository.remoteUrl !== r.repository ||
            cfg.repository.auditedPrimarySha !== r.exactBase ||
            cfg.repository.primaryBranch !== r.targetBranch)
        )
          gap("repository_binding_mismatch");
        if (
          cfg.repository?.mode === "local" &&
          (cfg.repoPath !== r.repository ||
            cfg.repository.branch !== r.targetBranch)
        )
          gap("repository_binding_mismatch");
        if (
          cfg.executionContract &&
          canonical(cfg.executionContract) !== canonical(r.contract)
        )
          gap("project_execution_contract_mismatch");
        if (!cfg.repository) gap("project_repository_contract_missing");
        if (cfg.backend && r.contract) {
          try {
            validateBackendContract(
              backendSchema.parse(cfg.backend),
              r.contract,
            );
            const limits = [
              "maxCostUsd",
              "estimatePerRunUsd",
              "maxAttempts",
              "timeoutMs",
              "maxWorkers",
            ] as const;
            if (limits.some((key) => cfg[key] === undefined))
              gap("effective_execution_limits_unknown");
            else
              validateExecutionLimits({
                backend: backendSchema.parse(cfg.backend),
                executionContract: r.contract,
                maxCostUsd: cfg.maxCostUsd!,
                estimatePerRunUsd: cfg.estimatePerRunUsd!,
                maxAttempts: cfg.maxAttempts!,
                timeoutMs: cfg.timeoutMs!,
                maxWorkers: cfg.maxWorkers!,
              });
          } catch {
            gap("backend_contract_or_limits_mismatch");
          }
          if (cfg.backend.model !== r.model) gap("backend_model_mismatch");
        } else gap("backend_unknown");
      }
      if (p.providerEnabled !== true)
        blockers.push(
          p.providerEnabled === false
            ? "provider_disabled"
            : "provider_enabled_unknown",
        );
      const auth = r.contract?.authentication;
      if (
        !r.runtime ||
        r.runtime.model !== r.model ||
        !auth ||
        auth.kind === "none" ||
        r.runtime.authenticationReference !== auth.reference
      )
        gap("runtime_authentication_binding_mismatch");
      if (
        r.contract?.usagePolicy.kind !== "subscription" ||
        r.runtime?.protocol !== "subscription"
      )
        gap("qualification_kind_unsupported");
      for (const key of [
        "paused",
        "unknownUsageHold",
        "hostPolicyAllowsExecution",
        "dockerAvailable",
        "authPrepared",
        "authWriterActive",
      ] as const) {
        const value = st?.[key];
        const wanted = [
          "hostPolicyAllowsExecution",
          "dockerAvailable",
          "authPrepared",
        ].includes(key);
        if (value !== wanted)
          blockers.push(value == null ? `${key}_unknown` : key);
      }
      for (const key of ["executionImage", "verificationImage"] as const)
        if (!st?.[key] || st[key] !== r[key])
          gap(`${key}_unavailable_or_mismatched`);
      const q = st?.qualification;
      if (!q) gap("qualification_evidence_missing");
      else {
        if (q.requirementsHash !== hash) gap("qualification_binding_mismatch");
        if (
          Date.parse(q.expiresAt) <= now ||
          Date.parse(q.expiresAt) > now + MAX_ACCEPTANCE_MS
        )
          gap("qualification_expired_or_out_of_window");
        if (q.gates.length !== SUBSCRIPTION_GATES.length)
          gap("qualification_gate_count_mismatch");
        for (const id of SUBSCRIPTION_GATES) {
          const entries = q.gates.filter((g) => g.id === id);
          if (entries.length !== 1) {
            gap(`gate_missing_or_duplicate:${id}`);
            continue;
          }
          const g = entries[0],
            e = g.evidence;
          if (!e) gap(`gate_evidence_unavailable:${id}`);
          else if (
            e.gate !== id ||
            e.requirementsHash !== hash ||
            evidenceHash(e) !== g.sha256 ||
            canonical([...e.assertions].sort()) !==
              canonical([...GATE_ASSERTIONS[id]].sort()) ||
            !fresh(e.observedAt) ||
            Date.parse(e.observedAt) >= Date.parse(q.expiresAt)
          )
            gap(`gate_evidence_mismatched_or_stale:${id}`);
        }
      }
      const qualificationGaps = [...new Set(gaps)].sort();
      const executionBlockers = [
        ...new Set([...blockers, ...qualificationGaps]),
      ].sort();
      return {
        id: p.id,
        schemaValid: !!project && project.id === p.id,
        projectEnabled: project?.enabled ?? null,
        providerEnabled: p.providerEnabled,
        requirements: r,
        requirementsHash: hash,
        reportedReady: st?.reportedReady ?? null,
        executionQualified: qualificationGaps.length === 0,
        qualificationGaps,
        executionBlockers,
        ready: executionBlockers.length === 0,
        operatorActions: executionBlockers.length
          ? [
              "Review exact gaps against fresh private exports; keep disabled states, paused work and unknown-usage holds.",
              "Operator owns private config application, enablement and platform/live acceptance; rerun this audit after review.",
            ]
          : [
              "Exported evidence matches; operator must still verify private admission and acceptance before execution.",
            ],
      };
    });
  return {
    schemaVersion: 1 as const,
    inputValid: true,
    asOf,
    exitCode: projects.every((p) => p.ready) ? 0 : 1,
    errors: [],
    projects,
    reportedOperatorContext: REPORTED_OPERATOR_CONTEXT,
  };
}
export function formatReadinessReport(
  report: ReturnType<typeof auditProjectReadiness>,
) {
  return (
    [
      `Project readiness audit v1: ${report.inputValid ? "exports valid" : "invalid exports"}; exit ${report.exitCode}`,
      ...report.errors,
      ...report.projects.map(
        (p) =>
          `${p.id}: schema=${p.schemaValid ? "valid" : "invalid"} enabled=${p.projectEnabled ?? "unknown"}/${p.providerEnabled ?? "unknown"} qualified=${p.executionQualified} ready=${p.ready}\n  repository=${p.requirements.repository ?? "unknown"} branch=${p.requirements.targetBranch ?? "unknown"} base=${p.requirements.exactBase ?? "unknown"}\n  checks=${p.requirements.requiredChecks.join(", ") || "unknown"} context=${p.requirements.context.map((c) => `${c.id}:${c.sha256 ?? "unknown"}`).join(", ") || "unknown"}\n  provider=${p.requirements.providerId ?? "unknown"}/${p.requirements.contract?.provider ?? "unknown"} model=${p.requirements.model ?? "unknown"} harness=${p.requirements.contract?.harness ?? "unknown"} runtime=${p.requirements.runtime?.protocol ?? "unknown"} auth=${p.requirements.contract?.authentication.kind ?? "unknown"} policyHash=${p.requirements.authenticationPolicyHash ?? "unknown"}\n  executionImage=${p.requirements.executionImage ?? "unknown"} verificationImage=${p.requirements.verificationImage ?? "unknown"} platform=${p.requirements.platform ?? "unknown"}/${p.requirements.architecture ?? "unknown"}\n  gaps: ${p.qualificationGaps.join(", ") || "none in export"}\n  blockers: ${p.executionBlockers.join(", ") || "none in export"}\n  action: ${p.operatorActions.join(" ")}`,
      ),
      ...report.reportedOperatorContext,
      "Tooling/export audit only. Real project qualification, native Mac acceptance and live execution remain operator-owned.",
    ].join("\n") + "\n"
  );
}
