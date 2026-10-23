import { z } from "zod";
import type { GoalConfig } from "./schema.js";
import { nativeBinding } from "./nativeConfig.js";

export const capabilityStateSchema = z.enum([
  "supported",
  "disabled_by_policy",
  "unavailable",
]);
const capabilitySchema = z
  .object({
    state: capabilityStateSchema,
    reason: z.string(),
  })
  .strict();
const names = [
  "tools",
  "instructions",
  "nativeCustomization",
  "integrations",
  "providerTools",
  "humanHandoff",
  "ownerHandoff",
  "nativeApprovals",
  "networkAccess",
  "boundedEgress",
  "sessions",
  "sessionContinuation",
  "structuredOutput",
  "usage",
  "isolation",
  "publication",
  "autoMerge",
] as const;
export const executionCapabilitiesSchema = z
  .object({
    version: z.literal(1),
    basis: z.literal("current_code"),
    path: z.enum([
      "paid_codex_app_server",
      "subscription_codex_exec",
      "native_codex_exec",
      "portable_tool_loop",
      "claude_native",
      "synthetic",
      "unavailable",
    ]),
    features: z
      .object(
        Object.fromEntries(
          names.map((name) => [name, capabilitySchema]),
        ) as Record<(typeof names)[number], typeof capabilitySchema>,
      )
      .strict(),
  })
  .strict();
export type ExecutionCapabilities = z.output<
  typeof executionCapabilitiesSchema
>;

/** Source capability projection only: no probes, grants, limits or runtime data.
 * Reasons are closed literals; never interpolate configuration or diagnostics.
 */
export function executionCapabilities(
  config: GoalConfig,
): ExecutionCapabilities {
  const kind = config.backend.kind;
  const contract = config.executionContract;
  const subscription = contract?.usagePolicy.kind === "subscription";
  const native =
    kind === "codex" &&
    contract?.execution === "native" &&
    contract.harness === "codex" &&
    contract.provider === "codex-subscription" &&
    contract.authentication.kind === "local" &&
    contract.usagePolicy.kind === "observed" &&
    config.admission?.executionMode === "native" &&
    !!config.admission.nativeProfile &&
    config.admission.runtimeHash === nativeBinding(config);
  const portable = ["azure", "bedrock", "vertex"].includes(kind);
  const real = kind !== "fake";
  const known =
    !real ||
    native ||
    (!!contract &&
      contract.execution === "isolated" &&
      contract.harness === (portable ? "tool-loop" : kind) &&
      (subscription
        ? contract.authentication.kind === "session" &&
          contract.provider ===
            (kind === "codex" ? "codex-subscription" : "claude-subscription") &&
          ["codex", "claude-code"].includes(kind)
        : contract.usagePolicy.kind === "metered" &&
          contract.authentication.kind === "controller" &&
          (portable
            ? contract.provider === kind
            : contract.provider === "azure")));
  const supported = (reason: string) => ({
    state: "supported" as const,
    reason,
  });
  const disabled = (reason: string) => ({
    state: "disabled_by_policy" as const,
    reason,
  });
  const unavailable = (reason: string) => ({
    state: "unavailable" as const,
    reason,
  });
  const features = Object.fromEntries(
    names.map((name) => [
      name,
      unavailable(
        known
          ? "No execution implementation for this capability."
          : "An explicit matching execution contract is required to describe this path.",
      ),
    ]),
  ) as ExecutionCapabilities["features"];
  const path: ExecutionCapabilities["path"] = !known
    ? "unavailable"
    : kind === "fake"
      ? "synthetic"
      : native
        ? "native_codex_exec"
        : portable
          ? "portable_tool_loop"
          : kind === "codex"
            ? subscription
              ? "subscription_codex_exec"
              : "paid_codex_app_server"
            : "claude_native";
  if (!known) return { version: 1, basis: "current_code", path, features };
  features.instructions = supported(
    "Controller-supplied prompts and bounded repository instruction manifests.",
  );
  features.publication = config.policy.publish
    ? supported(
        "Controller publication requires admitted project and installation authority.",
      )
    : disabled("Publication is disabled by admitted project policy.");
  features.autoMerge = config.policy.autoMerge
    ? supported(
        "Controller integration requires admitted policy, checks and independent review.",
      )
    : disabled("Automatic integration is disabled by admitted project policy.");
  if (!real) {
    features.tools = unavailable(
      "Synthetic execution performs deterministic fixture work without model tools.",
    );
    features.structuredOutput = supported(
      "Deterministic planning and review results.",
    );
    features.usage = supported(
      "Synthetic usage records no inference spending.",
    );
    return { version: 1, basis: "current_code", path, features };
  }
  if (native) {
    features.tools = supported(
      "Selected Codex executable tools run with the admitted local sandbox permissions; vendor tool inventory is not established.",
    );
    features.instructions = supported(
      "Existing Codex profile, repository instructions and controller task context remain enabled.",
    );
    features.nativeCustomization = supported(
      "Existing Codex home and profile configuration are retained; installed hooks are not independently qualified.",
    );
    features.integrations = supported(
      "Existing Codex integrations are retained; availability and authority require their own inspection.",
    );
    features.providerTools = unavailable(
      "The adapter does not establish the vendor's full tool inventory.",
    );
    features.humanHandoff = supported(
      "Validated coding questions become durable controller decisions after owned process cleanup.",
    );
    features.ownerHandoff = supported(
      "Validated coding requests can ask the owner to perform a bounded operation; requests do not grant authority.",
    );
    features.nativeApprovals = disabled(
      "Codex approval policy is never; the admitted sandbox permissions remain a separate constraint.",
    );
    features.networkAccess = supported(
      "Network behavior follows the selected Codex sandbox and local environment; MissionControl adds no container egress fence.",
    );
    features.boundedEgress = unavailable(
      "Native execution has no MissionControl per-host proxy or byte-bound egress adapter.",
    );
    features.sessions = supported(
      "Controller records native process identity, invocation lifecycle and exposed Codex session identifiers.",
    );
    features.sessionContinuation = supported(
      "Eligible coding continuations may resume a session only when the recorded candidate and native configuration bindings match.",
    );
    features.structuredOutput = supported(
      "Codex schema output is normalized and validated by the controller.",
    );
    features.usage = supported(
      "Exposed invocation, turn, elapsed-time and token measurements; hidden model requests and subscription dollar charges remain unavailable.",
    );
    features.isolation = unavailable(
      config.admission!.nativeProfile!.permissions === "devbox"
        ? "Devbox execution uses the ordinary host user; worktrees coordinate writers and do not isolate credentials."
        : "Workspace-write uses the Codex sandbox; MissionControl does not create a separate user or credential isolation boundary.",
    );
    return { version: 1, basis: "current_code", path, features };
  }
  features.tools = supported(
    portable
      ? "Six coding tools: read_file, write_file, list_files, shell, request_human_input and checkpoint; planning and review expose three tools."
      : "Native executable tools operate only in the invocation container; the complete vendor tool inventory is unverified.",
  );
  features.isolation = supported(
    "Private source and controller-owned container lifecycle; changes import only after stopped execution and validation.",
  );
  features.nativeCustomization = portable
    ? unavailable("The portable loop has no native customization loader.")
    : subscription || kind === "claude-code"
      ? disabled(
          "Native user configuration, hooks and discovery are disabled by the adapter; subscription Codex also ignores rules.",
        )
      : unavailable(
          "Native customization loading is not fully controlled or qualified by this adapter.",
        );
  features.integrations = portable
    ? unavailable(
        "The fixed tool loop has no worker MCP, app or plugin adapter.",
      )
    : subscription || kind === "claude-code"
      ? disabled(
          "Worker MCP and native discovery are disabled by the adapter; subscription Codex also disables apps and plugins.",
        )
      : unavailable(
          "No qualified worker integration contract; gateway access does not establish MCP or app support.",
        );
  features.providerTools = portable
    ? unavailable("Only the fixed controller function tools are exposed.")
    : subscription
      ? unavailable(
          "Vendor tool inventory and server behavior are not established by this checkout.",
        )
      : disabled(
          "The inference gateway refuses provider server tools and unsupported routes.",
        );
  features.humanHandoff = supported(
    portable
      ? "Coding uses a durable question tool; handoffs are withheld during planning and review."
      : subscription
        ? "Coding returns a validated structured question after teardown and source validation."
        : "Coding handoffs use scoped native tools or validated output; controller persistence follows teardown.",
  );
  features.ownerHandoff = portable
    ? unavailable("The six-tool loop has no owner-operation tool.")
    : supported(
        "Coding can request an owner operation; the controller retains execution and approval authority.",
      );
  features.nativeApprovals = disabled(
    portable
      ? "Tools cannot grant host or policy authority; durable controller decisions govern exceptions."
      : subscription || kind === "claude-code"
        ? "Native interactive approval is bypassed inside isolation; this grants no controller or host authority."
        : "Native approval policy is never; unsolicited native approval requests are declined.",
  );
  features.networkAccess = disabled(
    portable
      ? "Worker containers have no network; inference runs through the controller provider."
      : subscription
        ? "General worker network access is denied; only admitted HTTPS proxy destinations are reachable."
        : "Worker networks reach only the controller inference relay; general egress is denied.",
  );
  features.boundedEgress = subscription
    ? supported(
        "Controller policy can admit exact HTTPS hosts with public IPv4 validation and connection, byte and time bounds.",
      )
    : unavailable(
        "This execution path has no configurable general worker egress adapter.",
      );
  features.sessions = supported(
    portable
      ? "Controller records invocation lifecycle and tool checkpoints."
      : "Fresh native sessions return identifiers; controller lifecycle records do not imply native reuse.",
  );
  features.sessionContinuation = portable
    ? supported(
        "Controller checkpoint messages can seed a fresh invocation; interrupted shell tools are not replayed automatically.",
      )
    : disabled(
        "Native invocations are fresh and ephemeral; no native resume is wired.",
      );
  features.structuredOutput = supported(
    portable
      ? "Controller validates planning and review JSON; provider-native schema enforcement is not established."
      : "Native schema output is normalized and validated by the controller.",
  );
  features.usage = supported(
    subscription
      ? "Reported or unknown native token usage, elapsed time and invocation accounting; no dollar estimate."
      : "Controller records metered estimates; cache accounting and final invoices require separate evidence.",
  );
  return { version: 1, basis: "current_code", path, features };
}
