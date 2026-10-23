import type { GoalConfig } from "./schema.js";
import { executionLimits } from "./executionLimits.js";
import { nativePreflight } from "./nativeRuntime.js";
import { instructionManifest } from "./projectContext.js";

/** Shared inspection operation. Never starts an agent turn or changes authentication. */
export async function explainProject(config: GoalConfig, preflight = false) {
  const environment = config.executionContract?.execution ?? "fake";
  return {
    projectId: config.projectId,
    environment: environment === "isolated" ? "container sandbox" : environment,
    repository: config.repoPath,
    checks: config.verificationCommands,
    resources: config.executionResources ?? null,
    profile: config.admission?.nativeProfile
      ? {
          executable: config.admission.nativeProfile.executable,
          codexHome: config.admission.nativeProfile.codexHome,
          profile: config.admission.nativeProfile.profile,
          permissions: config.admission.nativeProfile.permissions,
          path: config.admission.nativeProfile.path,
        }
      : null,
    limits: executionLimits(config),
    preflight: !preflight
      ? null
      : environment === "native"
        ? await nativePreflight(config)
        : {
            ready: environment === "fake",
            reason:
              environment === "fake"
                ? "Synthetic runtime"
                : "Inspect container image, provider and qualification through doctor",
          },
    context: preflight
      ? await instructionManifest({ config } as any, config.repoPath)
      : undefined,
  };
}
