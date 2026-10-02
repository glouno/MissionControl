import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readArtifact } from "./artifacts.js";
import { ControlError } from "./schema.js";

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().min(1),
    sourceCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    archive: z
      .object({
        path: z.literal("source.tar.gz"),
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .passthrough();

/** Only installation assets can deliver source, never paths supplied by callers. */
export async function releaseSource(
  packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
) {
  try {
    const root = join(packageRoot, "assets");
    const manifest = manifestSchema.parse(
      JSON.parse(
        (
          await readArtifact(root, "source-manifest.json", 1024 * 1024)
        ).toString("utf8"),
      ),
    );
    const bytes = await readArtifact(root, "source.tar.gz", 32 * 1024 * 1024);
    if (
      bytes.length !== manifest.archive.bytes ||
      createHash("sha256").update(bytes).digest("hex") !==
        manifest.archive.sha256
    )
      throw new Error("Source fingerprint mismatch");
    return {
      bytes,
      info: {
        version: manifest.version,
        sourceCommit: manifest.sourceCommit,
        sha256: manifest.archive.sha256,
        bytes: bytes.length,
      },
    };
  } catch {
    throw new ControlError(
      "source_unavailable",
      "Matching reviewed release source is unavailable in this installation",
      409,
    );
  }
}
