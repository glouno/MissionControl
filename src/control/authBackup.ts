import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ControlStore } from "./store.js";
import {
  acquireAuthEnvironment,
  inspectAuthEnvironment,
  type AuthEnvironment,
} from "./authEnvironment.js";
import { sealPrivateStore, openPrivateStore } from "../privateBundle.js";
function idle(store: ControlStore, config: AuthEnvironment) {
  const runs = store.setting("subscription-auth-runs") as
    { authId: string; status: string }[] | undefined;
  if (runs?.some((r) => r.authId === config.id && r.status !== "stopped"))
    throw Error(
      "Recover recorded authentication containers before store backup/restore",
    );
}
/** Explicit offline maintenance; caller holds application ownership. */
export async function backupAuthStore(
  store: ControlStore,
  config: AuthEnvironment,
  secretsRoot: string,
  destination: string,
  recipientFile: string,
) {
  idle(store, config);
  const owner = await acquireAuthEnvironment(config, secretsRoot);
  try {
    const result = await sealPrivateStore(
      owner.path,
      destination,
      recipientFile,
      "subscription",
      {
        id: owner.identity.id,
        harness: owner.identity.harness,
        instance: owner.identity.instance,
        policyHash: owner.identity.policyHash,
      },
      ["writer.lock", "session/tmp"],
    );
    return {
      backedUp: true,
      id: config.id,
      storeInstance: owner.identity.instance,
      files: result.manifest.files.length,
      bundleSha256: result.bundleSha256,
      qualified: false,
    };
  } finally {
    await owner.release();
  }
}
export async function restoreAuthStore(
  store: ControlStore,
  config: AuthEnvironment,
  secretsRoot: string,
  bundle: string,
  identityFile: string,
) {
  idle(store, config);
  // Derive expected policy without initializing or importing ambient sessions.
  const { createHash } = await import("node:crypto"),
    { resolve, relative, isAbsolute } = await import("node:path");
  const root = resolve(secretsRoot),
    path = resolve(root, config.sessionDir),
    rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw Error("Restore session must be inside dedicated secrets root");
  const expectedHash = createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex");
  const recovered = await openPrivateStore(
    bundle,
    identityFile,
    path,
    "subscription",
    (manifest) => {
      if (
        manifest.identity.id !== config.id ||
        manifest.identity.harness !== config.harness ||
        manifest.identity.policyHash !== expectedHash
      )
        throw Error(
          "Authentication backup differs from admitted identity/policy",
        );
      if (
        !manifest.files.some((f) => f.path === "identity.json") ||
        !manifest.directories.includes("session") ||
        [...manifest.files.map((f) => f.path), ...manifest.directories].some(
          (p) =>
            p === "writer.lock" ||
            p.startsWith("writer.lock/") ||
            p === "session/tmp" ||
            p.startsWith("session/tmp/"),
        )
      )
        throw Error("Authentication backup has invalid recovery entries");
    },
  );
  try {
    if (config.harness === "codex")
      await mkdir(join(path, "session/tmp"), { mode: 0o700 });
    const restored = await inspectAuthEnvironment(config, root);
    if (restored.writer) throw Error("Restored store has a writer lock");
    if (restored.identity.instance !== recovered.manifest.identity.instance)
      throw Error("Restored session identity differs from encrypted manifest");
    return {
      restored: true,
      id: config.id,
      storeInstance: restored.identity.instance,
      reauthenticationMayBeRequired: true,
      qualified: false,
    };
  } catch (e) {
    await rm(path, { force: true, recursive: true });
    throw e;
  }
}
