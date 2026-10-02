import {
  mkdtemp,
  readFile,
  writeFile,
  lstat,
  realpath,
  rm,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { openPrivateStore, sealPrivateStore } from "./privateBundle.js";
const companionSchema = z
  .object({
    homeserver: z.string().url(),
    room_id: z.string().startsWith("!"),
    own_user: z.string().startsWith("@"),
    own_device: z.string().min(1),
    allowed_users: z.array(z.string()),
    state_dir: z.string().min(1),
    session_file: z.string().min(1),
    passphrase_file: z.string().min(1),
    controller_url: z.string().url(),
    controller_token_file: z.string().min(1),
  })
  .strict();
export async function readMatrixConfiguration(path: string) {
  const canonical = resolve(path),
    meta = await lstat(canonical);
  if (
    !meta.isFile() ||
    meta.isSymbolicLink() ||
    meta.mode & 0o077 ||
    meta.uid !== process.getuid?.() ||
    (await realpath(canonical)) !== canonical
  )
    throw Error(
      "Matrix recovery config must be a canonical private regular file",
    );
  const config = companionSchema.parse(
    JSON.parse(await readFile(canonical, "utf8")),
  );
  for (const key of [
    "state_dir",
    "session_file",
    "passphrase_file",
    "controller_token_file",
  ] as const)
    config[key] = resolve(dirname(canonical), config[key]);
  return config;
}
function identity(config: z.output<typeof companionSchema>) {
  const server = new URL(config.homeserver);
  if (server.protocol !== "https:" || server.username || server.password)
    throw Error("Matrix recovery requires credential-free HTTPS homeserver");
  return {
    homeserver: server.href,
    user: config.own_user,
    device: config.own_device,
    room: config.room_id,
  };
}
async function companion(binary: string, args: string[]) {
  const path = resolve(binary),
    meta = await lstat(path);
  if (
    !meta.isFile() ||
    meta.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    !(meta.mode & 0o100)
  )
    throw Error("Select a reviewed canonical Matrix companion executable");
  try {
    return JSON.parse(
      (
        await promisify(execFile)(path, args, {
          env: { PATH: process.env.PATH },
          maxBuffer: 65536,
          timeout: 120000,
        })
      ).stdout,
    );
  } catch {
    throw Error(
      "Offline Matrix recovery failed; sensitive companion diagnostics suppressed",
    );
  }
}
export async function backupMatrixStore(
  configFile: string,
  binary: string,
  destination: string,
  recipientFile: string,
) {
  const config = await readMatrixConfiguration(configFile),
    expected = identity(config),
    stage = await mkdtemp(join(tmpdir(), "mc-matrix-snapshot-"));
  try {
    const normalized = join(stage, "config.json"),
      snapshot = join(stage, "snapshot");
    await writeFile(normalized, JSON.stringify(config), {
      flag: "wx",
      mode: 0o600,
    });
    await companion(binary, ["snapshot", normalized, snapshot]);
    const recovered = JSON.parse(
      await readFile(join(snapshot, "recovery-identity.json"), "utf8"),
    );
    if (
      Object.entries(expected).some(([k, v]) => recovered[k] !== v) ||
      Object.keys(recovered).length !== 4
    )
      throw Error("Matrix snapshot identity mismatch");
    const result = await sealPrivateStore(
      snapshot,
      resolve(destination),
      resolve(recipientFile),
      "matrix",
      expected,
    );
    return {
      backedUp: true,
      files: result.manifest.files.length,
      bundleSha256: result.bundleSha256,
      liveQualified: false,
    };
  } finally {
    await rm(stage, { force: true, recursive: true });
  }
}
export async function restoreMatrixStore(
  configFile: string,
  binary: string,
  bundle: string,
  ageIdentity: string,
  destination: string,
) {
  const config = await readMatrixConfiguration(configFile),
    expected = identity(config),
    root = resolve(destination);
  await openPrivateStore(
    resolve(bundle),
    resolve(ageIdentity),
    root,
    "matrix",
    (manifest) => {
      if (
        Object.entries(expected).some(([k, v]) => manifest.identity[k] !== v) ||
        Object.keys(manifest.identity).length !== 4
      )
        throw Error(
          "Matrix backup permanent identity differs from configured server/account/device/room",
        );
      const paths = manifest.files.map((f) => f.path);
      if (
        ![
          "store/identity.json",
          "store/matrix-sdk-state.sqlite3",
          "store/matrix-sdk-crypto.sqlite3",
          "session.json",
          "store-passphrase",
          "recovery-identity.json",
        ].every((p) => paths.includes(p)) ||
        paths.some((p) => p.split("/").includes("writer.lock"))
      )
        throw Error("Matrix backup has invalid recovery inventory");
    },
  );
  try {
    const recovered = JSON.parse(
      await readFile(join(root, "recovery-identity.json"), "utf8"),
    );
    if (Object.entries(expected).some(([k, v]) => recovered[k] !== v))
      throw Error("Restored Matrix identity differs from encrypted manifest");
    const restored = {
        ...config,
        state_dir: join(root, "store"),
        session_file: join(root, "session.json"),
        passphrase_file: join(root, "store-passphrase"),
      },
      recoveryConfig = join(root, "connector-recovery.json");
    await writeFile(recoveryConfig, JSON.stringify(restored, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    const inspected = await companion(binary, [
      "inspect-store",
      recoveryConfig,
    ]);
    if (inspected.inspected !== true)
      throw Error("Matrix crypto restore was not inspected");
    return {
      restored: true,
      sdkInspected: true,
      crossSigned: inspected.crossSigned === true,
      liveQualified: false,
      controllerCredentialRequiresProvisioning: true,
    };
  } catch (e) {
    await rm(root, { force: true, recursive: true });
    throw e;
  }
}

/** Hold native single-writer ownership until the complete coordinated copy is sealed. */
export async function acquireMatrixSnapshot(
  configFile: string,
  binary: string,
) {
  const { spawn } = await import("node:child_process");
  const config = await readMatrixConfiguration(configFile),
    expected = identity(config);
  const path = resolve(binary),
    meta = await lstat(path);
  if (
    !meta.isFile() ||
    meta.isSymbolicLink() ||
    meta.mode & 0o022 ||
    !(meta.mode & 0o111) ||
    (await realpath(path)) !== path
  )
    throw Error("Select a canonical reviewed Matrix companion executable");
  const stage = await mkdtemp(join(tmpdir(), "mc-matrix-held-")),
    normalized = join(stage, "config.json"),
    snapshot = join(stage, "snapshot");
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<boolean> | undefined;
  let alive = false;
  try {
    await writeFile(normalized, JSON.stringify(config), {
      flag: "wx",
      mode: 0o600,
    });
    child = spawn(path, ["snapshot-held", normalized, snapshot], {
      env: { PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    });
    alive = true;
    closed = new Promise<boolean>((r) => {
      child!.once("error", () => {
        alive = false;
        r(false);
      });
      child!.once("close", (code) => {
        alive = false;
        r(code === 0);
      });
    });
    await new Promise<void>((yes, no) => {
      let output = "",
        errors = 0;
      const timer = setTimeout(
        () => no(Error("Matrix held snapshot timed out")),
        120000,
      );
      const fail = () => {
        clearTimeout(timer);
        no(
          Error(
            "Matrix held snapshot failed; inspect private ownership/identity",
          ),
        );
      };
      child!.once("error", fail);
      child!.once("close", fail);
      child!.stderr!.on("data", (b) => {
        errors += b.length;
        if (errors > 65536) {
          child!.kill("SIGKILL");
          fail();
        }
      });
      child!.stdout!.on("data", (b) => {
        output += b.toString();
        if (output.length > 65536) return fail();
        if (output.includes("\n")) {
          try {
            const result = JSON.parse(output.trim());
            if (
              result.snapshotPrepared !== true ||
              result.ownershipHeld !== true
            )
              throw Error();
          } catch {
            return fail();
          }
          clearTimeout(timer);
          yes();
        }
      });
    });
    const recorded = JSON.parse(
      await readFile(join(snapshot, "recovery-identity.json"), "utf8"),
    );
    if (
      Object.entries(expected).some(([k, v]) => recorded[k] !== v) ||
      Object.keys(recorded).length !== 4
    )
      throw Error("Matrix held snapshot identity differs");
    const assertHeld = () => {
      if (!alive)
        throw Error("Matrix ownership was lost during coordinated backup");
    };
    return {
      snapshot,
      identity: expected,
      assertHeld,
      release: async () => {
        child!.stdin!.end();
        const timer = setTimeout(() => child!.kill("SIGKILL"), 10000);
        try {
          if (!(await closed))
            throw Error("Matrix held snapshot release failed");
        } finally {
          clearTimeout(timer);
          await rm(stage, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    child?.kill("SIGKILL");
    await closed;
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
