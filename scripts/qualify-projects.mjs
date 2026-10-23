#!/usr/bin/env node
// Read-only: no child processes, repository traversal, configuration resolution or network.
import {
  qualifyProjects,
  readQualificationInput,
} from "../dist/projectQualification.js";

const flags = [
  "expectations",
  "configuration",
  "repositories",
  "artifacts",
  "checks",
];
try {
  const args = process.argv.slice(2);
  if (args.length !== flags.length * 2)
    throw Error(
      "Supply exactly --expectations FILE --configuration FILE --repositories FILE --artifacts FILE --checks FILE",
    );
  const paths = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    if (
      !args[i].startsWith("--") ||
      !flags.includes(key) ||
      Object.hasOwn(paths, key) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw Error("Unknown, missing or duplicate explicit input flag");
    paths[key] = args[i + 1];
  }
  const input = {};
  for (const key of flags)
    input[key] = await readQualificationInput(paths[key]);
  const report = qualifyProjects(input);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.suppliedEvidenceQualified ? 0 : 1;
} catch (error) {
  process.stdout.write(
    JSON.stringify(
      {
        schemaVersion: 1,
        suppliedEvidenceQualified: false,
        actualPrivateApplicationAcceptance: "unresolved",
        nativeMacAcceptance: "unresolved",
        liveSubscriptionExecution: "unresolved",
        issues: [error.message],
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = 2;
}
