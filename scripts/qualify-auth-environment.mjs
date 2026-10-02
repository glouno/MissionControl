// Native status only: no browser/device login, credential import or inference.
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  initializeState,
  inspectState,
  lockInstance,
} from "../dist/instance.js";
import { SqliteStore } from "../dist/sqlite.js";
import { ControlStore } from "../dist/control/store.js";
import {
  authEnvironmentSchema,
  initializeAuthEnvironment,
  inspectAuthEnvironment,
} from "../dist/control/authEnvironment.js";
import { AuthRuntime } from "../dist/control/authRuntime.js";
const image = (await readFile(process.argv[2], "utf8")).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image))
  throw Error("Supply reviewed immutable image digest file");
const root = await mkdtemp(join(tmpdir(), "mc-auth-qualification-")),
  state = join(root, "state"),
  secrets = join(root, "private");
await initializeState(state);
await mkdir(secrets, { mode: 0o700 });
const unlock = await lockInstance(state),
  db = new SqliteStore(join(state, "mission-control.db"), { mustExist: true }),
  store = new ControlStore(db),
  results = [];
try {
  for (const harness of ["codex", "claude-code"]) {
    const config = authEnvironmentSchema.parse({
      id: harness,
      harness,
      imageDigest: image,
      sessionDir: harness,
      egress: {
        hosts:
          harness === "codex"
            ? ["auth.openai.com", "chatgpt.com"]
            : ["claude.ai", "api.anthropic.com"],
        timeoutMs: 30000,
      },
    });
    await initializeAuthEnvironment(config, secrets);
    const runtime = new AuthRuntime(store, state, secrets, config);
    for (let restart = 0; restart < 2; restart++) {
      const status = await runtime.run("status");
      assert.equal(status.authenticated, false);
      assert.equal(status.authenticationState, "logged_out");
      assert.equal(status.qualified, false);
      assert.equal(
        (await inspectAuthEnvironment(config, secrets)).writer,
        undefined,
      );
    }
    results.push({
      harness,
      dedicatedEmptyStore: true,
      credentialFreeStatusRestart: true,
      loginQualified: false,
    });
  }
  assert.ok(
    store
      .setting("subscription-auth-runs")
      .every((r) => r.status === "stopped"),
  );
  await inspectState(state);
  console.log(
    JSON.stringify(
      {
        passed: true,
        platform: process.platform,
        results,
        credentialsUsed: false,
        loginQualified: false,
        inferenceSpendUsd: 0,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  await unlock();
  if (process.env.MISSIONCONTROL_AUTH_PROOF_KEEP === "1") console.error(root);
  else await rm(root, { recursive: true, force: true });
}
