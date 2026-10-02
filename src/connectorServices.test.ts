import test from "node:test";
import assert from "node:assert/strict";
import {
  connectorServiceDefinition,
  connectorServiceCommand,
} from "./connectorServices.js";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  unlink,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("connector services use fixed scoped CLI, private logging and separate names without activation", () => {
  const linux = connectorServiceDefinition(
    '/private/config "quoted" % $HOME',
    "synthetic",
    "linux",
    "/installed/node",
    "/installed/cli.js",
  );
  assert.match(linux.content, /connector" "run" "synthetic/);
  assert.match(linux.content, /UMask=0077/);
  assert.match(linux.content, /StandardError=null/);
  assert.ok(linux.content.includes("%%"));
  assert.ok(linux.content.includes("$$HOME"));
  assert.equal(linux.name, "mission-control-v1-connector-synthetic.service");
  const mac = connectorServiceDefinition(
    "/private/a&b",
    "synthetic",
    "darwin",
    "/installed/node",
    "/installed/cli.js",
  );
  assert.ok(mac.content.includes("a&amp;b"));
  assert.match(mac.content, /<key>RunAtLoad<\/key><false\/>/);
  assert.throws(() =>
    connectorServiceDefinition(
      "/private",
      "../../escape",
      "linux",
      "node",
      "cli",
    ),
  );
  assert.throws(() =>
    connectorServiceDefinition(
      "/bad\npath",
      "synthetic",
      "darwin",
      "node",
      "cli",
    ),
  );
});
test("connector service lifecycle checks exact ownership and never addresses legacy units", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-connector-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config: any = {
    root: join(root, "config"),
    connectors: [
      {
        id: "synthetic",
        enabled: true,
        kind: "telegram",
        credential: { kind: "file", path: "synthetic" },
        bindings: [{ enabled: true }],
      },
    ],
  };
  const calls: Array<{ file: string; args: string[] }> = [];
  let active = true;
  const options = {
    platform: "linux",
    home: root,
    xdgConfig: join(root, "xdg"),
    node: "/installed/node",
    cli: "/installed/cli.js",
    execute: async (file: string, args: string[]) => {
      calls.push({ file, args });
      return {
        stdout: args.includes("show")
          ? `ActiveState=${active ? "active" : "inactive"}\n`
          : "",
      };
    },
  };
  assert.equal(
    (await connectorServiceCommand(config, "synthetic", "status", options))
      .installed,
    false,
  );
  const installed = await connectorServiceCommand(
    config,
    "synthetic",
    "install",
    options,
  );
  assert.equal(installed.started, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["--user", "daemon-reload"]);
  assert.equal(
    (await connectorServiceCommand(config, "synthetic", "status", options))
      .installed,
    true,
  );
  await assert.rejects(
    connectorServiceCommand(config, "synthetic", "uninstall", options),
    /Stop/,
  );
  await connectorServiceCommand(config, "synthetic", "restart", options);
  await connectorServiceCommand(config, "synthetic", "stop", options);
  active = false;
  const original = await readFile(installed.path!, "utf8");
  await writeFile(installed.path!, original + "# changed\n");
  const before = calls.length;
  await assert.rejects(
    connectorServiceCommand(config, "synthetic", "stop", options),
    /differs/,
  );
  assert.equal(calls.length, before);
  await writeFile(installed.path!, original);
  config.connectors[0].enabled = false;
  await assert.rejects(
    connectorServiceCommand(config, "synthetic", "restart", options),
    /Disabled/,
  );
  await connectorServiceCommand(config, "synthetic", "uninstall", options);
  assert.equal(
    calls.some(
      (c) =>
        c.args.includes("mission-control-dashboard.service") ||
        c.args.includes("mission-control-orchestrator.service"),
    ),
    false,
  );
  config.connectors[0].enabled = true;
  const macOptions = { ...options, platform: "darwin" };
  const mac = await connectorServiceCommand(
    config,
    "synthetic",
    "install",
    macOptions,
  );
  await connectorServiceCommand(config, "synthetic", "restart", macOptions);
  assert.ok(calls.at(-1)!.args.includes("kickstart"));
  await unlink(mac.path!);
  await symlink(installed.path!, mac.path!);
  await assert.rejects(
    connectorServiceCommand(config, "synthetic", "stop", macOptions),
  );
});
