import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Goal } from "./schema.js";
import { ControlError } from "./schema.js";
import { git } from "./workspaces.js";
const exec = promisify(execFile);
export interface GitHost {
  publish(
    goal: Goal,
    workspace: string,
    branch: string,
    evidence?: { targetSha: string; candidateSha: string },
  ): Promise<{ url: string; merged: boolean }>;
}
export class GithubHost implements GitHost {
  constructor(
    readonly command?: (args: string[], workspace: string) => Promise<string>,
  ) {}
  async publish(
    g: Goal,
    workspace: string,
    branch: string,
    evidence?: { targetSha: string; candidateSha: string },
  ) {
    const policy = g.config.policy;
    if (!policy.publish)
      throw new ControlError("policy", "Publication not authorized");
    const summary = g.config.publicationSummary;
    if (!summary) throw new ControlError("publication_summary", "An explicit reviewed public title and summary are required before publication", 409);
    if (policy.autoMerge && !policy.productionDeploymentExcluded)
      throw new ControlError(
        "policy",
        "Production deployment must be excluded",
      );
    await this.checkWorkflows(workspace, policy.targetBranch);
    const gh = async (args: string[]) => {
      if (this.command) return this.command(args, workspace);
      return (
        await exec("gh", args, {
          cwd: workspace,
          timeout: 120000,
          maxBuffer: 2000000,
        })
      ).stdout.trim();
    };
    const verifiedHead = await git(workspace, ["rev-parse", "HEAD"]);
    if (
      policy.autoMerge &&
      (!evidence || evidence.candidateSha !== verifiedHead)
    )
      throw new ControlError(
        "freshness_policy",
        "Automatic merging requires current-target verification evidence",
        409,
      );
    await git(workspace, ["push", "-u", "origin", branch]);
    const list = JSON.parse(
      await gh([
        "pr",
        "list",
        "--head",
        branch,
        "--base",
        policy.targetBranch,
        "--state",
        "all",
        "--json",
        "number,url,state,isDraft,headRefOid",
      ]),
    );
    let pr = list[0];
    if (!pr) {
      const body = summary.body;
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const directory = await mkdtemp(join(tmpdir(), "mc-pr-"));
      const file = join(directory, "body.md");
      await writeFile(file, body, { mode: 0o600 });
      try {
        const url = await gh([
          "pr",
          "create",
          "--head",
          branch,
          "--base",
          policy.targetBranch,
          "--title",
          summary.title,
          "--body-file",
          file,
          ...(policy.autoMerge ? [] : ["--draft"]),
        ]);
        pr = { url, number: url.split("/").at(-1), state: "OPEN" };
      } finally {
        const { rm } = await import("node:fs/promises");
        await rm(directory, { recursive: true, force: true });
      }
    }
    const confirmMerge = async () => {
      const info = JSON.parse(
        await gh([
          "pr",
          "view",
          String(pr.number),
          "--json",
          "state,headRefOid,mergeCommit",
        ]),
      );
      if (info.state !== "MERGED") return false;
      if (info.headRefOid !== verifiedHead || !info.mergeCommit?.oid)
        throw new ControlError(
          "stale_pr",
          "Merged PR does not match recorded candidate",
          409,
        );
      await git(workspace, ["fetch", "origin", info.mergeCommit.oid]);
      const parents = (
        await git(workspace, [
          "show",
          "-s",
          "--format=%P",
          info.mergeCommit.oid,
        ])
      ).split(" ");
      if (
        !parents.includes(verifiedHead) ||
        (evidence && !parents.includes(evidence.targetSha))
      )
        throw new ControlError(
          "stale_pr",
          "Merge parents differ from verified head/base",
          409,
        );
      if (
        (await git(workspace, [
          "rev-parse",
          `${info.mergeCommit.oid}^{tree}`,
        ])) !== (await git(workspace, ["rev-parse", `${verifiedHead}^{tree}`]))
      )
        throw new ControlError(
          "stale_pr",
          "Merge tree differs from verified candidate",
          409,
        );
      return true;
    };
    if (pr.state === "MERGED")
      return { url: pr.url, merged: await confirmMerge() };
    if (pr.state === "CLOSED")
      throw new ControlError(
        "closed_pr",
        "Goal PR was closed; human decision needed",
        409,
      );
    if (policy.autoMerge) {
      const head = await git(workspace, ["rev-parse", "HEAD"]);
      const info = JSON.parse(
        await gh([
          "pr",
          "view",
          String(pr.number),
          "--json",
          "headRefOid,statusCheckRollup,isDraft",
        ]),
      );
      if (info.headRefOid !== head)
        throw new ControlError(
          "stale_pr",
          "PR head differs from verified commit",
          409,
        );
      const repository = JSON.parse(
        await gh(["repo", "view", "--json", "nameWithOwner"]),
      ).nameWithOwner;
      const remotePr = JSON.parse(
        await gh(["api", `repos/${repository}/pulls/${pr.number}`]),
      );
      if (remotePr.base?.sha !== evidence!.targetSha)
        throw new ControlError(
          "stale_base",
          "Development advanced after candidate verification",
          409,
        );
      let protection: any;
      try {
        protection = JSON.parse(
          await gh([
            "api",
            `repos/${repository}/branches/${encodeURIComponent(policy.targetBranch)}/protection`,
          ]),
        );
      } catch {
        throw new ControlError(
          "freshness_policy",
          "Cannot verify strict branch protection; PR remains reviewable",
          409,
        );
      }
      const required = protection.required_status_checks;
      const names = [
        ...(required?.contexts ?? []),
        ...(required?.checks ?? []).map((c: any) => c.context),
      ];
      if (
        !required?.strict ||
        !protection.enforce_admins?.enabled ||
        !policy.requiredChecks.length ||
        !policy.requiredChecks.every((name) => names.includes(name))
      )
        throw new ControlError(
          "freshness_policy",
          "Strict enforced up-to-date CI checks are required for automatic merging",
          409,
        );
      if (info.isDraft) await gh(["pr", "ready", String(pr.number)]);
      const checks = info.statusCheckRollup ?? [];
      for (const name of policy.requiredChecks) {
        const check = checks.find((c: any) => (c.name ?? c.context) === name);
        if (
          !check ||
          !(check.conclusion === "SUCCESS" || check.state === "SUCCESS")
        )
          throw new ControlError(
            "checks_pending",
            `Required check ${name} is not passing`,
            409,
          );
      }
      if (
        checks.some(
          (c: any) =>
            c.status === "IN_PROGRESS" ||
            c.status === "QUEUED" ||
            [
              "FAILURE",
              "ERROR",
              "CANCELLED",
              "TIMED_OUT",
              "ACTION_REQUIRED",
            ].includes(c.conclusion ?? c.state),
        )
      )
        throw new ControlError(
          "checks_pending",
          "GitHub checks are pending or failing",
          409,
        );
      await gh([
        "pr",
        "merge",
        String(pr.number),
        "--merge",
        "--match-head-commit",
        head,
      ]);
      return { url: pr.url, merged: await confirmMerge() };
    }
    return { url: pr.url, merged: false };
  }
  async checkWorkflows(workspace: string, target: string) {
    const directory = join(workspace, ".github", "workflows");
    for (const name of await readdir(directory).catch(() => [])) {
      if (!/\.ya?ml$/.test(name)) continue;
      const text = await readFile(join(directory, name), "utf8");
      if (
        /\bdeploy\b|terraform\s+apply|tofu\s+apply|kubectl\s+apply|workflow_run/i.test(
          text,
        ) &&
        /\bpush\s*:|workflow_run/.test(text)
      ) {
        throw new ControlError(
          "production_workflow",
          `Workflow ${name} may deploy after merging into ${target}; isolate production deployment first`,
          409,
        );
      }
    }
  }
}
