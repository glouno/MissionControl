import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const tool = new URL("../scripts/release-archive.py", import.meta.url).pathname;
async function call(action: string, path: string, spec: any) {
  const p = exec("python3", [tool, action, path]);
  p.child.stdin!.end(JSON.stringify(spec));
  return p;
}
test("release archives normalize host metadata and reject altered, duplicate, linked or privileged members", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-release-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("Synthetic source");
  await writeFile(join(root, "sample.txt"), bytes);
  const spec = {
    root,
    epoch: 1000000000,
    files: [
      {
        path: "sample.txt",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  const first = join(root, "one.tar.gz"),
    second = join(root, "two.tar.gz");
  await call("create", first, spec);
  await call("create", second, spec);
  assert.deepEqual(await readFile(first), await readFile(second));
  await call("verify", first, spec);
  for (const fault of [
    "content",
    "duplicate",
    "symlink",
    "owner",
    "mode",
    "traversal",
  ]) {
    const path = join(root, fault + ".tar.gz");
    await exec("python3", [
      "-c",
      `import io,tarfile,sys\np,f=sys.argv[1:]\nwith tarfile.open(p,'w:gz') as a:\n h=tarfile.TarInfo('../sample.txt' if f=='traversal' else 'sample.txt');h.size=16;h.mode=0o644;h.mtime=1000000000\n if f=='owner':h.uname='synthetic-private-owner'\n if f=='mode':h.mode=0o4755\n if f=='symlink':h.type=tarfile.SYMTYPE;h.linkname='/private';h.size=0\n a.addfile(h,io.BytesIO(b'Changed content!' if f=='content' else b'Synthetic source'))\n if f=='duplicate':a.addfile(h,io.BytesIO(b'Synthetic source'))`,
      path,
      fault,
    ]);
    await assert.rejects(call("verify", path, spec), /validation failed/);
  }
});
