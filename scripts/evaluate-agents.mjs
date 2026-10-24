#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepare,
  selfVerify,
  runAdapter,
  readManifest,
  report,
  parseConfig,
} from "../src/evaluation.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const [command, ...args] = process.argv.slice(2);
const usage =
  "Commands: prepare <inventory|csv> <new-run-dir>; self-verify; run <config.json> <prepared-run-dir> --operator-requested; report <new-report.json> [run-dir ...]; validate-config <config.json>";
async function config(path) {
  const bytes = await readFile(resolve(path));
  if (bytes.length > 16384) throw Error("Config exceeds 16 KiB");
  return JSON.parse(bytes);
}
try {
  let result;
  if (command === "prepare" && args.length === 2)
    result = await prepare(args[0], resolve(args[1]), root);
  else if (command === "self-verify" && !args.length)
    result = await selfVerify(root);
  else if (command === "validate-config" && args.length === 1) {
    parseConfig(await config(args[0]));
    result = { schemaVersion: 1, valid: true, executed: false };
  } else if (
    command === "run" &&
    args.length === 3 &&
    args[2] === "--operator-requested"
  ) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
      result = await runAdapter(
        resolve(args[1]),
        await config(args[0]),
        root,
        controller.signal,
      );
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
    if (
      result.outcome !== "completed" ||
      !result.acceptance.passed ||
      result.flags.length
    )
      process.exitCode = 1;
  } else if (command === "report" && args.length >= 1) {
    result = report(
      await Promise.all(args.slice(1).map((p) => readManifest(resolve(p)))),
    );
    await writeFile(resolve(args[0]), JSON.stringify(result, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } else throw Error(usage);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
