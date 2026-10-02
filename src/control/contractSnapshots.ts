import { createHash } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  lstat,
  realpath,
  mkdtemp,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { git } from "./git.js";
import { ControlError } from "./schema.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export interface ContractSnapshot {
  path: string;
  digest: string;
  files: { path: string; revision: string; hash: string; bytes: number }[];
}
export interface SnapshotInput {
  repositoryPath: string;
  revision: string;
  files: string[];
}
const hash = (content: string | Buffer) =>
  createHash("sha256").update(content).digest("hex");
export function safeContractPath(path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p === ".git") ||
    /(^|\/)(\.env(?:\..*)?|\.ssh|\.azure|\.aws|\.codex|\.claude|credentials?|.*\.(key|pem|pfx))($|\/)/i.test(
      path,
    )
  )
    throw new ControlError(
      "contract_path",
      "Contract snapshot requires explicit non-secret relative files",
      409,
    );
}
export async function prepareContractSnapshot(
  root: string,
  inputs: SnapshotInput[],
): Promise<ContractSnapshot> {
  if (inputs.length > 10)
    throw new ControlError("context_limit", "Too many sibling contracts", 409);
  const files: ContractSnapshot["files"] = [],
    contents: { path: string; content: string }[] = [];
  let total = 0;
  for (const [index, input] of inputs.entries()) {
    if (
      !/^[a-f0-9]{40,64}$/.test(input.revision) ||
      !input.files.length ||
      input.files.length > 20
    )
      throw new ControlError(
        "contract_revision",
        "Contract files require a pinned revision",
        409,
      );
    for (const file of input.files) {
      safeContractPath(file);
      // Only ordinary blobs: never dereference a committed symlink or submodule.
      const entry = (
        await git(input.repositoryPath, [
          "ls-tree",
          "-z",
          input.revision,
          "--",
          file,
        ])
      )
        .split("\0")
        .filter(Boolean);
      if (
        entry.length !== 1 ||
        (!entry[0].startsWith("100644 blob ") &&
          !entry[0].startsWith("100755 blob ")) ||
        entry[0].slice(entry[0].indexOf("\t") + 1) !== file
      )
        throw new ControlError(
          "contract_type",
          "Contract snapshot must name a regular Git blob",
          409,
        );
      const oid = entry[0].split(" ")[2].split("\t")[0];
      // Check size before requesting content from the trusted Git wrapper.
      const bytes = Number(
        await git(input.repositoryPath, ["cat-file", "-s", oid]),
      );
      total += bytes;
      if (!Number.isSafeInteger(bytes) || bytes < 0 || total > 1024 * 1024)
        throw new ControlError(
          "context_limit",
          "Contract snapshots exceed one MiB",
          409,
        );
      const content = (
        await exec(
          "git",
          [
            "--no-replace-objects",
            "-c",
            "core.hooksPath=/dev/null",
            "cat-file",
            "blob",
            oid,
          ],
          { cwd: input.repositoryPath, maxBuffer: 1024 * 1024, timeout: 60000 },
        )
      ).stdout;
      const path = `${index}/${file}`;
      if (files.some((f) => f.path === path))
        throw new ControlError("contract_path", "Duplicate contract file", 409);
      files.push({
        path,
        revision: input.revision,
        hash: hash(content),
        bytes: Buffer.byteLength(content),
      });
      contents.push({ path, content });
    }
  }
  const digest = hash(JSON.stringify(files));
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await realpath(root)) !== resolve(root))
    throw new ControlError("contract_path", "Snapshot root is redirected", 409);
  const path = join(root, digest);
  const present = await lstat(path).catch(() => null);
  if (present) {
    if (
      !present.isDirectory() ||
      present.isSymbolicLink() ||
      (await realpath(path)) !== path
    )
      throw new ControlError(
        "contract_path",
        "Snapshot path is redirected",
        409,
      );
    const manifest = JSON.parse(
      await readFile(join(path, "manifest.json"), "utf8"),
    );
    if (
      JSON.stringify(manifest.files) !== JSON.stringify(files) ||
      manifest.digest !== digest
    )
      throw new ControlError(
        "contract_integrity",
        "Snapshot manifest changed",
        409,
      );
    for (const file of files) {
      const target = join(path, file.path);
      if (
        (await realpath(target)) !== target ||
        !(await lstat(target)).isFile() ||
        hash(await readFile(target)) !== file.hash
      )
        throw new ControlError(
          "contract_integrity",
          "Snapshot content changed",
          409,
        );
    }
    return { path, digest, files };
  }
  const staging = await mkdtemp(join(root, ".preparing-"));
  try {
    for (const file of contents) {
      await mkdir(dirname(join(staging, file.path)), { recursive: true });
      await writeFile(join(staging, file.path), file.content, {
        mode: 0o444,
        flag: "wx",
      });
    }
    await writeFile(
      join(staging, "manifest.json"),
      JSON.stringify({ digest, files }, null, 2),
      { mode: 0o444, flag: "wx" },
    );
    try {
      await rename(staging, path);
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      return await prepareContractSnapshot(root, inputs);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { path, digest, files };
}
