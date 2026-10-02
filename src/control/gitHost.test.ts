import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.js";
import { GithubHost } from "./gitHost.js";
import { goalSchema, type Goal } from "./schema.js";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git"),
    repo = join(root, "repo");
  await mkdir(remote);
  await mkdir(repo);
  await git(remote, ["init", "--bare"]);
  await git(repo, ["init", "-b", "development"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@localhost"]);
  await writeFile(join(repo, "base"), "base");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  const targetSha = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "origin", "development"]);
  await git(repo, ["switch", "-c", "missioncontrol/goal/integration"]);
  await writeFile(join(repo, "change"), "change");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "change"]);
  const candidateSha = await git(repo, ["rev-parse", "HEAD"]);
  const goal: Goal = {
    id: "goal",
    revision: 1,
    planRevision: 1,
    status: "publishing",
    createdAt: new Date().toISOString(),
    config: goalSchema.parse({
      title: "Goal",
      description: "Goal",
      publicationSummary: { title: "Synthetic public change", body: "Synthetic implementation verified against its configured checks." },
      repoPath: repo,
      backend: { kind: "fake" },
      policy: {
        publish: true,
        autoMerge: true,
        productionDeploymentExcluded: true,
        requiredChecks: ["quality"],
      },
    }),
  };
  return {
    repo,
    goal,
    branch: "missioncontrol/goal/integration",
    evidence: { targetSha, candidateSha },
  };
}
function command(f: Awaited<ReturnType<typeof fixture>>, overrides: any = {}) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list")
      return JSON.stringify([
        {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          state: overrides.state ?? "OPEN",
        },
      ]);
    if (args[0] === "repo")
      return JSON.stringify({ nameWithOwner: "test/repo" });
    if (args[0] === "api" && args[1].includes("/pulls/"))
      return JSON.stringify({
        base: { sha: overrides.base ?? f.evidence.targetSha },
      });
    if (args[0] === "api")
      return JSON.stringify(
        overrides.protection ?? {
          required_status_checks: { strict: true, contexts: ["quality"] },
          enforce_admins: { enabled: true },
        },
      );
    if (args[0] === "pr" && args[1] === "view")
      return JSON.stringify({
        state: overrides.state ?? "OPEN",
        headRefOid: overrides.head ?? f.evidence.candidateSha,
        baseRefOid: overrides.base ?? f.evidence.targetSha,
        isDraft: false,
        statusCheckRollup: overrides.checks ?? [
          { name: "quality", conclusion: "SUCCESS" },
        ],
        mergeCommit: overrides.mergeCommit,
      });
    return "";
  };
  return { run, calls };
}
test("moving base, head, failing checks and missing strict protection prevent automatic merge", async (t) => {
  const f = await fixture(t);
  for (const overrides of [
    { base: "a".repeat(40) },
    { head: "b".repeat(40) },
    { checks: [] },
    {
      protection: {
        required_status_checks: { strict: false, contexts: ["quality"] },
      },
    },
  ]) {
    const fake = command(f, overrides);
    await assert.rejects(
      new GithubHost(fake.run).publish(f.goal, f.repo, f.branch, f.evidence),
    );
    assert.equal(
      fake.calls.some((c) => c[0] === "pr" && c[1] === "merge"),
      false,
    );
    assert.equal(
      fake.calls.some((c) => c[0] === "pr" && c[1] === "create"),
      false,
    );
  }
});
test("closed PR and mismatched historical merge never create duplicates or report completion", async (t) => {
  const f = await fixture(t);
  for (const overrides of [
    { state: "CLOSED" },
    {
      state: "MERGED",
      head: "a".repeat(40),
      mergeCommit: { oid: f.evidence.targetSha },
    },
  ]) {
    const fake = command(f, overrides);
    await assert.rejects(
      new GithubHost(fake.run).publish(f.goal, f.repo, f.branch, f.evidence),
    );
    assert.equal(
      fake.calls.some((c) => c[1] === "create"),
      false,
    );
  }
});
test("merged PR recovery verifies immutable parents and tree even after development advances", async (t) => {
  const f = await fixture(t);
  await git(f.repo, ["switch", "development"]);
  await git(f.repo, ["merge", "--no-ff", "--no-edit", f.branch]);
  const merged = await git(f.repo, ["rev-parse", "HEAD"]);
  await writeFile(join(f.repo, "later"), "later");
  await git(f.repo, ["add", "."]);
  await git(f.repo, ["commit", "-m", "later"]);
  await git(f.repo, ["push", "origin", "development"]);
  await git(f.repo, ["switch", f.branch]);
  const fake = command(f, { state: "MERGED", mergeCommit: { oid: merged } });
  assert.equal(
    (
      await new GithubHost(fake.run).publish(
        f.goal,
        f.repo,
        f.branch,
        f.evidence,
      )
    ).merged,
    true,
  );
  assert.equal(
    fake.calls.some((c) => c[1] === "create" || c[1] === "merge"),
    false,
  );
});
