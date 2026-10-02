import {
  mkdir,
  lstat,
  realpath,
  writeFile,
  readFile,
  open,
  unlink,
  chmod,
  readdir,
} from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { hostname } from "node:os";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { egressPolicySchema } from "./egressPolicy.js";

export const authEnvironmentSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
    harness: z.enum(["codex", "claude-code"]),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sessionDir: z.string().min(1),
    egress: egressPolicySchema,
    qualified: z.literal(false).default(false),
  })
  .strict();
export type AuthEnvironment = z.output<typeof authEnvironmentSchema>;
const identitySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    harness: z.enum(["codex", "claude-code"]),
    instance: z.string().uuid(),
    createdAt: z.string(),
    policyHash: z.string(),
  })
  .strict();
const writerSchema = z
  .object({
    pid: z.number().int().positive(),
    hostname: z.string(),
    nonce: z.string().uuid(),
    createdAt: z.string(),
  })
  .strict();
function contained(root: string, path: string) {
  const rel = relative(root, path);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}
export function authPolicyHash(config: AuthEnvironment) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
async function privateEntry(path: string, directory: boolean) {
  const meta = await lstat(path);
  if (
    meta.isSymbolicLink() ||
    (directory ? !meta.isDirectory() : !meta.isFile()) ||
    meta.mode & 0o077 ||
    meta.uid !== process.getuid?.() ||
    (await realpath(path)) !== path
  )
    throw new Error(
      "Authentication entries must be private, owned, regular and canonical",
    );
}
async function location(config: AuthEnvironment, secretsRoot: string) {
  const root = await realpath(secretsRoot);
  await privateEntry(root, true);
  const path = resolve(root, config.sessionDir);
  if (!contained(root, path) || path.includes(","))
    throw new Error(
      "Authentication session must be inside the explicit private secrets root",
    );
  return path;
}
/** Dedicated identity; never copies ambient native authentication/configuration. */
export async function initializeAuthEnvironment(
  input: AuthEnvironment,
  secretsRoot: string,
) {
  const config = authEnvironmentSchema.parse(input),
    path = await location(config, secretsRoot);
  // Only a direct existing canonical parent is accepted; no recursive symlink traversal.
  await privateEntry(resolve(path, ".."), true);
  await mkdir(path, { mode: 0o700, recursive: false });
  const identity = {
    schemaVersion: 1,
    id: config.id,
    harness: config.harness,
    instance: randomUUID(),
    createdAt: new Date().toISOString(),
    policyHash: authPolicyHash(config),
  };
  await writeFile(
    join(path, "identity.json"),
    JSON.stringify(identity) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await mkdir(join(path, "session"), { mode: 0o700 });
  if (config.harness === "codex")
    await mkdir(join(path, "session/tmp"), { mode: 0o700 });
  if (config.harness === "codex")
    await writeFile(
      join(path, "session/config.toml"),
      'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n',
      { flag: "wx", mode: 0o600 },
    );
  else
    await writeFile(
      join(path, "session/settings.json"),
      JSON.stringify({ disableAllHooks: true, forceLoginMethod: "claudeai" }) +
        "\n",
      { flag: "wx", mode: 0o600 },
    );
  return { initialized: true, id: config.id, qualified: false };
}
export async function inspectAuthEnvironment(
  input: AuthEnvironment,
  secretsRoot: string,
) {
  const config = authEnvironmentSchema.parse(input),
    path = await location(config, secretsRoot);
  await privateEntry(path, true);
  await privateEntry(join(path, "identity.json"), false);
  const parsedIdentity = identitySchema.safeParse(
    JSON.parse(await readFile(join(path, "identity.json"), "utf8")),
  );
  if (!parsedIdentity.success)
    throw new Error(
      "Authentication identity is malformed; inspect the private store",
    );
  const identity = parsedIdentity.data;
  if (
    identity.id !== config.id ||
    identity.harness !== config.harness ||
    identity.policyHash !== authPolicyHash(config)
  )
    throw new Error("Authentication store identity or admitted policy changed");
  const session = join(path, "session");
  await privateEntry(session, true);
  const lock = join(path, "writer.lock");
  let writer: z.output<typeof writerSchema> | undefined;
  try {
    await privateEntry(lock, false);
    writer = writerSchema.parse(JSON.parse(await readFile(lock, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { path, session, identity, writer };
}
export async function acquireAuthEnvironment(
  input: AuthEnvironment,
  secretsRoot: string,
) {
  const inspected = await inspectAuthEnvironment(input, secretsRoot),
    { path, session } = inspected;
  const lock = join(path, "writer.lock"),
    nonce = randomUUID();
  const file = await open(lock, "wx", 0o600).catch(() => {
    throw new Error(
      "Subscription identity has an active or unreconciled writer; inspect and recover explicitly",
    );
  });
  try {
    await file.writeFile(
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        nonce,
        createdAt: new Date().toISOString(),
      }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  return {
    ...inspected,
    nonce,
    release: async () => {
      await privateEntry(lock, false);
      const current = writerSchema.parse(
        JSON.parse(await readFile(lock, "utf8")),
      );
      if (current.nonce !== nonce)
        throw new Error("Auth writer ownership changed");
      await unlink(lock);
    },
    privateFiles: async () => {
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir)) {
          const file = join(dir, entry),
            meta = await lstat(file);
          if (
            meta.isSymbolicLink() ||
            (!meta.isFile() && !meta.isDirectory()) ||
            (meta.isFile() && meta.nlink !== 1) ||
            meta.uid !== process.getuid?.()
          )
            throw new Error(
              "Authentication store contains a redirected or foreign entry",
            );
          if (meta.isDirectory()) {
            await chmod(file, 0o700);
            await walk(file);
          } else await chmod(file, 0o600);
        }
      };
      await walk(session);
    },
  };
}
/** Caller must hold the application instance lock and remove recorded containers first. */
export async function recoverAuthEnvironment(
  input: AuthEnvironment,
  secretsRoot: string,
  nonce: string,
  cleanup: () => Promise<void>,
) {
  const inspected = await inspectAuthEnvironment(input, secretsRoot),
    writer = inspected.writer;
  if (!writer || writer.nonce !== nonce || writer.hostname !== hostname())
    throw new Error("Auth recovery requires the inspected local writer nonce");
  try {
    process.kill(writer.pid, 0);
    throw new Error("Authentication writer is still alive");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await cleanup();
  const current = await inspectAuthEnvironment(input, secretsRoot);
  if (current.writer?.nonce !== nonce)
    throw new Error("Auth writer changed during recovery");
  await unlink(join(inspected.path, "writer.lock"));
  return { recovered: true, id: input.id, qualified: false };
}
