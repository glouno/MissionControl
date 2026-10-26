import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { release } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const windowsStorageRequired = () =>
  release().toLowerCase().includes("microsoft");
export interface WindowsStoragePressure {
  admissionAllowed: boolean;
  freeBytes?: number;
  reserveBytes?: number;
  warning?: boolean;
  reason?: string;
}
export interface StoragePressure {
  freeBytes: number;
  reserveBytes: number;
  admissionAllowed: boolean;
  peakBytes?: number;
  host?: WindowsStoragePressure;
}

export function decodeWindowsPressure(
  text: string,
  peakBytes: number,
  now = Date.now(),
): WindowsStoragePressure {
  const value = JSON.parse(text);
  const bytes = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (
    value.version !== 1 ||
    value.hostRequired !== true ||
    typeof value.measuredAt !== "number" ||
    !Number.isFinite(value.measuredAt) ||
    now - value.measuredAt * 1000 > 5000 ||
    value.measuredAt * 1000 - now > 1000 ||
    !bytes(value.hostFreeBytes) ||
    !bytes(value.hostReserveBytes) ||
    value.peakBytes !== peakBytes ||
    typeof value.admissionAllowed !== "boolean"
  )
    throw new Error("Windows storage measurement is incomplete or stale");
  return {
    freeBytes: value.hostFreeBytes,
    reserveBytes: value.hostReserveBytes,
    admissionAllowed:
      value.admissionAllowed &&
      value.hostFreeBytes - peakBytes >= value.hostReserveBytes,
    warning: value.hostWarning === true,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

export async function windowsStoragePressure(
  path: string,
  peakBytes: number,
): Promise<WindowsStoragePressure | undefined> {
  if (!windowsStorageRequired()) return undefined;
  try {
    // Use the installed host-owned helper, never a candidate-selected command.
    const { stdout } = await exec(
      "/usr/local/bin/devbox-storage",
      ["pressure", "--path", path, "--peak-gib", String(peakBytes / 1024 ** 3)],
      { timeout: 7000, maxBuffer: 64 * 1024 },
    );
    return decodeWindowsPressure(stdout, peakBytes);
  } catch {
    return {
      admissionAllowed: false,
      reason: "Windows storage measurement unavailable; heavy work is blocked",
    };
  }
}

export async function measureStoragePressure(
  path: string,
  reserveBytes: number,
  peakBytes = 0,
  hostProbe = windowsStoragePressure,
): Promise<StoragePressure> {
  if (
    !Number.isSafeInteger(reserveBytes) ||
    reserveBytes < 0 ||
    !Number.isSafeInteger(peakBytes) ||
    peakBytes < 0
  )
    throw new Error("Storage reserve and peak must be nonnegative byte counts");
  const fs = await statfs(path, { bigint: true });
  const freeBytes = Number(fs.bavail * fs.bsize);
  const host = await hostProbe(path, peakBytes);
  return {
    freeBytes,
    reserveBytes,
    peakBytes,
    host,
    admissionAllowed:
      freeBytes - peakBytes >= reserveBytes && (!host || host.admissionAllowed),
  };
}
