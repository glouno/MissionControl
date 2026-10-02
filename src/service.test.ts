import test from "node:test";
import assert from "node:assert/strict";
import { serviceDefinition } from "./service.js";
test("service definitions quote paths, use separate v1 identity and require explicit activation", () => {
  const linux = serviceDefinition(
    '/private/config with "quotes" % $HOME',
    "linux",
    "/installed/node",
    "/installed/cli.js",
  );
  assert.match(linux, /UMask=0077/);
  assert.ok(linux.includes('config with \\"quotes\\" %%'));
  assert.ok(linux.includes("$$HOME"));
  assert.ok(!linux.includes("43190"));
  assert.ok(!linux.includes("mission-control-dashboard"));
  const mac = serviceDefinition(
    "/private/a&b",
    "darwin",
    "/installed/node",
    "/installed/cli.js",
  );
  assert.ok(mac.includes("a&amp;b"));
  assert.match(mac, /<key>RunAtLoad<\/key><false\/>/);
  assert.throws(
    () => serviceDefinition("/bad\npath", "linux"),
    /control characters/,
  );
});

import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  symlink,
  link,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceCommand } from "./service.js";
async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  platform = "linux",
) {
  const home = await mkdtemp(join(tmpdir(), "mc-controller-service-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = join(home, "private-config"),
    path =
      platform === "linux"
        ? join(home, ".config/systemd/user/mission-control-v1.service")
        : join(home, "Library/LaunchAgents/org.missioncontrol.v1.plist");
  const calls: string[][] = [];
  let loaded = false,
    active = false,
    fragment = path,
    dropins = "",
    failure: Error | undefined;
  const options = {
    home,
    xdgConfig: join(home, ".config"),
    platform,
    node: "/installed/node",
    cli: "/installed/cli.js",
    execute: async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (failure) throw failure;
      if (args.includes("show"))
        return {
          stdout: `LoadState=${loaded ? "loaded" : "not-found"}\nActiveState=${active ? "active" : "inactive"}\nSubState=${active ? "running" : "dead"}\nUnitFileState=disabled\nFragmentPath=${loaded ? fragment : ""}\nDropInPaths=${dropins}\nNeedDaemonReload=no\n`,
        };
      if (args[0] === "print") {
        if (!loaded)
          throw Object.assign(Error("missing"), {
            code: 113,
            stderr: "Could not find service in domain",
          });
        return {
          stdout: `gui/1000/org.missioncontrol.v1 = {\n path = ${fragment}\n arguments = {\n /installed/node\n /installed/cli.js\n --config-dir\n ${config}\n serve\n }\n}`,
        };
      }
      if (args.includes("daemon-reload"))
        loaded = await readFile(path).then(
          () => true,
          () => false,
        );
      if (
        args.includes("start") ||
        args.includes("restart") ||
        args[0] === "bootstrap" ||
        args[0] === "kickstart"
      ) {
        active = true;
        loaded = true;
      }
      if (args.includes("stop")) active = false;
      if (args[0] === "bootout") {
        active = false;
        loaded = false;
      }
      return { stdout: "" };
    },
  };
  return {
    home,
    config,
    path,
    calls,
    options,
    set: (state: {
      loaded?: boolean;
      active?: boolean;
      fragment?: string;
      dropins?: string;
      failure?: Error;
    }) => {
      loaded = state.loaded ?? loaded;
      active = state.active ?? active;
      fragment = state.fragment ?? fragment;
      dropins = state.dropins ?? dropins;
      failure = state.failure;
    },
  };
}
test("controller Linux lifecycle installs inactive, refuses active uninstall and changes only its v1 unit", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await serviceCommand("status", f.config, f.options)).installed,
    false,
  );
  assert.equal(
    (await serviceCommand("install", f.config, f.options)).started,
    false,
  );
  assert.ok(!f.calls.some((c) => c.includes("start") || c.includes("enable")));
  await serviceCommand("start", f.config, f.options);
  await assert.rejects(
    serviceCommand("uninstall", f.config, f.options),
    /Stop and unload/,
  );
  await serviceCommand("restart", f.config, f.options);
  await serviceCommand("stop", f.config, f.options);
  assert.equal(
    (await serviceCommand("uninstall", f.config, f.options)).uninstalled,
    true,
  );
  assert.equal(
    (await serviceCommand("status", f.config, f.options)).installed,
    false,
  );
  assert.ok(
    f.calls.every((c) => !c.some((v) => /dashboard|orchestrator/.test(v))),
  );
});
test("controller refuses changed config/release, loaded overrides, unsafe files and service-manager failures", async (t) => {
  const f = await fixture(t);
  await serviceCommand("install", f.config, f.options);
  const original = await readFile(f.path, "utf8");
  for (const action of ["status", "start", "stop", "restart", "uninstall"]) {
    await assert.rejects(
      serviceCommand(action, join(f.home, "other"), f.options),
      /differs/,
    );
    await assert.rejects(
      serviceCommand(action, f.config, { ...f.options, cli: "/other/cli" }),
      /differs/,
    );
  }
  f.set({ dropins: "/private/override.conf" });
  await assert.rejects(
    serviceCommand("stop", f.config, f.options),
    /overrides/,
  );
  f.set({ dropins: "", fragment: "/foreign/controller.service" });
  await assert.rejects(
    serviceCommand("restart", f.config, f.options),
    /different definition/,
  );
  f.set({ fragment: f.path, failure: Error("manager unavailable") });
  await assert.rejects(
    serviceCommand("status", f.config, f.options),
    /manager unavailable/,
  );
  f.set({});
  await chmod(f.path, 0o644);
  await assert.rejects(
    serviceCommand("uninstall", f.config, f.options),
    /differs/,
  );
  await chmod(f.path, 0o600);
  await link(f.path, join(f.home, "alias"));
  await assert.rejects(serviceCommand("stop", f.config, f.options), /differs/);
  await rm(join(f.home, "alias"));
  await writeFile(f.path, original + "# changed\n");
  await assert.rejects(
    serviceCommand("uninstall", f.config, f.options),
    /differs/,
  );
  await rm(f.path);
  await writeFile(join(f.home, "foreign"), original, { mode: 0o600 });
  await symlink(join(f.home, "foreign"), f.path);
  await assert.rejects(serviceCommand("stop", f.config, f.options), /differs/);
});
test("controller rejects redirected service directories and loaded jobs without an owned file", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, ".config/systemd"), { recursive: true });
  await mkdir(join(f.home, "foreign"));
  await symlink(join(f.home, "foreign"), join(f.home, ".config/systemd/user"));
  await assert.rejects(
    serviceCommand("install", f.config, f.options),
    /directory is redirected/,
  );
  await rm(join(f.home, ".config/systemd/user"));
  f.set({ loaded: true, active: true });
  await assert.rejects(
    serviceCommand("status", f.config, f.options),
    /remains loaded/,
  );
  await assert.rejects(
    serviceCommand("install", f.config, f.options),
    /already loaded/,
  );
});
test("launchd lifecycle bootstraps explicitly and distinguishes unloaded from failed inspection", async (t) => {
  const f = await fixture(t, "darwin");
  await serviceCommand("install", f.config, f.options);
  assert.ok(!f.calls.some((c) => c.includes("bootstrap")));
  await assert.rejects(
    serviceCommand("restart", f.config, f.options),
    /not loaded/,
  );
  await serviceCommand("start", f.config, f.options);
  await assert.rejects(
    serviceCommand("start", f.config, f.options),
    /is loaded/,
  );
  await serviceCommand("restart", f.config, f.options);
  await assert.rejects(
    serviceCommand("uninstall", f.config, f.options),
    /Stop and unload/,
  );
  f.set({ fragment: "/other.plist" });
  await assert.rejects(
    serviceCommand("stop", f.config, f.options),
    /different launchd/,
  );
  f.set({
    fragment: f.path,
    failure: Object.assign(Error("permission denied"), {
      code: 1,
      stderr: "Operation not permitted",
    }),
  });
  await assert.rejects(
    serviceCommand("status", f.config, f.options),
    /permission denied/,
  );
  f.set({});
  await serviceCommand("stop", f.config, f.options);
  await serviceCommand("stop", f.config, f.options);
  await serviceCommand("uninstall", f.config, f.options);
  assert.ok(f.calls.some((c) => c.includes("bootstrap")));
  assert.ok(f.calls.some((c) => c.includes("bootout")));
});
