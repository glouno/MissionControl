import {z} from "zod";
import {realpath,lstat,readFile} from "node:fs/promises";
import {resolve,relative,isAbsolute} from "node:path";
export const secretReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("env"), name: z.string().regex(/^[A-Z][A-Z0-9_]+$/) }).strict(),
  z.object({ kind: z.literal("file"), path: z.string().min(1) }).strict(),
]);
function within(root:string,path:string){const r=relative(root,path);return r===""||(!r.startsWith("..")&&!isAbsolute(r))}
export async function readSecret(ref: z.output<typeof secretReferenceSchema>, secretsDir: string): Promise<string> {
  if (ref.kind === "env") { const v = process.env[ref.name]; if (!v) throw new Error(`Credential environment reference ${ref.name} is unavailable`); return v; }
  const root = await realpath(secretsDir), path = resolve(root, ref.path), info = await lstat(path);
  if (!within(root, path) || info.isSymbolicLink() || !info.isFile() || !within(root, await realpath(path)) || (info.mode & 0o077)) throw new Error("Secret file must be private, regular, and inside secretsDir");
  const value = (await readFile(path, "utf8")).trim(); if (!value) throw new Error("Secret file is empty"); return value;
}
