import { createHash } from "node:crypto";
import { z } from "zod";
import { git } from "./git.js";
import { safeContractPath } from "./contractSnapshots.js";
import { ControlError } from "./schema.js";
export const environmentManifestSchema = z.object({
  projectId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  recipeVersion: z.string().min(1),
  toolchains: z.record(z.string(), z.string().min(1)),
  dependencyFiles: z.array(z.string().min(1)).min(1).max(100),
  instructions: z.array(z.string().min(1)).min(1),
  checks: z.array(z.string().min(1)).min(1),
  imageDigest: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  network: z.literal("gateway-only").default("gateway-only"),
  enabled: z.literal(false).default(false),
});
export type EnvironmentManifest = z.output<typeof environmentManifestSchema>;
export async function resolveEnvironmentManifest(
  manifest: EnvironmentManifest,
  repositoryPath: string,
  revision: string,
  recipe: string,
) {
  manifest = environmentManifestSchema.parse(manifest);
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new ControlError(
      "environment_revision",
      "Environment inputs require pinned commit",
      409,
    );
  const dependencies = [];
  for (const path of [...manifest.dependencyFiles].sort()) {
    safeContractPath(path);
    const entry = (
      await git(repositoryPath, ["ls-tree", "-z", revision, "--", path])
    )
      .split("\0")
      .filter(Boolean);
    if (
      entry.length !== 1 ||
      !/^100(644|755) blob /.test(entry[0]) ||
      entry[0].slice(entry[0].indexOf("\t") + 1) !== path
    )
      throw new ControlError(
        "environment_dependency",
        "Image dependency input is missing or not a regular blob",
        409,
      );
    dependencies.push({ path, blob: entry[0].split(" ")[2].split("\t")[0] });
  }
  const inputs = {
    recipeVersion: manifest.recipeVersion,
    recipeHash: createHash("sha256").update(recipe).digest("hex"),
    toolchains: manifest.toolchains,
    dependencies,
  };
  return {
    ...manifest,
    revision,
    inputs,
    version: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"),
    ready: !!manifest.imageDigest,
  };
}
