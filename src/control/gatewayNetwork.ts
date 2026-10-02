import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SqliteStore, sql } from "../sqlite.js";
import { ControlError } from "./schema.js";
const exec = promisify(execFile);
export interface GatewayNetworkRecord {
  sessionId: string;
  generation: number;
  network: string;
  relay: string;
  imageDigest: string;
  socketDirectory: string;
  relayScript: string;
  transport?: "stdio";
  status: "preparing" | "active" | "stopping" | "stopped";
  updatedAt: number;
}
type Docker = (args: string[]) => Promise<{ stdout: string; stderr: string }>;
// One network per execution session: unrelated workers never share a network.
export class GatewayNetworkManager {
  constructor(
    readonly db: SqliteStore,
    readonly revoke: (sessionId: string) => void,
    readonly docker: Docker = (args) =>
      exec("docker", args, { timeout: 60000 }),
    readonly bridge?: {
      start(
        sessionId: string,
        container: string,
        relayScript: string,
      ): Promise<void>;
      stop(sessionId: string): Promise<void>;
    },
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS gateway_networks(session_id TEXT PRIMARY KEY,record TEXT NOT NULL);",
    );
  }
  records(): GatewayNetworkRecord[] {
    return this.db
      .query<{ record: string }>("SELECT record FROM gateway_networks")
      .map((r) => JSON.parse(r.record));
  }
  private save(record: GatewayNetworkRecord) {
    record = { ...record, updatedAt: Date.now() };
    this.db.exec(
      `INSERT INTO gateway_networks VALUES(${sql(record.sessionId)},${sql(this.db.redactor.json(record))}) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record`,
    );
    return record;
  }
  private async object(kind: "network" | "container", name: string) {
    try {
      return JSON.parse(
        (
          await this.docker(
            kind === "network"
              ? ["network", "inspect", name]
              : ["inspect", name],
          )
        ).stdout,
      )[0];
    } catch (error) {
      // Daemon outages/permission failures are not evidence of absence.
      const message = String((error as any).stderr).trim();
      if (
        /No such (network|object|container)/i.test(message) ||
        message === `Error response from daemon: network ${name} not found`
      )
        return null;
      throw error;
    }
  }
  private labels(record: GatewayNetworkRecord) {
    return {
      "missioncontrol.gateway": "true",
      "missioncontrol.session": record.sessionId,
      "missioncontrol.generation": String(record.generation),
    };
  }
  private assertOwner(
    record: GatewayNetworkRecord,
    labels: Record<string, string> | undefined,
  ) {
    if (
      Object.entries(this.labels(record)).some(
        ([key, value]) => labels?.[key] !== value,
      )
    )
      throw new ControlError(
        "gateway_owner",
        "Gateway resource ownership mismatch",
        409,
      );
  }
  async acquire(
    spec: Pick<
      GatewayNetworkRecord,
      | "sessionId"
      | "generation"
      | "imageDigest"
      | "socketDirectory"
      | "relayScript"
    >,
  ) {
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(spec.sessionId) ||
      !Number.isSafeInteger(spec.generation) ||
      spec.generation < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(spec.imageDigest)
    )
      throw new ControlError(
        "gateway_policy",
        "Invalid gateway session or pinned image",
        409,
      );
    if (process.getuid?.() === 0)
      throw new ControlError(
        "gateway_policy",
        "Gateway relay requires a non-root controller",
        409,
      );
    for (const path of this.bridge
      ? [spec.relayScript]
      : [spec.socketDirectory, spec.relayScript]) {
      if (
        path.includes(",") ||
        resolve(path) !== path ||
        (await realpath(path)) !== path ||
        (await lstat(path)).isSymbolicLink()
      )
        throw new ControlError(
          "gateway_path",
          "Gateway paths must be canonical controller-owned paths",
          409,
        );
    }
    if (!this.bridge) {
      const socket = await lstat(`${spec.socketDirectory}/inference.sock`);
      const directory = await lstat(spec.socketDirectory);
      if (
        !directory.isDirectory() ||
        !socket.isSocket() ||
        socket.uid !== process.getuid?.() ||
        socket.mode & 0o077 ||
        directory.uid !== process.getuid?.() ||
        directory.mode & 0o077
      )
        throw new ControlError(
          "gateway_path",
          "Gateway socket must be private to the controller",
          409,
        );
    }
    let record = this.records().find((r) => r.sessionId === spec.sessionId);
    if (
      record &&
      Object.entries(spec).some(
        ([key, value]) => (record as any)[key] !== value,
      )
    )
      throw new ControlError(
        "gateway_lineage",
        "Gateway session lineage changed",
        409,
      );
    if (record?.status === "stopping")
      throw new ControlError(
        "gateway_state",
        "Reconcile gateway teardown before acquisition",
        409,
      );
    if (record?.transport === "stdio" && !this.bridge)
      throw new ControlError(
        "gateway_transport",
        "Recorded portable relay requires its controller stdio bridge",
        409,
      );
    record = this.save(
      record
        ? { ...record, status: "preparing" }
        : {
            ...spec,
            ...(this.bridge ? { transport: "stdio" as const } : {}),
            network: `mc-net-${spec.sessionId}`,
            relay: `mc-relay-${spec.sessionId}`,
            status: "preparing",
            updatedAt: Date.now(),
          },
    );
    const network = await this.object("network", record.network);
    if (network) {
      this.assertOwner(record, network.Labels);
      if (
        !network.Internal ||
        network.Driver !== "bridge" ||
        network.EnableIPv6 ||
        network.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] !==
          "isolated"
      )
        throw new ControlError(
          "gateway_network",
          "Recorded gateway network lost isolation",
          409,
        );
    } else {
      await this.docker([
        "network",
        "create",
        "--internal",
        "--opt",
        "com.docker.network.bridge.gateway_mode_ipv4=isolated",
        ...Object.entries(this.labels(record)).flatMap(([k, v]) => [
          "--label",
          `${k}=${v}`,
        ]),
        record.network,
      ]);
    }
    const relay = await this.object("container", record.relay);
    if (relay) {
      this.assertOwner(record, relay.Config.Labels);
      if (
        relay.Image !== record.imageDigest ||
        relay.HostConfig.NetworkMode !== record.network
      )
        throw new ControlError(
          "gateway_lineage",
          "Recorded relay image/network changed",
          409,
        );
    } else {
      await this.docker([
        "create",
        "--name",
        record.relay,
        ...Object.entries(this.labels(record)).flatMap(([k, v]) => [
          "--label",
          `${k}=${v}`,
        ]),
        "--network",
        record.network,
        "--network-alias",
        "inference-gateway",
        "--user",
        `${process.getuid?.()}:${process.getgid?.()}`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--pids-limit",
        "32",
        "--memory",
        "128m",
        "--memory-swap",
        "128m",
        "--cpus",
        "0.25",
        ...(this.bridge
          ? ["--entrypoint", "sleep", record.imageDigest, "infinity"]
          : [
              "--mount",
              `type=bind,src=${record.socketDirectory},dst=/gateway,readonly`,
              "--mount",
              `type=bind,src=${record.relayScript},dst=/relay.py,readonly`,
              "--entrypoint",
              "python3",
              record.imageDigest,
              "/relay.py",
            ]),
      ]);
    }
    if (!relay?.State.Running) await this.docker(["start", record.relay]);
    if (this.bridge)
      await this.bridge.start(
        record.sessionId,
        record.relay,
        record.relayScript,
      );
    return this.save({ ...record, status: "active" });
  }
  async stop(sessionId: string) {
    const record = this.records().find((r) => r.sessionId === sessionId);
    if (!record)
      throw new ControlError("not_found", "Gateway session not found", 404);
    this.revoke(sessionId);
    await this.bridge?.stop(sessionId);
    this.save({ ...record, status: "stopping" });
    const network = await this.object("network", record.network);
    const relay = await this.object("container", record.relay);
    if (network) {
      this.assertOwner(record, network.Labels);
      if (
        Object.values(network.Containers ?? {}).some(
          (c: any) => c.Name !== record.relay,
        )
      )
        throw new ControlError(
          "active_work",
          "Stop worker execution before removing its gateway",
          409,
        );
    }
    if (relay) {
      this.assertOwner(record, relay.Config.Labels);
      await this.docker(["rm", "-f", record.relay]);
    }
    if (network) await this.docker(["network", "rm", record.network]);
    return this.save({ ...record, status: "stopped" });
  }
  async reconcile() {
    // After a controller restart no prior inference capability remains authorized.
    for (const record of this.records()) {
      this.revoke(record.sessionId);
      if (record.status !== "stopped") await this.stop(record.sessionId);
    }
  }
}
