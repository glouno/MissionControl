import { Writable } from "node:stream";
import { open, lstat, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { logMaxBytes, logRetained } from "./operationalLog.js";

/** Private raw artifacts share the established log retention policy.
 * Parsing runs against stdout independently, so rotation never truncates metrics. */
export class PrivateOutput extends Writable {
  private file?: FileHandle;
  private bytes = 0;
  constructor(
    readonly path: string,
    readonly maxBytes = logMaxBytes,
    readonly retained = logRetained,
  ) {
    super();
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.append(chunk).then(() => callback(), callback);
  }
  private async append(chunk: Buffer) {
    for (let offset = 0; offset < chunk.length;) {
      this.file ??= await open(this.path, "wx", 0o600);
      const length = Math.min(
        chunk.length - offset,
        this.maxBytes - this.bytes,
      );
      await this.file.writeFile(chunk.subarray(offset, offset + length));
      this.bytes += length;
      offset += length;
      if (this.bytes === this.maxBytes) {
        await this.file.close();
        this.file = undefined;
        for (let index = this.retained; index >= 0; index--) {
          const path = index ? `${this.path}.${index}` : this.path;
          const metadata = await lstat(path).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
          if (!metadata) continue;
          if (
            !metadata.isFile() ||
            metadata.isSymbolicLink() ||
            metadata.nlink !== 1
          )
            throw Error("Private output ownership changed");
          if (index === this.retained) await unlink(path);
          else await rename(path, `${this.path}.${index + 1}`);
        }
        this.bytes = 0;
      }
    }
  }
  override _final(callback: (error?: Error | null) => void) {
    // Keep even an empty stderr file private and discoverable.
    (async () => {
      this.file ??= await open(this.path, "wx", 0o600);
      await this.file.close();
      this.file = undefined;
    })().then(() => callback(), callback);
  }
  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ) {
    const file = this.file;
    this.file = undefined;
    (file?.close() ?? Promise.resolve()).then(() => callback(error), callback);
  }
}
