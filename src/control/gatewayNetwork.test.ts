import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../sqlite.js";
import { GatewayNetworkManager } from "./gatewayNetwork.js";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "mc-network-"));
  const socketDirectory = join(root, "socket");
  await mkdir(socketDirectory, { mode: 0o700 });
  const server = createServer();
  server.listen(join(socketDirectory, "inference.sock"));
  await once(server, "listening");
  await chmod(join(socketDirectory, "inference.sock"), 0o600);
  const relayScript = join(root, "relay.py");
  await writeFile(relayScript, "# trusted relay");
  const db = new SqliteStore(join(root, "state.db"));
  const objects = new Map<string, any>(),
    calls: string[][] = [],
    revoked: string[] = [];
  let outage = false,
    crash = false;
  const docker = async (args: string[]) => {
    calls.push(args);
    if (outage)
      throw Object.assign(new Error("daemon unavailable"), {
        stderr: "daemon unavailable",
      });
    const kind = args[0] === "network" ? args[1] : args[0];
    const name = args[0] === "network" ? args[2] : args[1];
    if (kind === "inspect") {
      if (!objects.has(name))
        throw Object.assign(new Error("absent"), {
          stderr: "Error: No such object: " + name,
        });
      return { stdout: JSON.stringify([objects.get(name)]), stderr: "" };
    }
    if (kind === "create") {
      const labels = Object.fromEntries(
        args.flatMap((a, i) =>
          a === "--label" ? [args[i + 1].split("=")] : [],
        ),
      );
      if (args[0] === "network")
        objects.set(args.at(-1)!, {
          Internal: true,
          Driver: "bridge",
          EnableIPv6: false,
          Labels: labels,
          Containers: {},
          Options: {
            "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
          },
        });
      else
        objects.set(args[args.indexOf("--name") + 1], {
          Image: args.at(-2),
          Config: { Labels: labels },
          HostConfig: { NetworkMode: args[args.indexOf("--network") + 1] },
          State: { Running: false },
        });
    }
    if (kind === "start") objects.get(name).State.Running = true;
    if (kind === "rm") {
      objects.delete(args.at(-1)!);
      if (crash) {
        crash = false;
        throw new Error("crash after removal");
      }
    }
    return { stdout: "", stderr: "" };
  };
  const manager = new GatewayNetworkManager(db, (s) => revoked.push(s), docker);
  const spec = {
    sessionId: "session_1",
    generation: 1,
    imageDigest: `sha256:${"a".repeat(64)}`,
    socketDirectory,
    relayScript,
  };
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    await rm(root, { recursive: true });
  });
  return {
    manager,
    spec,
    objects,
    calls,
    revoked,
    docker,
    db,
    outage: () => {
      outage = true;
    },
    crash: () => {
      crash = true;
    },
  };
}
test("gateway acquisition recovers preparation without duplicate resources and enforces private mounts", async (t) => {
  const f = await fixture(t);
  const record = await f.manager.acquire(f.spec);
  await f.manager.acquire(f.spec);
  assert.equal(f.calls.filter((a) => a[0] === "create").length, 1);
  assert.equal(
    f.calls.filter((a) => a[0] === "network" && a[1] === "create").length,
    1,
  );
  const create = f.calls.find((a) => a[0] === "create")!;
  assert.ok(
    create.includes(
      `type=bind,src=${f.spec.socketDirectory},dst=/gateway,readonly`,
    ),
  );
  assert.ok(create.includes("no-new-privileges"));
  assert.equal(record.status, "active");
  await assert.rejects(
    f.manager.acquire({ ...f.spec, generation: 2 }),
    /lineage/,
  );
});
test("gateway teardown revokes first, refuses attached workers and reconciles removal crashes", async (t) => {
  const f = await fixture(t),
    record = await f.manager.acquire(f.spec);
  f.objects.get(record.network).Containers = { worker: { Name: "mc-worker" } };
  await assert.rejects(f.manager.stop(record.sessionId), /Stop worker/);
  assert.equal(f.revoked[0], record.sessionId);
  assert.ok(f.objects.has(record.relay));
  f.objects.get(record.network).Containers = {};
  f.crash();
  await assert.rejects(f.manager.stop(record.sessionId), /crash/);
  const restarted = new GatewayNetworkManager(
    f.db,
    (s) => f.revoked.push(s),
    f.docker,
  );
  await restarted.reconcile();
  assert.equal(restarted.records()[0].status, "stopped");
  assert.equal(f.objects.size, 0);
});
test("daemon failure and foreign resource labels never authorize cleanup or recreation", async (t) => {
  const f = await fixture(t),
    record = await f.manager.acquire(f.spec);
  f.objects.get(record.relay).Config.Labels = {};
  await assert.rejects(f.manager.stop(record.sessionId), /ownership/);
  assert.equal(f.objects.size, 2);
  f.outage();
  await assert.rejects(f.manager.reconcile(), /daemon unavailable/);
  assert.equal(f.manager.records()[0].status, "stopping");
});
