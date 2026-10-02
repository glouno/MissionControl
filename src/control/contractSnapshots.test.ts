import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "./git.js";
import { prepareContractSnapshot } from "./contractSnapshots.js";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-contracts-")),
    repo = join(root, "sibling");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "contract.yaml"), "contract: v1\n\n");
  await symlink("contract.yaml", join(repo, "link"));
  await writeFile(join(repo, ".env.private"), "fixture only");
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "contract",
  ]);
  t.after(() => rm(root, { recursive: true }));
  return {
    root,
    repo,
    input: {
      repositoryPath: repo,
      revision: await git(repo, ["rev-parse", "HEAD"]),
      files: ["contract.yaml"],
    },
  };
}
test("contract snapshots preserve exact pinned blobs independent of dirty sibling checkout", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "contract.yaml"), "mutable checkout");
  const snapshot = await prepareContractSnapshot(join(f.root, "snapshots"), [
    f.input,
  ]);
  assert.equal(
    await readFile(join(snapshot.path, "0/contract.yaml"), "utf8"),
    "contract: v1\n\n",
  );
  assert.equal(
    (await prepareContractSnapshot(join(f.root, "snapshots"), [f.input]))
      .digest,
    snapshot.digest,
  );
  await chmod(join(snapshot.path, "0/contract.yaml"), 0o600);
  await writeFile(join(snapshot.path, "0/contract.yaml"), "tampered");
  await assert.rejects(
    prepareContractSnapshot(join(f.root, "snapshots"), [f.input]),
    /content changed/,
  );
});
test("contract paths refuse secrets, traversal, symlinks and non-pinned revisions", async (t) => {
  const f = await fixture(t);
  for (const file of [
    ".env.private",
    "../contract.yaml",
    "/absolute",
    "folder/../contract.yaml",
    ".git/config",
    "link",
  ])
    await assert.rejects(
      prepareContractSnapshot(join(f.root, "snapshots"), [
        { ...f.input, files: [file] },
      ]),
      /Contract snapshot|regular Git blob/,
    );
  await assert.rejects(
    prepareContractSnapshot(join(f.root, "snapshots"), [
      { ...f.input, revision: "main" },
    ]),
    /pinned revision/,
  );
});
test("concurrent snapshot preparation publishes one complete verified directory", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([
    prepareContractSnapshot(join(f.root, "snapshots"), [f.input]),
    prepareContractSnapshot(join(f.root, "snapshots"), [f.input]),
  ]);
  assert.equal(results[0].path, results[1].path);
  assert.equal(
    await readFile(join(results[0].path, "0/contract.yaml"), "utf8"),
    "contract: v1\n\n",
  );
});
