import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ControlStore } from "./store.js";
import type { NativeExecution } from "./backend.js";
import { EnvironmentRegistry, type ExecutionSession } from "./environments.js";
import { GatewayNetworkManager } from "./gatewayNetwork.js";
import { subscriptionEgress } from "./subscriptionEgress.js";
import {
  acquireAuthEnvironment,
  inspectAuthEnvironment,
  recoverAuthEnvironment,
  type AuthEnvironment,
} from "./authEnvironment.js";

const exec = promisify(execFile);
type Docker = (args: string[]) => Promise<{ stdout: string; stderr: string }>;
interface AuthRun {
  id: string;
  authId: string;
  identity: string;
  worker: string;
  image: string;
  status: "preparing" | "running" | "stopping" | "stopped";
  startedAt: string;
  executionSessionId?: string;
}
const registry = "subscription-auth-runs";
const relayScript = fileURLToPath(
  new URL("../../environments/worker/subscription-egress.py", import.meta.url),
);
// Proxy capability travels over stdin, never in Docker CLI arguments/configuration.
const runner = `import json,os,sys\nline=b''\nwhile not line.endswith(b'\\n'):line+=os.read(0,1)\nc=json.loads(line)\nos.umask(0o077)\nos.makedirs('/tmp/mc-home',mode=0o700,exist_ok=True)\ne={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/tmp/mc-home','LANG':'C.UTF-8','TERM':'dumb','HTTPS_PROXY':c['proxy'],'HTTP_PROXY':c['proxy'],'https_proxy':c['proxy'],'http_proxy':c['proxy'],'NO_PROXY':'','no_proxy':'','NODE_USE_ENV_PROXY':'1','DO_NOT_TRACK':'1','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'}\ne.update(c['environment'])\nif c.get('outputSchema'):\n with open('/tmp/mc-output-schema.json','w') as f:json.dump(c['outputSchema'],f)\nos.chdir(c.get('workingDirectory','/tmp/mc-home'))\nos.execvpe(c['argv'][0],c['argv'],e)\n`;
export function authInvocation(
  config: AuthEnvironment,
  action: "login" | "status",
): { argv: string[]; environment: Record<string, string> } {
  return config.harness === "codex"
    ? {
        argv: [
          "codex",
          "-c",
          'cli_auth_credentials_store="file"',
          "-c",
          'forced_login_method="chatgpt"',
          "login",
          ...(action === "login" ? ["--device-auth"] : ["status"]),
        ],
        environment: { CODEX_HOME: "/session" },
      }
    : {
        argv: [
          "claude",
          "--safe-mode",
          "--disable-slash-commands",
          "auth",
          action,
          ...(action === "login" ? ["--claudeai"] : ["--json"]),
        ],
        environment: {
          CLAUDE_CONFIG_DIR: "/session",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_AUTO_UPDATE: "1",
        },
      };
}
function statusResult(
  config: AuthEnvironment,
  exitCode: number,
  content: string,
) {
  if (config.harness === "codex") {
    if (exitCode === 0 && /^Logged in using ChatGPT\s*$/i.test(content.trim()))
      return "authenticated";
    if (/^Not logged in\s*$/i.test(content.trim())) return "logged_out";
    return "unrecognized";
  }
  try {
    const value = JSON.parse(content);
    if (
      exitCode === 0 &&
      value.loggedIn === true &&
      value.authMethod === "claude.ai"
    )
      return "authenticated";
    if (value.loggedIn === false) return "logged_out";
    return "unrecognized";
  } catch {
    return "unrecognized";
  } // Unknown native status formats are never admission proof.
}
export class AuthRuntime {
  readonly networks: GatewayNetworkManager;
  private bridge?: Awaited<ReturnType<typeof subscriptionEgress>>;
  private active = false;
  private assertAuthority = () => {};
  constructor(
    readonly store: ControlStore,
    readonly stateDir: string,
    readonly secretsRoot: string,
    readonly config: AuthEnvironment,
    readonly docker: Docker = (args) =>
      exec("docker", args, { timeout: 60000, env: { PATH: process.env.PATH } }),
    readonly startBridge = subscriptionEgress,
    readonly launch: typeof spawn = spawn,
  ) {
    this.networks = new GatewayNetworkManager(
      store.db,
      () => {
        this.active = false;
      },
      docker,
      {
        start: async (_id, container, script) => {
          this.bridge = await startBridge(
            container,
            script,
            config.egress,
            this.proxyToken,
            () => {
              this.assertAuthority();
              if (!this.active)
                throw new Error("Auth runtime authority revoked");
            },
          );
        },
        stop: async () => {
          await this.bridge?.stop();
        },
      },
    );
  }
  private proxyToken = randomBytes(32).toString("hex");
  private runs() {
    return (this.store.setting(registry) as AuthRun[] | undefined) ?? [];
  }
  private save(run: AuthRun) {
    this.store.setting(registry, [
      ...this.runs().filter((r) => r.id !== run.id),
      run,
    ]);
  }
  private labels(run: AuthRun) {
    return {
      "missioncontrol.auth": run.authId,
      "missioncontrol.auth-instance": run.identity,
      "missioncontrol.auth-run": run.id,
    };
  }
  private async object(name: string) {
    try {
      return JSON.parse((await this.docker(["inspect", name])).stdout)[0];
    } catch (error) {
      if (/No such (object|container)/i.test(String((error as any).stderr)))
        return null;
      throw error;
    }
  }
  private async cleanup(run: AuthRun) {
    this.active = false;
    this.save({ ...run, status: "stopping" });
    await this.bridge?.stop();
    const worker = await this.object(run.worker);
    if (worker) {
      if (
        Object.entries(this.labels(run)).some(
          ([k, v]) => worker.Config.Labels?.[k] !== v,
        )
      )
        throw new Error("Auth container ownership mismatch; cleanup refused");
      await this.docker(["rm", "-f", run.worker]);
    }
    if (run.executionSessionId) {
      const registry = new EnvironmentRegistry(
        join(this.stateDir, "sandbox"),
        this.store.db,
      );
      const session = registry.get(run.executionSessionId);
      if (session.container && session.container !== run.worker)
        throw Error(
          "Subscription source resource differs from recorded writer",
        );
      registry.save({
        ...session,
        status: "checkpointed",
        container: undefined,
      });
    }
    const network = this.networks.records().find((r) => r.sessionId === run.id);
    if (network && network.status !== "stopped")
      await this.networks.stop(run.id);
    this.save({ ...run, status: "stopped" });
  }
  async recover(nonce: string) {
    const inspected = await inspectAuthEnvironment(
      this.config,
      this.secretsRoot,
    );
    return recoverAuthEnvironment(
      this.config,
      this.secretsRoot,
      nonce,
      async () => {
        for (const run of this.runs().filter(
          (r) => r.authId === this.config.id && r.status !== "stopped",
        )) {
          if (run.identity !== inspected.identity.instance)
            throw new Error("Recorded authentication identity differs");
          await this.cleanup(run);
        }
      },
    );
  }
  /** Startup caller owns application state; never unlocks a live/foreign writer. */
  async reconcileStartup() {
    const inspected = await inspectAuthEnvironment(
      this.config,
      this.secretsRoot,
    );
    const pending = this.runs().filter(
      (r) => r.authId === this.config.id && r.status !== "stopped",
    );
    if (inspected.writer) return this.recover(inspected.writer.nonce);
    for (const run of pending) {
      if (run.identity !== inspected.identity.instance)
        throw Error(
          "Authentication recovery identity differs; admission closed",
        );
      await this.cleanup(run);
    }
    return {
      recovered: pending.length > 0,
      id: this.config.id,
      qualified: false,
    };
  }
  private async owned<T>(
    session: ExecutionSession | undefined,
    assertAuthority: () => void,
    signal: AbortSignal | undefined,
    use: (
      execute: (
        invocation: ReturnType<typeof authInvocation>,
        interactive?: boolean,
      ) => ReturnType<typeof spawn>,
    ) => Promise<T>,
  ): Promise<T> {
    const registry = new EnvironmentRegistry(
      join(this.stateDir, "sandbox"),
      this.store.db,
    );
    const owner = await acquireAuthEnvironment(this.config, this.secretsRoot);
    const stale = this.runs().filter(
      (r) => r.authId === this.config.id && r.status !== "stopped",
    );
    if (stale.length) {
      await owner.release();
      throw new Error(
        "Authentication has unreconciled containers; recover the recorded writer before use",
      );
    }
    const id = "auth_" + randomUUID().replaceAll("-", ""),
      run: AuthRun = {
        id,
        authId: this.config.id,
        identity: owner.identity.instance,
        worker: `mc-${id}`,
        image: this.config.imageDigest,
        status: "preparing",
        startedAt: new Date().toISOString(),
        executionSessionId: session?.id,
      };
    let timer: NodeJS.Timeout | undefined,
      children = new Set<ReturnType<typeof spawn>>();
    const abort = () => {
      this.active = false;
      for (const child of children) child.kill("SIGKILL");
    };
    try {
      this.assertAuthority = assertAuthority;
      this.assertAuthority();
      this.save(run);
      await owner.privateFiles();
      this.active = true;
      signal?.throwIfAborted();
      signal?.addEventListener("abort", abort, { once: true });
      const network = await this.networks.acquire({
        sessionId: id,
        generation: 1,
        imageDigest: this.config.imageDigest,
        socketDirectory: join(this.stateDir, "unused-auth-socket"),
        relayScript,
      });
      if (!this.active) throw new Error("Authentication cancelled");
      if (session) {
        registry.save({
          ...session,
          container: run.worker,
          status: "starting",
        });
      }
      await this.docker([
        "create",
        "--name",
        run.worker,
        ...Object.entries(this.labels(run)).flatMap(([k, v]) => [
          "--label",
          `${k}=${v}`,
        ]),
        ...(session
          ? [
              "--label",
              `missioncontrol.session=${session.id}`,
              "--label",
              `missioncontrol.generation=${session.generation}`,
            ]
          : []),
        "--network",
        network.network,
        "--user",
        `${process.getuid?.()}:${process.getgid?.()}`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--pids-limit",
        "256",
        "--memory",
        `${session?.spec.memoryMiB ?? 1024}m`,
        "--memory-swap",
        `${session?.spec.memoryMiB ?? 1024}m`,
        "--cpus",
        String(session?.spec.cpu ?? 1),
        "--log-driver",
        "none",
        "--mount",
        `type=bind,src=${owner.session},dst=/session`,
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777",
        ...(this.config.harness === "codex"
          ? [
              "--tmpfs",
              `/session/tmp:rw,nosuid,nodev,size=32m,uid=${process.getuid?.()},gid=${process.getgid?.()},mode=700`,
            ]
          : []),
        ...(session
          ? ["--mount", `type=bind,src=${session.path},dst=/workspace`]
          : [
              "--tmpfs",
              `/workspace:rw,nosuid,nodev,size=64m,uid=${process.getuid?.()},gid=${process.getgid?.()},mode=700`,
            ]),
        "--entrypoint",
        "sleep",
        this.config.imageDigest,
        "infinity",
      ]);
      await this.docker(["start", run.worker]);
      this.save({ ...run, status: "running" });
      if (session)
        registry.save({ ...session, container: run.worker, status: "active" });

      const execute = (
        invocation: ReturnType<typeof authInvocation>,
        interactive = false,
      ) => {
        assertAuthority();
        signal?.throwIfAborted();
        if (!this.active) throw Error("Subscription runtime authority revoked");
        const child = this.launch(
          "docker",
          ["exec", "-i", run.worker, "python3", "-u", "-c", runner],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: { PATH: process.env.PATH },
            detached: process.platform !== "win32",
          },
        );
        child.stdin!.on("error", () => {});
        children.add(child);
        child.once("close", () => children.delete(child));
        child.stdin!.write(
          JSON.stringify({
            proxy: `http://missioncontrol:${this.proxyToken}@inference-gateway:8081`,
            ...invocation,
            workingDirectory:
              invocation.argv.includes("auth") ||
              invocation.argv.includes("login")
                ? "/tmp/mc-home"
                : "/workspace",
          }) + "\n",
        );
        if (interactive) process.stdin.pipe(child.stdin!);
        return child;
      };
      timer = setTimeout(
        abort,
        Math.min(
          this.config.egress.timeoutMs,
          session?.spec.timeoutMs ?? this.config.egress.timeoutMs,
        ),
      );
      const result = await use(execute);
      signal?.throwIfAborted();
      assertAuthority();
      if (!this.active)
        throw Error("Subscription execution exceeded its time limit");
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      for (const child of children)
        if (child.stdin) process.stdin.unpipe(child.stdin);
      abort();
      // Failed teardown deliberately retains the writer lock/recovery record.
      await this.cleanup(run);
      await owner.privateFiles();
      await owner.release();
      this.assertAuthority = () => {};
    }
  }
  /** Offline login/status; callback output is never retained in the application DB. */
  async run(action: "login" | "status", signal?: AbortSignal) {
    return this.owned(
      undefined,
      () => {},
      signal,
      async (execute) => {
        const result = await this.statusCommand(
          execute(authInvocation(this.config, action), action === "login"),
          action === "login",
        );
        const authenticationState =
          action === "status"
            ? statusResult(this.config, result.code, result.content)
            : undefined;
        return {
          id: this.config.id,
          action,
          nativeCommandSucceeded: result.code === 0,
          authenticationState,
          authenticated: authenticationState
            ? authenticationState === "authenticated"
            : undefined,
          qualified: false,
        };
      },
    );
  }
  private statusCommand(child: ReturnType<typeof spawn>, interactive = false) {
    return new Promise<{ code: number; content: string }>((resolve, reject) => {
      let content = "",
        bytes = 0;
      const collect = (chunk: Buffer, stderr: boolean) => {
        bytes += chunk.length;
        if (bytes > 128 * 1024) {
          child.kill("SIGKILL");
          reject(
            Error("Authentication output exceeded private terminal bound"),
          );
          return;
        }
        if (interactive)
          (stderr ? process.stderr : process.stdout).write(chunk);
        else content += chunk.toString();
      };
      child.stdout!.on("data", (c) => collect(c, false));
      child.stderr!.on("data", (c) => collect(c, true));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? -1, content }));
      child.stdin!.on("error", reject);
      if (!interactive) child.stdin!.end();
    });
  }
  /** Feasibility adapter only. Production admission remains closed until qualified. */
  async withCoding<T>(
    session: ExecutionSession,
    assertAuthority: () => void,
    signal: AbortSignal,
    use: (execution: NativeExecution) => Promise<T>,
  ) {
    const registry = new EnvironmentRegistry(
      join(this.stateDir, "sandbox"),
      this.store.db,
    );
    const recorded = registry.get(session.id);
    if (
      JSON.stringify(recorded) !== JSON.stringify(session) ||
      session.status !== "prepared" ||
      session.container ||
      session.image !== this.config.imageDigest ||
      session.path.includes(",")
    )
      throw Error(
        "Subscription coding requires a recorded, prepared, image-matched private source",
      );
    await registry.owned(session);
    return this.owned(session, assertAuthority, signal, async (execute) => {
      // Status and coding share one writer, source and admission deadline. There is no lock gap during refresh.
      const status = await this.statusCommand(
        execute(authInvocation(this.config, "status")),
      );
      if (
        statusResult(this.config, status.code, status.content) !==
        "authenticated"
      )
        throw Error(
          "Subscription login is unavailable or unrecognized; reauthenticate explicitly",
        );
      return use({
        workspace: "/workspace",
        spawn: (command, args, outputSchema) => {
          const expected = this.config.harness === "codex" ? "codex" : "claude";
          if (command !== expected)
            throw Error(
              "Subscription coding must use its pinned native harness",
            );
          return execute({
            argv: [
              command,
              ...args,
              ...(outputSchema && command === "codex"
                ? ["--output-schema", "/tmp/mc-output-schema.json"]
                : []),
            ],
            ...(outputSchema ? { outputSchema } : {}),
            environment: authInvocation(this.config, "status").environment,
          }) as ReturnType<NativeExecution["spawn"]>;
        },
      });
    });
  }
}
