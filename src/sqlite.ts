import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { Redactor } from "./privacy.js";

export type SqlValue = string | number | boolean | null | undefined;
/** Registries within an initialized instance share its authoritative database. */
export function registryDatabase(root: string, fallback: string) {
  let directory = resolve(root);
  while (true) {
    if (existsSync(join(directory, "instance.json")))
      throw new Error(
        "Application registry access requires the controller-owned database connection; use the API from other processes",
      );
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return new SqliteStore(join(root, fallback)); // Isolated registry fixtures/build tools.
}
export function sql(value: SqlValue): string {
  if (value == null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid SQL number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${value.replace(/'/g, "''")}'`;
}

/** Low-level connection. Application schema ownership belongs to ControlStore. */
export class SqliteStore {
  readonly redactor = new Redactor();
  private readonly database: DatabaseSync;
  private depth = 0;
  private closed = false;
  constructor(
    public readonly path: string,
    options: { mustExist?: boolean; readOnly?: boolean } = {},
  ) {
    if (options.mustExist && !existsSync(path))
      throw new Error(
        "State database does not exist; run init with the intended configuration",
      );
    if (
      existsSync(path) &&
      (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())
    )
      throw new Error("Database must be a regular non-symlink file");
    if (!options.readOnly)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path, {
      readOnly: options.readOnly ?? false,
    });
    if (!options.readOnly && process.platform !== "win32")
      chmodSync(path, 0o600);
    this.database.exec("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON;");
    if (!options.readOnly)
      this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  }
  exec(statement: string): void {
    this.database.exec(statement);
  }
  query<T extends Record<string, unknown>>(statement: string): T[] {
    return this.database.prepare(statement).all() as T[];
  }
  one<T extends Record<string, unknown>>(statement: string): T | null {
    return this.query<T>(statement)[0] ?? null;
  }
  transaction<T>(operation: () => T): T {
    const depth = this.depth++,
      name = `mc_savepoint_${depth}`;
    try {
      this.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
      const result = operation();
      if (result instanceof Promise)
        throw new Error("SQLite transactions must be synchronous");
      this.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      try {
        this.exec(
          depth === 0
            ? "ROLLBACK"
            : `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`,
        );
      } catch {
        /* preserve original */
      }
      throw error;
    } finally {
      this.depth--;
    }
  }
  integrityCheck(): string[] {
    return this.query<{ integrity_check: string }>(
      "PRAGMA integrity_check",
    ).map((r) => r.integrity_check);
  }
  checkpoint(): void {
    this.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;");
  }
  async backup(destination: string): Promise<void> {
    if (existsSync(destination))
      throw new Error("Backup destination must be new");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    await backup(this.database, destination);
    chmodSync(destination, 0o600);
  }
  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }
}
