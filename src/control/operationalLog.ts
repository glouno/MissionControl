import {
  appendFileSync,
  chmodSync,
  existsSync,
  realpathSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Redactor } from "../privacy.js";

/** Metadata only: arbitrary payloads, errors, prompts and model output never enter this log. */
export class OperationalLog {
  constructor(
    readonly path: string,
    readonly redactor: Redactor,
    readonly maxBytes = 10 * 1024 * 1024,
    readonly retained = 5,
  ) {}
  write(event: string, metadata: Record<string, unknown> = {}) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (
      realpathSync(dirname(this.path)) !== dirname(this.path) ||
      (lstatSync(dirname(this.path)).mode & 0o077) !== 0
    )
      throw Error("Operational log parent must be canonical and private");
    const allowed = new Set([
      "goalId",
      "taskId",
      "attemptId",
      "diagnosticId",
      "sessionId",
      "generation",
      "kind",
      "phase",
      "status",
      "httpStatus",
      "durationMs",
      "incidentId",
    ]);
    const fields = Object.fromEntries(
      Object.entries(metadata)
        .filter(
          ([key, value]) =>
            allowed.has(key) &&
            ["string", "number", "boolean"].includes(typeof value),
        )
        .map(([key, value]) => [
          key,
          typeof value === "string"
            ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 256)
            : value,
        ]),
    );
    const line =
      this.redactor.json({
        version: 1,
        at: new Date().toISOString(),
        event: event.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 100),
        ...fields,
      }) + "\n";
    for (let i = 0; i <= this.retained; i++) {
      const file = i ? `${this.path}.${i}` : this.path;
      if (
        existsSync(file) &&
        (!lstatSync(file).isFile() ||
          lstatSync(file).isSymbolicLink() ||
          lstatSync(file).nlink !== 1)
      )
        throw Error("Operational log ownership changed");
    }
    if (
      existsSync(this.path) &&
      lstatSync(this.path).size + Buffer.byteLength(line) > this.maxBytes
    ) {
      if (existsSync(`${this.path}.${this.retained}`))
        unlinkSync(`${this.path}.${this.retained}`);
      for (let i = this.retained - 1; i >= 1; i--)
        if (existsSync(`${this.path}.${i}`))
          renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      renameSync(this.path, `${this.path}.1`);
    }
    appendFileSync(this.path, line, { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}
