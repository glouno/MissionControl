import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { matrixLaunch } from "./matrixLifecycle.js";
test("Matrix launch binds native binary, room, senders and scoped credential without ambient environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-matrix-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "companion"),
    path = join(root, "matrix.json"),
    secret = join(root, "private");
  await mkdir(secret, { mode: 0o700 });
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const companion = {
    homeserver: "https://example.invalid",
    room_id: "!synthetic:example.invalid",
    own_user: "@bot:example.invalid",
    own_device: "SYNTHETIC",
    allowed_users: ["@operator:example.invalid"],
    state_dir: "store",
    session_file: "session",
    passphrase_file: "passphrase",
    controller_url: "http://127.0.0.1:43201",
    controller_token_file: join(secret, "connector-matrix"),
  };
  await writeFile(path, JSON.stringify(companion), { mode: 0o600 });
  const binding = {
    destination: companion.room_id,
    externalIdentity: companion.allowed_users[0],
    enabled: true,
  };
  const config: any = {
    settings: { server: { port: 43201 }, secretsDir: secret },
    connectors: [
      {
        id: "matrix",
        enabled: true,
        kind: "matrix",
        settings: { binary, companionConfig: path },
        bindings: [binding],
      },
    ],
  };
  const launch = await matrixLaunch(config, "matrix");
  assert.deepEqual(launch.args, [path]);
  assert.deepEqual(Object.keys(launch.env), ["PATH"]);
  config.connectors[0].bindings[0].destination = "!other:example.invalid";
  await assert.rejects(matrixLaunch(config, "matrix"), /destination/);
  config.connectors[0].bindings[0].destination = companion.room_id;
  companion.controller_token_file = join(secret, "operator");
  await writeFile(path, JSON.stringify(companion), { mode: 0o600 });
  await assert.rejects(matrixLaunch(config, "matrix"), /scoped/);
});
