import { resolve, relative, isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import type { SqliteStore } from "../sqlite.js";
/** Registry paths within initialized instances persist relative to their owner. */
export class StatePaths {
  readonly enabled: boolean;
  constructor(
    readonly root: string,
    _db: SqliteStore,
  ) {
    let current = resolve(root);
    this.enabled = false;
    while (true) {
      if (existsSync(join(current, "instance.json"))) {
        this.enabled = true;
        break;
      }
      const next = resolve(current, "..");
      if (next === current) break;
      current = next;
    }
  }
  encode(path: string): string {
    if (!this.enabled) return path;
    const rel = relative(resolve(this.root), resolve(path));
    if (
      !rel ||
      rel === ".." ||
      rel.startsWith("../") ||
      isAbsolute(rel) ||
      rel.includes("\\")
    )
      throw new Error(
        "Registered state path must be inside its instance owner root",
      );
    return rel;
  }
  decode(path: string): string {
    if (!this.enabled) return path;
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((p) => !p || p === "." || p === "..")
    )
      throw new Error(
        "Persisted state path must be canonical and relative; offline recovery required",
      );
    return resolve(this.root, path);
  }
  optionalEncode(path: string): string {
    if (!this.enabled) return path;
    return isAbsolute(path) &&
      relative(this.root, path) !== ".." &&
      !relative(this.root, path).startsWith("../")
      ? this.encode(path)
      : path;
  }
  optionalDecode(path: string): string {
    if (!this.enabled) return path;
    return isAbsolute(path) ? path : this.decode(path);
  }
}
