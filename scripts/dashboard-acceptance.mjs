/** Optional real-browser acceptance. Install Playwright separately; core does not depend on it.
 * PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/dashboard-acceptance.mjs
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE may select an already installed qualified browser.
 * Every configuration, database, token and repository created here is disposable and synthetic.
 */
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath)
  throw Error(
    "Set PLAYWRIGHT_MODULE to a separately installed Playwright module; run npm run build first.",
  );
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const root = await mkdtemp(join(tmpdir(), "missioncontrol-dashboard-"));
const config = join(root, "config"),
  state = join(root, "state"),
  secrets = join(root, "secrets"),
  repo = join(root, "repo");
const cli = join(source, "dist", "cli.js");
let controller, browser;
const errors = [],
  checks = [];
async function waitFor(check, description, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    if (controller && controller.exitCode !== null)
      throw Error("Synthetic controller stopped during " + description);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out: " + description);
}
try {
  await exec(process.execPath, [
    cli,
    "--config-dir",
    config,
    "init",
    "--state-dir",
    state,
    "--secrets-dir",
    secrets,
  ]);
  await mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await writeFile(
    join(repo, "README.md"),
    "Synthetic dashboard acceptance fixture\n",
  );
  await exec("git", ["add", "."], { cwd: repo });
  await exec(
    "git",
    [
      "-c",
      "user.name=Example",
      "-c",
      "user.email=example@example.invalid",
      "commit",
      "-m",
      "Synthetic initial tree",
    ],
    { cwd: repo },
  );
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const settings = JSON.parse(
    await readFile(join(config, "config.json"), "utf8"),
  );
  settings.server.port = port;
  settings.files.projects = ["project.json"];
  settings.storage = { ...settings.storage, freeReserveBytes: 1024 * 1024 };
  await writeFile(join(config, "config.json"), JSON.stringify(settings));
  await writeFile(
    join(config, "project.json"),
    JSON.stringify({
      id: "synthetic",
      name: "Synthetic project",
      enabled: true,
      executionMode: "fake",
      config: {
        repoPath: repo,
        repository: { mode: "local", branch: "main" },
        policy: { targetBranch: "main", protectedPaths: ["implement.txt"] },
        verificationCommands: ["test -f implement.txt"],
      },
    }),
  );
  controller = spawn(process.execPath, [cli, "--config-dir", config, "serve"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  // Do not print raw server errors containing paths or data. Keep errors bounded in memory.
  controller.stderr.on("data", (b) => {
    if (errors.length < 20)
      errors.push("Controller stderr emitted (" + b.length + " bytes)");
  });
  const base = "http://127.0.0.1:" + port;
  await waitFor(async () => {
    try {
      return (await fetch(base + "/healthz")).ok;
    } catch {
      return false;
    }
  }, "controller readiness");
  const token = (
    await readFile(join(secrets, "operator-token"), "utf8")
  ).trim();
  async function api(path, body) {
    const response = await fetch(base + "/api/v1" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        ...(body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              "Idempotency-Key": randomBytes(16).toString("hex"),
            }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok)
      throw Error(
        "Synthetic API request failed: " + path + " (" + response.status + ")",
      );
    return value;
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  async function refreshPage() {
    // Domain effects can commit before an action's follow-up reads finish.
    // Wait for that refresh to finish before expecting a new request.
    await waitFor(
      async () =>
        (await page.locator("#view").getAttribute("aria-busy")) === "false",
      "previous dashboard render",
    );
    const response = page.waitForResponse(
      (r) => r.url() === base + "/api/v1/dashboard",
    );
    await page.getByRole("button", { name: "Refresh instance" }).click();
    await response;
    await waitFor(
      async () =>
        (await page.locator("#view").getAttribute("aria-busy")) === "false",
      "dashboard render",
    );
  }
  page.on("pageerror", (e) => errors.push("Browser: " + e.message));
  await page.goto(base);
  await page.locator("#token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("navigation").waitFor({ state: "visible" });
  assert.equal(await page.locator("#token").inputValue(), "");
  for (const view of [
    "Today",
    "Projects",
    "Work",
    "Agents",
    "History",
    "New work",
  ]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await page.getByRole("heading", { name: view, exact: true }).waitFor();
  }
  checks.push("six_views", "private_browser_session");
  // Qualified build/install must ship the matching corresponding source.
  const sourceLink = page.getByRole("link", {
    name: "Download exact application source",
    exact: true,
  });
  await sourceLink.waitFor();
  const sourceMetadata = await api("/source-info");
  const sourceResponse = await page.request.get(
    new URL(await sourceLink.getAttribute("href"), base).href,
  );
  assert.equal(sourceResponse.status(), 200);
  const sourceBytes = await sourceResponse.body();
  assert.equal(sourceBytes.length, sourceMetadata.bytes);
  assert.equal(
    createHash("sha256").update(sourceBytes).digest("hex"),
    sourceMetadata.sha256,
  );
  assert.equal((await fetch(base + "/api/v1/source")).status, 401);
  checks.push("exact_authenticated_source_archive");

  const badCsrf = await page.evaluate(
    async () =>
      (
        await fetch("/api/v1/goals", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": "invalid",
          },
          body: "{}",
        })
      ).status,
  );
  assert.equal(badCsrf, 403);
  const foreignOrigin = await page.request.get(base + "/api/v1/dashboard", {
    headers: { Origin: "https://untrusted.example.invalid" },
  });
  assert.equal(foreignOrigin.status(), 403);
  assert.equal((await fetch(base + "/api/v1/dashboard")).status, 401);
  checks.push("browser_csrf_origin_read_auth");
  let releaseValidation;
  const staged = new Promise((resolve) => (releaseValidation = resolve));
  const validationResponse = page.waitForResponse(
    (r) => r.url() === base + "/api/v1/goal-drafts",
  );
  await page.route("**/api/v1/goal-drafts", async (route) => {
    const response = await route.fetch();
    await staged;
    await route.fulfill({ response });
  });
  await page
    .locator("#draft-description")
    .fill("Synthetic original description");
  await page
    .getByRole("button", { name: "Validate draft", exact: true })
    .click();
  await page
    .locator("#draft-description")
    .fill("Synthetic changed while validating");
  releaseValidation();
  await validationResponse;
  await page
    .getByRole("alert")
    .filter({ hasText: "changed during validation" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Submit reviewed draft" })
      .isDisabled(),
    true,
  );
  await page.unroute("**/api/v1/goal-drafts");
  await page.locator("#draft-description").fill("");
  checks.push("validation_response_fenced_after_edit");

  await page
    .getByRole("button", { name: "Validate draft", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "describe the work" })
    .waitFor();
  const description =
    "Synthetic dashboard approval <img src=x onerror=window.untrusted=true>";
  await page.locator("#draft-description").fill(description);
  await page
    .getByRole("button", { name: "Validate draft", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Review effective limits" })
    .waitFor();
  // Editing invalidates approval of the old draft.
  await page.locator("#draft-description").fill(description + ".");
  assert.equal(
    await page
      .getByRole("button", { name: "Submit reviewed draft" })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("button", { name: "Validate draft", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Review effective limits" })
    .waitFor();
  await page.getByRole("button", { name: "Submit reviewed draft" }).click();
  await page
    .locator("#detail")
    .getByRole("heading", { name: description + ".", exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => window.untrusted), undefined);
  assert.equal(await page.locator("#detail img").count(), 0);
  const goals = await api("/goals");
  const goal = goals.find((g) => g.config.title === description + ".");
  assert.ok(goal);
  await waitFor(
    async () => (await api("/questions")).some((q) => q.goalId === goal.id),
    "protected-change decision",
  );
  await refreshPage();
  await page
    .locator("#detail")
    .getByRole("button", { name: "Approve these exact changes", exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator("#detail")
      .getByRole("button", { name: "Resume", exact: true })
      .isDisabled(),
    true,
  );
  // Decision is deliberately accepted through the browser, not the fixture's API.
  await page
    .locator("#detail")
    .getByRole("button", { name: "Approve these exact changes", exact: true })
    .click();
  await waitFor(
    async () => (await api("/goals/" + goal.id)).status === "completed",
    "approved goal completion",
  );
  await refreshPage();
  await page
    .locator("#detail")
    .getByRole("heading", { name: "Attempts", exact: true })
    .waitFor();
  assert.ok(
    (await page.locator("#detail").innerText()).includes("Synthetic execution"),
  );
  await waitFor(
    async () =>
      (await page.locator("#detail").innerText()).includes("exact candidate"),
    "recorded checks in goal details",
  );
  const artifacts = await api("/goals/" + goal.id + "/artifacts");
  if (artifacts.length) {
    const download = page.locator("#detail a[download]").first();
    const response = await page.request.get(
      new URL(await download.getAttribute("href"), base).href,
    );
    assert.equal(response.status(), 200);
    const reportArtifact = artifacts.find((a) => a.kind === "goal-report");
    assert.ok(
      reportArtifact,
      "Completed goal must register its terminal report",
    );
    if (reportArtifact) {
      const reportResponse = await page.request.get(
        base + "/api/v1/artifacts/" + reportArtifact.id + "/content",
      );
      const report = await reportResponse.json();
      assert.equal(report.goal.status, "completed");
      assert.equal(report.goal.id, goal.id);
      assert.ok(report.attempts.length >= 3);
      assert.ok(
        report.evidence.some((e) => e.kind === "integration" && e.passed),
      );
      checks.push("terminal_report_matches_database");
    }
    checks.push("authorized_evidence_download");
  }
  checks.push(
    "draft_validation_invalidation",
    "safe_output_rendering",
    "decision_completion",
    "attempt_evidence_detail",
  );
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByLabel("Search work", { exact: true }).fill("does not exist");
  await page.getByLabel("Search work", { exact: true }).press("Enter");
  await page
    .getByText("No goals match these filters.", { exact: true })
    .waitFor();
  await page
    .getByLabel("Search work", { exact: true })
    .fill("Synthetic dashboard");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Inspect goal", exact: true })
    .first()
    .waitFor();
  checks.push("history_filter_keyboard_empty_state");
  // A paused synthetic goal gives stable browser pause/resume/cancel acceptance without timing races.
  const draft = (
    await api("/goal-drafts", {
      projectId: "synthetic",
      description: "Synthetic lifecycle controls",
    })
  ).config;
  const controlled = await api("/goals", draft);
  await api("/goals/" + controlled.id + "/state", {
    status: "paused",
    revision: controlled.revision,
  });
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await refreshPage();
  await page
    .getByLabel("Search work", { exact: true })
    .fill("Synthetic lifecycle");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await page.getByRole("button", { name: "Inspect goal", exact: true }).click();
  await page
    .locator("#detail")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await page
    .locator("#detail")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  assert.equal((await api("/goals/" + controlled.id)).status, "paused");
  page.once("dialog", (d) => d.accept());
  await page
    .locator("#detail")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal((await api("/goals/" + controlled.id)).status, "cancelled");
  checks.push("browser_pause_resume_cancel");
  // Verify readable server failure and recovery using a bounded browser-only response fault.
  await page.route("**/api/v1/dashboard", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { message: "Synthetic instance unavailable" },
      }),
    }),
  );
  await refreshPage();
  await page
    .getByRole("alert")
    .filter({ hasText: "Synthetic instance unavailable" })
    .waitFor();
  await page.unroute("**/api/v1/dashboard");
  await refreshPage();
  checks.push("request_error_recovery");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  checks.push("mobile_no_horizontal_overflow");
  // Revocation is real: remove the browser cookie, then require authenticated refresh.
  await page.context().clearCookies();
  await refreshPage();
  await page.locator("#login").waitFor({ state: "visible" });
  assert.equal(await page.locator("#logout").isVisible(), false);
  assert.equal(await page.locator("#detail").isVisible(), false);
  assert.equal(await page.locator("#detail").innerText(), "");
  checks.push("revoked_session_clears_sensitive_view");
  await page.locator("#token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("navigation").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.locator("#login").waitFor({ state: "visible" });
  checks.push("session_logout");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks,
      browser: browser.version(),
      viewport: { width: 390, height: 844 },
      errors: [],
    }),
  );
} finally {
  await browser?.close();
  if (controller?.exitCode === null) {
    controller.kill("SIGTERM");
    await once(controller, "exit");
  }
  await rm(root, { recursive: true, force: true });
}
