import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
export function isEntrypoint(moduleUrl: string, argument = process.argv[1]): boolean {
  if (!argument) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argument); }
  catch { return false; }
}
