import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
// prettier-ignore
// @ts-expect-error Build/release tooling is JavaScript shared with the publication audit.
import { createSourceArchive, verifySourceArchive } from "../scripts/source-bundle-format.mjs";

test("bundled corresponding source verifies exact content and rejects substituted or unsafe members", () => {
  const data = Buffer.from("synthetic source"),
    path = "src/synthetic.ts";
  const archive = createSourceArchive([{ path, data }], 1000000000);
  const manifest = {
    schemaVersion: 1,
    archiveEpoch: 1000000000,
    archive: {
      path: "source.tar.gz",
      bytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
    },
    files: [
      {
        path,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      },
    ],
  };
  assert.equal(
    verifySourceArchive(archive, manifest, (p: string) => p.startsWith("src/"))
      .files,
    1,
  );
  assert.throws(() => verifySourceArchive(archive, manifest, () => false));
  assert.throws(() => createSourceArchive([{ path: "../private", data }], 0));
  assert.throws(() =>
    createSourceArchive(
      [
        { path, data },
        { path, data },
      ],
      0,
    ),
  );
  const tar = gunzipSync(archive);
  tar[512] ^= 1;
  const changed = gzipSync(tar),
    changedManifest = {
      ...manifest,
      archive: {
        ...manifest.archive,
        bytes: changed.length,
        sha256: createHash("sha256").update(changed).digest("hex"),
      },
    };
  assert.throws(
    () => verifySourceArchive(changed, changedManifest, () => true),
    /content differs/,
  );
  const trailing = gzipSync(
    Buffer.concat([gunzipSync(archive), Buffer.from("hidden")]),
  );
  assert.throws(
    () =>
      verifySourceArchive(
        trailing,
        {
          ...manifest,
          archive: {
            ...manifest.archive,
            bytes: trailing.length,
            sha256: createHash("sha256").update(trailing).digest("hex"),
          },
        },
        () => true,
      ),
    /incomplete/,
  );
});
