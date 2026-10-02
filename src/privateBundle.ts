import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  rm,
  mkdtemp,
  realpath,
  readdir,
  open,
  link,
} from "node:fs/promises";
import { resolve, relative, isAbsolute, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { z } from "zod";

const fileSchema = z
  .object({
    path: z.string(),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.union([z.literal(0o600), z.literal(0o700)]),
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal("missioncontrol-private-store-v1"),
    kind: z.enum(["subscription", "matrix", "recovery-set"]),
    applicationVersion: z.literal("1.0.0-alpha.0"),
    createdAt: z.string().datetime(),
    identity: z.record(z.string(), z.string()),
    directories: z.array(z.string()).max(100000),
    files: z.array(fileSchema).max(100000),
  })
  .strict();
export type PrivateBundleManifest = z.output<typeof manifestSchema>;
function pathCheck(path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw Error("Unsafe private store inventory path");
}
function inside(root: string, path: string) {
  const r = relative(root, path);
  return r !== "" && r !== ".." && !r.startsWith("../") && !isAbsolute(r);
}
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  throw Error("Private store destination must be new");
}
async function privateEntry(path: string, directory: boolean) {
  const s = await lstat(path);
  if (
    (directory ? !s.isDirectory() : !s.isFile()) ||
    s.isSymbolicLink() ||
    s.mode & 0o077 ||
    s.uid !== process.getuid?.() ||
    (await realpath(path)) !== path
  )
    throw Error(
      "Private store entries must be owned, canonical and restrictive",
    );
  return s;
}
async function hash(path: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
async function transformAge(args: string[], input: Readable, output: string) {
  const child = spawn("age", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH },
    }),
    closed = once(child, "close");
  let errors = 0;
  child.stderr.on("data", (b) => {
    errors += b.length;
    if (errors > 64000) child.kill();
  });
  try {
    await Promise.all([
      pipeline(input, child.stdin),
      pipeline(
        child.stdout,
        createWriteStream(output, { flags: "wx", mode: 0o600 }),
      ),
    ]);
    const [code] = await closed;
    if (code !== 0)
      throw Error(
        "Private bundle encryption/decryption failed; sensitive diagnostics suppressed",
      );
  } catch (e) {
    child.kill();
    await closed.catch(() => {});
    await rm(output, { force: true });
    throw e;
  }
}
/** Caller exclusively owns a stopped store for the whole copy. No locks enter recovery. */
export async function sealPrivateStore(
  source: string,
  destination: string,
  recipientFile: string,
  kind: PrivateBundleManifest["kind"],
  identity: Record<string, string>,
  excluded: string[] = [],
) {
  const root = resolve(source),
    output = resolve(destination);
  await privateEntry(root, true);
  if (output === root || inside(root, output))
    throw Error("Private bundle must be outside its store");
  await absent(output);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await privateEntry(dirname(output), true);
  const recipient = (await readFile(recipientFile, "utf8")).trim();
  if (!/^age1[0-9a-z]{58}$/.test(recipient))
    throw Error("Expected one age public recipient in recipient file");
  const stage = await mkdtemp(join(tmpdir(), "mc-private-backup-")),
    files: PrivateBundleManifest["files"] = [],
    directories: string[] = [];
  try {
    const walk = async (dir: string) => {
      for (const name of (await readdir(dir)).sort()) {
        const from = join(dir, name),
          path = relative(root, from);
        pathCheck(path);
        if (excluded.some((x) => path === x || path.startsWith(x + "/")))
          continue;
        const stat = await lstat(from);
        await privateEntry(from, stat.isDirectory());
        if (stat.isDirectory()) {
          directories.push(path);
          await mkdir(join(stage, path), { mode: 0o700, recursive: true });
          await walk(from);
        } else {
          const to = join(stage, path);
          await mkdir(dirname(to), { recursive: true, mode: 0o700 });
          await pipeline(
            createReadStream(from),
            createWriteStream(to, { flags: "wx", mode: 0o600 }),
          );
          files.push({
            path,
            bytes: (await lstat(to)).size,
            mode: stat.mode & 0o100 ? 0o700 : 0o600,
            sha256: await hash(to),
          });
        }
      }
    };
    await walk(root);
    const manifest = manifestSchema.parse({
        format: "missioncontrol-private-store-v1",
        kind,
        applicationVersion: "1.0.0-alpha.0",
        createdAt: new Date().toISOString(),
        identity,
        directories,
        files,
      }),
      header = Buffer.from(JSON.stringify(manifest));
    if (header.length > 4 * 1024 ** 2)
      throw Error("Private store manifest too large");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    async function* data() {
      yield length;
      yield header;
      for (const f of files)
        for await (const chunk of createReadStream(join(stage, f.path)))
          yield chunk;
    }
    const encrypted = join(stage, "encrypted");
    await transformAge(
      ["-e", "-r", recipient],
      Readable.from(data()),
      encrypted,
    );
    // Link is exclusive at the destination; staging may live on another device.
    const outputStage = await mkdtemp(join(dirname(output), ".mc-sealed-"));
    try {
      const partial = join(outputStage, "bundle");
      await pipeline(
        createReadStream(encrypted),
        createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      );
      await link(partial, output);
    } finally {
      await rm(outputStage, { recursive: true, force: true });
    }
    return { manifest, bundleSha256: await hash(output) };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
/** Validate the encrypted inventory and expected identity before creating a new store. */
export async function openPrivateStore(
  bundle: string,
  identityFile: string,
  destination: string,
  kind: PrivateBundleManifest["kind"],
  validate: (manifest: PrivateBundleManifest) => void,
) {
  const root = resolve(destination);
  await absent(root);
  await privateEntry(dirname(root), true);
  await privateEntry(resolve(identityFile), false);
  const stage = await mkdtemp(join(tmpdir(), "mc-private-restore-")),
    plaintext = join(stage, "bundle");
  let created = false;
  try {
    await transformAge(
      ["-d", "-i", resolve(identityFile)],
      createReadStream(bundle),
      plaintext,
    );
    const fd = await open(plaintext, "r");
    try {
      const length = Buffer.alloc(4);
      if ((await fd.read(length, 0, 4, 0)).bytesRead !== 4)
        throw Error("Truncated private bundle");
      const size = length.readUInt32BE();
      if (size > 4 * 1024 ** 2) throw Error("Private manifest too large");
      const header = Buffer.alloc(size);
      if ((await fd.read(header, 0, size, 4)).bytesRead !== size)
        throw Error("Truncated private manifest");
      const manifest = manifestSchema.parse(JSON.parse(header.toString()));
      if (manifest.kind !== kind) throw Error("Private store kind mismatch");
      validate(manifest);
      const paths = new Set<string>();
      let offset = 4 + size;
      for (const path of manifest.directories) {
        pathCheck(path);
        if (paths.has(path)) throw Error("Duplicate private inventory entry");
        paths.add(path);
      }
      for (const f of manifest.files) {
        pathCheck(f.path);
        if (paths.has(f.path)) throw Error("Duplicate private inventory entry");
        paths.add(f.path);
        offset += f.bytes;
        if (!Number.isSafeInteger(offset))
          throw Error("Private inventory size overflow");
      }
      const filePaths = new Set(manifest.files.map((f) => f.path));
      for (const path of paths) {
        const segments = path.split("/");
        for (let i = 1; i < segments.length; i++)
          if (filePaths.has(segments.slice(0, i).join("/")))
            throw Error("Private inventory has conflicting paths");
      }
      if (offset !== (await lstat(plaintext)).size)
        throw Error("Private inventory byte count mismatch");
      await mkdir(root, { mode: 0o700 });
      created = true;
      for (const path of manifest.directories)
        await mkdir(join(root, path), { mode: 0o700, recursive: true });
      offset = 4 + size;
      for (const f of manifest.files) {
        const to = join(root, f.path);
        await mkdir(dirname(to), { mode: 0o700, recursive: true });
        if (f.bytes)
          await pipeline(
            createReadStream(plaintext, {
              start: offset,
              end: offset + f.bytes - 1,
            }),
            createWriteStream(to, { flags: "wx", mode: f.mode }),
          );
        else await writeFile(to, "", { flag: "wx", mode: f.mode });
        offset += f.bytes;
        if ((await hash(to)) !== f.sha256)
          throw Error("Private store hash verification failed");
      }
      return { manifest, bundleSha256: await hash(bundle) };
    } finally {
      await fd.close();
    }
  } catch (e) {
    if (created) await rm(root, { force: true, recursive: true });
    throw e;
  } finally {
    await rm(stage, { force: true, recursive: true });
  }
}
