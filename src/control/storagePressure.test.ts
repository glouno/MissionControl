import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import {
  decodeWindowsPressure,
  measureStoragePressure,
} from "./storagePressure.js";
import { ownedDockerInvocation } from "./environmentBuild.js";

const gib = 1024 ** 3;
const now = Date.now();
const snapshot = {
  version: 1,
  hostRequired: true,
  measuredAt: now / 1000,
  hostFreeBytes: 105 * gib,
  hostReserveBytes: 100 * gib,
  peakBytes: 10 * gib,
  admissionAllowed: true,
  hostWarning: true,
};
test("WSL image builds use the shared heavy gate while inspection and native builds stay unchanged", () => {
  for (const build of [
    ["build", "."],
    ["buildx", "build", "--load", "."],
  ]) {
    assert.deepEqual(ownedDockerInvocation(build, true), {
      command: "/usr/local/bin/devbox-storage",
      args: [
        "run",
        "--peak-gib",
        "10",
        "--",
        "/usr/bin/timeout",
        "--signal=TERM",
        "--kill-after=30s",
        "900s",
        "docker",
        ...build,
      ],
    });
    assert.deepEqual(ownedDockerInvocation(build, false), {
      command: "docker",
      args: build,
    });
  }
  assert.deepEqual(ownedDockerInvocation(["image", "inspect", "tag"], true), {
    command: "docker",
    args: ["image", "inspect", "tag"],
  });
});
test("Windows reserve plus job peak overrides an incorrectly optimistic admission flag", () => {
  assert.equal(
    decodeWindowsPressure(JSON.stringify(snapshot), 10 * gib, now)
      .admissionAllowed,
    false,
  );
  const admitted = decodeWindowsPressure(
    JSON.stringify({ ...snapshot, hostFreeBytes: 120 * gib }),
    10 * gib,
    now,
  );
  assert.equal(admitted.admissionAllowed, true);
  assert.equal(admitted.warning, true);
});
test("stale, missing, wrong-host and mismatched-peak measurements fail closed", () => {
  for (const value of [
    {},
    null,
    { ...snapshot, measuredAt: now / 1000 - 6 },
    { ...snapshot, measuredAt: now / 1000 + 2 },
    { ...snapshot, hostRequired: false },
    { ...snapshot, hostFreeBytes: -1 },
    { ...snapshot, hostReserveBytes: null },
    { ...snapshot, peakBytes: 0 },
    { ...snapshot, admissionAllowed: "true" },
  ])
    assert.throws(() =>
      decodeWindowsPressure(JSON.stringify(value), 10 * gib, now),
    );
});
test("host denial blocks admission even when Linux has space; native hosts retain Linux-only checks", async () => {
  const denied = await measureStoragePressure(tmpdir(), 0, 0, async () => ({
    admissionAllowed: false,
    reason: "host unavailable",
  }));
  assert.ok(denied.freeBytes > 0);
  assert.equal(denied.admissionAllowed, false);
  assert.equal(denied.host?.reason, "host unavailable");
  assert.equal(
    (await measureStoragePressure(tmpdir(), 0, 0, async () => undefined))
      .admissionAllowed,
    true,
  );
  assert.equal(
    (
      await measureStoragePressure(
        tmpdir(),
        Number.MAX_SAFE_INTEGER,
        0,
        async () => undefined,
      )
    ).admissionAllowed,
    false,
  );
  await assert.rejects(measureStoragePressure(tmpdir(), -1));
});
