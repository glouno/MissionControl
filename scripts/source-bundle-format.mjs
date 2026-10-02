import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safePath = (path) =>
  typeof path === "string" &&
  path.length <= 255 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  path.split("/").every((part) => part && part !== "." && part !== "..") &&
  !/[^\x20-\x7e]/.test(path);

export function createSourceArchive(files, epoch) {
  if (!Number.isSafeInteger(epoch) || epoch < 0)
    throw Error("Invalid source epoch");
  const parts = [];
  let total = 0;
  const seen = new Set();
  for (const { path, data } of files) {
    if (!safePath(path) || seen.has(path)) throw Error("Invalid source path");
    seen.add(path);
    total += 512 + Math.ceil(data.length / 512) * 512;
    if (total + 1024 > MAX_SOURCE_BYTES)
      throw Error("Source archive exceeds bound");
    const header = Buffer.alloc(512);
    const split = path.length > 100 ? path.lastIndexOf("/", 155) : -1;
    const name = split >= 0 ? path.slice(split + 1) : path;
    const prefix = split >= 0 ? path.slice(0, split) : "";
    if (name.length > 100 || prefix.length > 155)
      throw Error("Source path exceeds USTAR bound");
    header.write(name, 0, 100, "ascii");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(
      data.length.toString(8).padStart(11, "0") + "\0",
      124,
      12,
      "ascii",
    );
    header.write(epoch.toString(8).padStart(11, "0") + "\0", 136, 12, "ascii");
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write(prefix, 345, 155, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(
      checksum.toString(8).padStart(6, "0") + "\0 ",
      148,
      8,
      "ascii",
    );
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

export function verifySourceArchive(
  bytes,
  manifest,
  permitted,
  inspect = () => {},
) {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.archive?.path !== "source.tar.gz" ||
    !Number.isSafeInteger(manifest.archiveEpoch) ||
    manifest.archiveEpoch < 0 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > 10000 ||
    bytes.length !== manifest.archive.bytes ||
    bytes.length > MAX_SOURCE_BYTES ||
    hash(bytes) !== manifest.archive.sha256
  )
    throw Error("Bundled source metadata differs");
  const expected = new Map();
  for (const file of manifest.files) {
    if (
      !safePath(file.path) ||
      expected.has(file.path) ||
      !permitted(file.path, "source") ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw Error("Bundled source inventory is invalid");
    expected.set(file.path, file);
  }
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_SOURCE_BYTES });
  const string = (header, offset, size) =>
    header
      .subarray(offset, offset + size)
      .toString("ascii")
      .split("\0")[0];
  const number = (header, offset, size) => {
    const value = string(header, offset, size).trim();
    if (!/^[0-7]+$/.test(value)) throw Error("Invalid source TAR integer");
    return parseInt(value, 8);
  };
  const seen = new Set();
  let offset = 0;
  while (
    offset + 512 <= tar.length &&
    tar.subarray(offset, offset + 512).some((b) => b !== 0)
  ) {
    const header = tar.subarray(offset, offset + 512);
    const name = string(header, 0, 100),
      prefix = string(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const file = expected.get(path),
      size = number(header, 124, 12);
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (
      !file ||
      seen.has(path) ||
      size !== file.bytes ||
      number(header, 148, 8) !== checksum ||
      header[156] !== 48 ||
      string(header, 157, 100) ||
      string(header, 257, 6) !== "ustar" ||
      string(header, 263, 2) !== "00" ||
      number(header, 100, 8) !== 0o644 ||
      number(header, 108, 8) ||
      number(header, 116, 8) ||
      number(header, 136, 12) !== manifest.archiveEpoch ||
      string(header, 265, 32) ||
      string(header, 297, 32)
    )
      throw Error("Bundled source TAR entry differs");
    offset += 512;
    if (
      offset + size > tar.length ||
      hash(tar.subarray(offset, offset + size)) !== file.sha256
    )
      throw Error("Bundled source content differs");
    inspect(path, tar.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
    seen.add(path);
  }
  if (
    seen.size !== expected.size ||
    tar.length - offset < 1024 ||
    tar.subarray(offset).some((byte) => byte !== 0)
  )
    throw Error("Bundled source TAR is incomplete");
  return { files: seen.size, sha256: hash(bytes) };
}
