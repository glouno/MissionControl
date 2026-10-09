import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
test(
  "synthetic backlog API and CLI launch reaches persisted scheduler acceptance",
  { timeout: 150000 },
  async () => {
    await promisify(execFile)(
      process.execPath,
      ["scripts/backlog-acceptance.mjs"],
      { timeout: 140000, env: { ...process.env, NODE_USE_ENV_PROXY: "0" } },
    );
  },
);
