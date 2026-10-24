#!/usr/bin/env node
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { parseQualificationJson } from "../dist/projectQualification.js";
import {
  auditProjectReadiness,
  formatReadinessReport,
} from "../dist/projectReadiness.js";

// No defaults, discovery, stdin, includes, referenced files, writes or host probes.
const LIMIT = 1024 * 1024;
async function localExport(path) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > LIMIT) throw Error("Invalid export");
    const bytes = Buffer.alloc(LIMIT + 1);
    let size = 0;
    while (size <= LIMIT) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > LIMIT) throw Error("Oversized export");
    return parseQualificationJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
  } finally {
    await file.close();
  }
}
const args = process.argv.slice(2),
  flags = new Map();
let invalid = false;
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--config-export", "--status-export", "--as-of", "--format"].includes(
      args[i],
    ) ||
    flags.has(args[i]) ||
    !args[i + 1]
  ) {
    invalid = true;
    break;
  }
  flags.set(args[i], args[i + 1]);
}
const format = flags.get("--format") ?? "text";
let report;
if (
  invalid ||
  !flags.get("--config-export") ||
  !flags.get("--status-export") ||
  !flags.get("--as-of") ||
  !["text", "json"].includes(format)
) {
  report = auditProjectReadiness(null, null, "");
} else {
  try {
    const config = await localExport(flags.get("--config-export"));
    const status = await localExport(flags.get("--status-export"));
    report = auditProjectReadiness(config, status, flags.get("--as-of"));
  } catch {
    report = auditProjectReadiness(null, null, flags.get("--as-of"));
  }
}
process.stdout.write(
  format === "json"
    ? JSON.stringify(report, null, 2) + "\n"
    : formatReadinessReport(report),
);
process.exitCode = report.exitCode;
