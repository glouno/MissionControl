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
test("WSL image builds register daemon requests inside isolated admission", () => {
  assert.deepEqual(ownedDockerInvocation(["build", "."], true), {
    command: "/usr/local/bin/devbox-storage",
    args: [
      "run",
      "--peak-gib",
      "10",
      "--cpu",
      "2",
      "--project",
      "missioncontrol-image",
      "--resource",
      "path:.",
      "--",
      "/usr/local/bin/devbox-storage",
      "daemon-command",
      "--timeout",
      "900",
      "--",
      "docker",
      "build",
      "--iidfile",
      ".missioncontrol-image-id",
      ".",
    ],
  });
  const tagged = ownedDockerInvocation(
    ["build", "--tag", "project:v1", "/isolated/context"],
    true,
  );
  assert.ok(tagged.args.includes("name:docker-image:project:v1"));
  assert.ok(tagged.args.includes("/isolated/context/.missioncontrol-image-id"));
  const existing = ownedDockerInvocation(
    ["build", "--iidfile", "/isolated/id", "."],
    true,
  );
  assert.equal(existing.args.filter((arg) => arg === "--iidfile").length, 1);
  assert.ok(existing.args.includes("/isolated/id"));
  assert.ok(existing.args.includes("path:/isolated/id"));
  assert.ok(
    ownedDockerInvocation(
      ["build", "--tag=project:v2", "."],
      true,
    ).args.includes("name:docker-image:project:v2"),
  );
  for (const build of [
    ["build", "."],
    ["buildx", "build", "--load", "."],
  ])
    assert.deepEqual(ownedDockerInvocation(build, false), {
      command: "docker",
      args: build,
    });
  assert.deepEqual(ownedDockerInvocation(["image", "inspect", "tag"], true), {
    command: "docker",
    args: ["image", "inspect", "tag"],
  });
});

test("unsupported WSL daemon builds fail closed before releasing admission", () => {
  assert.throws(
    () => ownedDockerInvocation(["buildx", "build", "--load", "."], true),
    /Buildx daemon ownership/,
  );
  assert.throws(
    () => ownedDockerInvocation(["build", "-"], true),
    /local build context/,
  );
  assert.throws(
    () =>
      ownedDockerInvocation(
        ["build", "https:\/\/example.invalid/context"],
        true,
      ),
    /local build context/,
  );
  assert.throws(
    () => ownedDockerInvocation(["build", "--iidfile=output", "."], true),
    /separate --iidfile/,
  );
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
