import { readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return !!rel && !rel.startsWith("../") && rel !== ".." && !isAbsolute(rel);
}
/** Keep the worktree pointer relative; Git 2.43 still needs absolute backlinks. */
export async function portableWorktreeLink(
  repository: string,
  workspace: string,
) {
  let root = resolve(repository);
  while (!existsSync(join(root, "instance.json"))) {
    const parent = dirname(root);
    if (parent === root) return;
    root = parent;
  }
  workspace = resolve(workspace);
  if (!inside(root, workspace))
    throw new Error("Application worktree must stay inside instance state");
  const pointer = join(workspace, ".git"),
    meta = await lstat(pointer);
  if (!meta.isFile() || meta.isSymbolicLink())
    throw new Error("Application worktree metadata must be a regular pointer");
  const value = await readFile(pointer, "utf8");
  if (!value.startsWith("gitdir: "))
    throw new Error("Invalid worktree Git pointer");
  const gitdir = resolve(workspace, value.slice(8).trim()),
    backlink = join(gitdir, "gitdir");
  if (
    !inside(root, gitdir) ||
    (await realpath(gitdir)) !== gitdir ||
    (await lstat(gitdir)).isSymbolicLink()
  )
    throw new Error("Worktree Git metadata escapes instance state");
  const back = await lstat(backlink);
  if (
    !back.isFile() ||
    back.isSymbolicLink() ||
    resolve(gitdir, (await readFile(backlink, "utf8")).trim()) !== pointer
  )
    throw new Error("Worktree backlink does not match owned source");
  await writeFile(pointer, `gitdir: ${relative(workspace, gitdir)}\n`, {
    mode: 0o600,
  });
  await writeFile(backlink, pointer + "\n", { mode: 0o600 });
}

/** Offline repair in an isolated instance after inventory/hash verification. */
export async function repairWorktreeLinks(root: string, paths: string[]) {
  root = resolve(root);
  if ((await realpath(root)) !== root)
    throw new Error("Recovery state root is redirected");
  const repairs: { backlink: string; pointer: string }[] = [];
  for (const path of paths) {
    if (!inside(root, path))
      throw new Error("Recovery workspace escapes instance state");
    const pointer = join(path, ".git");
    const info = await lstat(pointer).catch((e) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (!info) continue;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (await realpath(path)) !== path
    )
      throw new Error(
        "Recovery worktree pointer must be regular and canonical",
      );
    const value = await readFile(pointer, "utf8");
    if (!value.startsWith("gitdir: "))
      throw new Error("Invalid recovery Git pointer");
    const ref = value.slice(8).trim();
    if (isAbsolute(ref))
      throw new Error(
        "Recovery requires relative worktree pointers; retain old alpha privately",
      );
    const gitdir = resolve(path, ref),
      backlink = join(gitdir, "gitdir");
    if (
      !inside(join(root, "repositories"), gitdir) ||
      (await realpath(gitdir)) !== gitdir
    )
      throw new Error(
        "Recovery Git metadata must be in owned repository state",
      );
    const meta = await lstat(backlink);
    if (!meta.isFile() || meta.isSymbolicLink())
      throw new Error("Recovery backlink must be a regular file");
    const common = resolve(
      gitdir,
      (await readFile(join(gitdir, "commondir"), "utf8")).trim(),
    );
    if (
      !inside(join(root, "repositories"), common) ||
      (await realpath(common)) !== common
    )
      throw new Error("Recovery common Git directory escapes state");
    repairs.push({ backlink, pointer });
  }
  // Validate all links before changing any. Replay is idempotent after interruption.
  for (const repair of repairs)
    await writeFile(repair.backlink, repair.pointer + "\n", { mode: 0o600 });
  return { repaired: repairs.length };
}
