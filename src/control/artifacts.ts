import { open, lstat, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { constants } from "node:fs";
import { ControlError } from "./schema.js";
/** Read through the verified descriptor; evidence never grants filesystem access. */
export async function readArtifact(
  stateRoot: string,
  location: string,
  maxBytes = 8 * 1024 * 1024,
) {
  const root = resolve(stateRoot);
  if ((await realpath(root)) !== root || (await lstat(root)).isSymbolicLink())
    throw new ControlError(
      "artifact_path",
      "Instance state root is redirected",
      409,
    );
  if (
    isAbsolute(location) ||
    location.includes("\\") ||
    location.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new ControlError(
      "artifact_path",
      "Artifact requires an instance-relative path",
      409,
    );
  const path = resolve(root, location),
    rel = relative(root, path);
  if (
    !rel ||
    rel.startsWith("../") ||
    isAbsolute(rel) ||
    (await realpath(path)) !== path
  )
    throw new ControlError(
      "artifact_path",
      "Artifact path is outside canonical instance state",
      409,
    );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const meta = await file.stat();
    if (!meta.isFile() || meta.size > maxBytes)
      throw new ControlError(
        "artifact_limit",
        "Artifact must be a bounded regular file",
        413,
      );
    // Canonical lookup and descriptor must still identify the same object.
    const current = await lstat(path);
    if (
      current.isSymbolicLink() ||
      meta.dev !== current.dev ||
      meta.ino !== current.ino ||
      (await realpath(path)) !== path
    )
      throw new ControlError(
        "artifact_path",
        "Artifact changed during access",
        409,
      );
    const bytes = Buffer.alloc(meta.size + 1),
      read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > maxBytes || read.bytesRead !== meta.size)
      throw new ControlError(
        "artifact_limit",
        "Artifact changed or exceeded the read bound",
        409,
      );
    return bytes.subarray(0, read.bytesRead);
  } finally {
    await file.close();
  }
}
