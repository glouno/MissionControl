import { z } from "zod";
import { createHash } from "node:crypto";
import type { GoalInput } from "./schema.js";

const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").includes(".."),
    "Prerequisites must be repository-relative",
  );
/** Explicit worker configuration, never a copy of the authentication store. */
export const nativeProfileSchema = z
  .object({
    executable: z.string().startsWith("/"),
    codexHome: z.string().startsWith("/"),
    home: z.string().startsWith("/"),
    path: z.string().min(1),
    profile: z.string().min(1).optional(),
    permissions: z.enum(["devbox", "workspace-write"]),
    environment: z
      .record(z.string(), z.string())
      .default({})
      .refine(
        (value) =>
          Object.keys(value).every(
            (key) =>
              !/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|MISSIONCONTROL|CODEX_HOME|^HOME$|^PATH$)/i.test(
                key,
              ),
          ),
        "Native environment accepts non-secret tool settings only; identity and paths have dedicated fields",
      ),
    setupCommands: z.array(z.string().min(1)).default([]),
    requiredExecutables: z.array(z.string().min(1)).default([]),
    requiredPaths: z.array(relativePath).default([]),
    requiredScopePaths: z.array(relativePath).default([]),
    buildOutputPaths: z.array(relativePath).default([]),
    requiredUrls: z
      .array(
        z
          .string()
          .url()
          .refine(
            (value) => new URL(value).protocol === "https:",
            "Required documentation URLs use HTTPS",
          ),
      )
      .default([]),
  })
  .strict();
export type NativeProfile = z.output<typeof nativeProfileSchema>;
export function nativeBinding(
  goal: Pick<GoalInput, "admission" | "backend" | "executionContract">,
) {
  const profile = goal.admission?.nativeProfile
    ? { ...goal.admission.nativeProfile }
    : undefined;
  // Additive empty preparation fields preserve bindings made before their introduction.
  if (profile)
    for (const key of [
      "requiredPaths",
      "requiredScopePaths",
      "buildOutputPaths",
      "requiredUrls",
    ] as const)
      if (!profile[key]?.length)
        delete (profile as Partial<NativeProfile>)[key];
  return createHash("sha256")
    .update(
      JSON.stringify({
        profile,
        backend: goal.backend,
        contract: goal.executionContract,
      }),
    )
    .digest("hex");
}
export function nativeEnvironment(profile: NativeProfile): NodeJS.ProcessEnv {
  // Explicit allowlist: the parent controller's tokens and ambient API keys never propagate.
  return {
    HOME: profile.home,
    PATH: profile.path,
    CODEX_HOME: profile.codexHome,
    LANG: process.env.LANG ?? "C.UTF-8",
    ...profile.environment,
  };
}
