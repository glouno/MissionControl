import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { terminateProcessTree } from "../util.js";
import { createInterface } from "node:readline";
import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  realpath,
} from "node:fs/promises";
import { dirname, join, relative, resolve, matchesGlob } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type ModelMessage,
  type ModelProvider,
  type ToolCall,
  type ToolDefinition,
} from "./providers.js";
import {
  questionSchema,
  type BackendConfig,
  type Claim,
  type QuestionInput,
  type Review,
} from "./schema.js";
import { git } from "./workspaces.js";
import {
  type RunContext,
  type BackendResult,
  type AgentBackend,
  HumanWait,
} from "./backend.js";
export {
  type RunContext,
  type BackendResult,
  type AgentBackend,
  HumanWait,
} from "./backend.js";
import { ClaudeCodeBackend } from "./claudeCode.js";
import { handoffTools, parseHandoff } from "./workerHandoff.js";
export function createBackend(config: BackendConfig): AgentBackend {
  switch (config.kind) {
    case "fake":
      return new FakeBackend();
    case "claude-code":
      return new ClaudeCodeBackend(config);
    case "codex":
      return new CodexBackend(config);
    case "azure":
    case "bedrock":
      throw new Error(
        "Metered tool-loop execution requires the configured isolated runtime and controller-owned provider",
      );
    default: {
      const unsupported: never = config;
      throw new Error(
        `Unsupported agent backend: ${JSON.stringify(unsupported)}`,
      );
    }
  }
}
export class FakeBackend implements AgentBackend {
  async run(c: RunContext): Promise<BackendResult> {
    if (c.signal.aborted) throw c.signal.reason;
    let text = "";
    if (c.mode === "plan")
      text = JSON.stringify({
        tasks: [
          {
            key: "implement",
            title: c.claim.goal.config.title,
            description: c.claim.goal.config.description,
            dependencies: [],
            allowedPaths: ["**"],
            acceptanceCriteria: [
              "The synthetic goal artifact exists and its configured checks pass",
            ],
            verificationCommands: c.claim.goal.config.verificationCommands,
          },
        ],
      });
    else if (c.mode === "review")
      text = JSON.stringify({
        commit: await git(c.workspace, ["rev-parse", "HEAD"]),
        verdict: "pass",
        findings: [],
      });
    else {
      await writeFile(
        join(c.workspace, `${c.claim.task.key}.txt`),
        `${c.claim.task.spec.description}\n`,
      );
      text = "Implementation complete";
    }
    return {
      text,
      usage: { kind: "synthetic" as const },
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
export const portableTools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a workspace text file",
    parameters: object({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "write_file",
    description: "Write a scoped workspace text file",
    parameters: object(
      { path: { type: "string" }, content: { type: "string" } },
      ["path", "content"],
    ),
  },
  {
    name: "list_files",
    description: "List files in a workspace directory",
    parameters: object({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "shell",
    description: "Run a command inside the isolated development container",
    parameters: object({ command: { type: "string" } }, ["command"]),
  },
  {
    name: "request_human_input",
    description: "Checkpoint and ask a durable human question",
    parameters: z.toJSONSchema(questionSchema, { io: "input" }),
  },
  {
    name: "checkpoint",
    description: "Save a continuation summary",
    parameters: object({ summary: { type: "string" } }, ["summary"]),
  },
];
export class PortableBackend implements AgentBackend {
  constructor(readonly provider: ModelProvider) {}
  async run(c: RunContext) {
    const saved = c.claim.task.checkpoint?.messages as
      ModelMessage[] | undefined;
    const messages: ModelMessage[] = saved
      ? [...saved, { role: "user", content: c.prompt }]
      : [{ role: "user", content: c.prompt }];
    let costUsd = 0,
      inputTokens = 0,
      outputTokens = 0;
    const completed = new Map<string, string>();
    const pendingTool = c.claim.task.checkpoint?.pendingTool;
    if (pendingTool) {
      if (pendingTool.name === "shell")
        throw new HumanWait({
          question:
            "An interrupted shell tool may have already changed state. Authorize a new attempt after inspecting the checkpoint?",
          reason: `Tool ${pendingTool.id}: ${JSON.stringify(pendingTool.arguments)}`,
          options: [
            { id: "inspect", label: "Inspected; continue without replay" },
            { id: "stop", label: "Stop and investigate" },
          ],
          category: "policy",
        });
      messages.push({
        role: "tool",
        callId: pendingTool.id,
        content:
          "Execution interrupted before result persistence; inspect the workspace before repeating this tool.",
      });
    }
    let tools =
      c.mode === "implement"
        ? portableTools
        : portableTools.filter((t) =>
            ["read_file", "list_files", "shell"].includes(t.name),
          );
    if (c.disableTaskHandoffs)
      tools = tools.filter((t) => t.name !== "request_human_input");
    for (let turn = 0; turn < 40; turn++) {
      if (c.signal.aborted) throw c.signal.reason;
      const ceiling = c.claim.goal.config.estimatePerRunUsd;
      const upper = this.provider.cost({
        text: "",
        calls: [],
        inputTokens: Math.ceil(JSON.stringify(messages).length / 2) + 1000,
        outputTokens: 8192,
      });
      if (ceiling > 0 && costUsd + upper > ceiling) {
        await c.onCheckpoint(
          "Paused before inference would exceed the reserved estimate",
          messages,
          undefined,
          costUsd,
        );
        const requestedRunEstimateUsd = Math.max(ceiling * 2, costUsd + upper);
        throw Object.assign(
          new HumanWait({
            question: "Increase the authorized run estimate and goal budget?",
            reason:
              "The next model call exceeds the current reservation; billing remains estimated.",
            options: [
              { id: "approve", label: "Authorize the proposed limits" },
              { id: "reject", label: "Keep current limits" },
            ],
            category: "spending",
            requestedRunEstimateUsd,
            requestedMaxCostUsd:
              c.claim.goal.config.maxCostUsd + requestedRunEstimateUsd,
          }),
          { costUsd },
        );
      }
      let r: Awaited<ReturnType<ModelProvider["generate"]>>;
      try {
        r = await this.provider.generate(messages, tools, c.signal);
      } catch (error) {
        if (error instanceof Error)
          Object.assign(error, {
            costUsd: undefined,
            usage: { kind: "metered", status: "unknown" },
            costStatus: "estimated_unknown",
          });
        throw error;
      }
      const measuredCost = this.provider.cost(r);
      if (!Number.isFinite(measuredCost) || measuredCost < 0)
        throw Object.assign(
          new Error("Provider returned invalid estimated cost"),
          { usage: { kind: "metered", status: "unknown" } },
        );
      costUsd += measuredCost;
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      messages.push({ role: "assistant", content: r.text, calls: r.calls });
      if (!r.calls.length)
        return {
          text: r.text,
          usage: {
            kind: "metered" as const,
            status: "estimated" as const,
            costUsd,
            inputTokens,
            outputTokens,
          },
          costUsd,
          inputTokens,
          outputTokens,
        };
      for (const call of r.calls) {
        if (call.name === "request_human_input" && !c.disableTaskHandoffs) {
          await c.onCheckpoint(
            "Awaiting human decision",
            messages.slice(0, -1),
          );
          throw Object.assign(
            new HumanWait(questionSchema.parse(call.arguments)),
            { costUsd },
          );
        }
        await c.onCheckpoint(
          `Starting tool ${call.name} (${call.id})`,
          messages,
          call,
          costUsd,
        );
        const result = completed.get(call.id) ?? (await this.tool(c, call));
        completed.set(call.id, result);
        messages.push({ role: "tool", content: result, callId: call.id });
        await c.onCheckpoint(
          `Completed tool ${call.name} (${call.id})`,
          messages,
          undefined,
          costUsd,
        );
      }
      if (JSON.stringify(messages).length > 180000) {
        const old = messages.splice(1, Math.max(0, messages.length - 13));
        const summary = old
          .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
          .join("\n")
          .slice(-12000);
        messages.splice(1, 0, {
          role: "user",
          content: `Earlier execution summary (artifacts remain authoritative):\n${summary}`,
        });
      }
    }
    throw Object.assign(new Error("Agent tool-loop limit reached"), {
      costUsd,
    });
  }
  async tool(c: RunContext, call: ToolCall): Promise<string> {
    try {
      const a = call.arguments;
      switch (call.name) {
        case "read_file":
          return (
            await readFile(await scopedPath(c, String(a.path), false), "utf8")
          ).slice(0, 100000);
        case "list_files":
          return JSON.stringify(
            await readdir(await scopedPath(c, String(a.path), false)),
          );
        case "write_file": {
          if (c.mode !== "implement") throw new Error("Read-only run");
          const path = await scopedPath(c, String(a.path), true);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, z.string().max(1000000).parse(a.content));
          return "Written";
        }
        case "shell":
          return containerShell(
            c.workspace,
            z.string().max(10000).parse(a.command),
            c.mode !== "implement",
            c.signal,
            c.claim.goal.config.containerNetwork,
            c.claim.task.spec.cpuUnits,
            c.claim.task.spec.memoryMiB,
            c.claim.goal.config.containerImage,
          );
        case "checkpoint":
          await c.onCheckpoint(z.string().parse(a.summary));
          return "Checkpoint saved";
        default:
          throw new Error("Unknown tool");
      }
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  }
}
async function scopedPath(c: RunContext, name: string, write: boolean) {
  const base = await realpath(c.workspace);
  const path = resolve(base, name);
  const rel = relative(base, path);
  if (
    rel.startsWith("..") ||
    rel.split("/").some((x) => x === ".git") ||
    (!rel && write)
  )
    throw new Error("Path outside workspace");
  if (write && !c.claim.task.spec.allowedPaths.some((p) => matchesGlob(rel, p)))
    throw new Error("Path outside task scope");
  let existing = path;
  while (true) {
    try {
      const actual = await realpath(existing);
      if (actual !== base && !actual.startsWith(base + "/"))
        throw new Error("Symlink outside workspace");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = dirname(existing);
      if (parent === existing) throw e;
      existing = parent;
    }
  }
  return path;
}
export async function containerShell(
  workspace: string,
  command: string,
  readOnly: boolean,
  signal: AbortSignal,
  network: "none" | "bridge" = "none",
  cpuUnits = 2,
  memoryMiB = 2048,
  configuredImage?: string,
): Promise<string> {
  const image = configuredImage ?? process.env.MISSIONCONTROL_CONTAINER_IMAGE;
  if (!image)
    throw new Error(
      "MISSIONCONTROL_CONTAINER_IMAGE must name a prebuilt development image",
    );
  if (!/^[\w./:@-]+$/.test(image)) throw new Error("Invalid container image");
  const name = `mc-tool-${randomUUID()}`;
  try {
    return await commandOutput(
      "docker",
      [
        "run",
        "--rm",
        "--init",
        "--name",
        name,
        "--network",
        network,
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=256",
        `--memory=${memoryMiB}m`,
        `--cpus=${cpuUnits}`,
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--mount",
        `type=bind,src=${workspace},dst=/workspace${readOnly ? ",readonly" : ""}`,
        "--workdir",
        "/workspace",
        "--env",
        "HOME=/tmp",
        image,
        "/bin/sh",
        "-lc",
        command,
      ],
      signal,
    );
  } finally {
    await promisify(execFile)("docker", ["rm", "-f", name], {
      timeout: 10000,
    }).catch(() => {});
  }
}
function commandOutput(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  return new Promise((done, fail) => {
    const p = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      signal,
      detached: process.platform !== "win32",
    });
    const stop = () => terminateProcessTree(p.pid, "SIGKILL");
    signal.addEventListener("abort", stop, { once: true });
    let text = "",
      size = 0;
    p.stdout.on("data", (b) => {
      size += b.length;
      text += b;
      if (size > 1000000) p.kill();
    });
    p.stderr.on("data", (b) => {
      size += b.length;
      text += b;
      if (size > 1000000) p.kill();
    });
    p.on("error", fail);
    p.on("close", (code) => {
      signal.removeEventListener("abort", stop);
      done(JSON.stringify({ exitCode: code, output: text.slice(-100000) }));
    });
  });
}
export class CodexBackend implements AgentBackend {
  constructor(readonly config: Extract<BackendConfig, { kind: "codex" }>) {}
  async run(c: RunContext): Promise<BackendResult> {
    c.signal.throwIfAborted();
    if (!c.execution)
      throw new Error(
        "Codex requires controller-supplied isolated execution; host fallback is disabled",
      );
    const p = c.execution.spawn(this.config.command, [
      "app-server",
      "--listen",
      "stdio://",
    ]);
    const abortProcess = () => terminateProcessTree(p.pid, "SIGKILL");
    c.signal.addEventListener("abort", abortProcess, { once: true });
    const lines = createInterface({ input: p.stdout });
    let next = 0,
      text = "",
      sessionId = "",
      inputTokens = 0,
      outputTokens = 0;
    let settle: (v: BackendResult) => void = () => {},
      reject: (e: Error) => void = () => {};
    const completed = new Promise<BackendResult>((yes, no) => {
      settle = yes;
      reject = no;
    });
    completed.catch(() => {});
    const pending = new Map<
      number,
      { resolve: (v: any) => void; reject: (e: Error) => void }
    >();
    const send = (value: unknown) =>
      p.stdin.write(JSON.stringify(value) + "\n");
    const request = (method: string, params: unknown) =>
      new Promise<any>((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      });
    const fail = (e: Error) => {
      for (const v of pending.values()) v.reject(e);
      pending.clear();
      reject(e);
    };
    p.on("error", fail);
    p.on("exit", () => fail(new Error("Codex App Server exited")));
    let stderrBytes = 0;
    p.stderr.on("data", (b) => {
      stderrBytes += b.length;
      if (stderrBytes > 1000000) p.kill();
    });
    let received = 0;
    lines.on("line", (line) => {
      try {
        received += line.length;
        if (received > 20000000) throw new Error("Codex output limit reached");
        const m = JSON.parse(line);
        if (m.id !== undefined && m.method === undefined) {
          const v = pending.get(m.id);
          if (v) {
            pending.delete(m.id);
            if (m.error) v.reject(new Error("Codex RPC failed"));
            else v.resolve(m.result);
          }
          return;
        }
        if (m.id !== undefined && m.method) {
          if (m.method === "item/tool/call") {
            if (
              m.params?.threadId !== sessionId ||
              c.mode !== "implement" ||
              c.disableTaskHandoffs
            ) {
              send({
                id: m.id,
                result: {
                  success: false,
                  contentItems: [
                    {
                      type: "inputText",
                      text: "Worker handoff authority denied",
                    },
                  ],
                },
              });
              return;
            }
            try {
              const wait = parseHandoff(m.params.tool, m.params.arguments);
              // Do not acknowledge a persisted action before stopped source import.
              // The controller catches this wait and owns checkpoint/persistence.
              fail(wait);
            } catch {
              send({
                id: m.id,
                result: {
                  success: false,
                  contentItems: [
                    {
                      type: "inputText",
                      text: "Invalid worker handoff request",
                    },
                  ],
                },
              });
            }
            return;
          }
          if (m.method.includes("requestUserInput")) {
            const q = m.params?.questions?.[0];
            const options = q?.options?.map((o: any, i: number) => ({
              id: String(i),
              label: o.label,
            })) ?? [
              { id: "continue", label: "Continue" },
              { id: "stop", label: "Stop" },
            ];
            reject(
              new HumanWait({
                question: q?.question ?? "Codex needs input",
                reason: "Worker requires a decision",
                options,
              }),
            );
            send({
              id: m.id,
              error: { code: -32000, message: "Checkpointed for human input" },
            });
            return;
          }
          send({ id: m.id, result: { decision: "decline" } });
          return;
        }
        if (
          m.method === "item/completed" &&
          m.params?.item?.type === "agentMessage"
        ) {
          // Progress commentary is not part of the structured plan/review.
          // Older servers omit phase; their last agent message is the result.
          if (m.params.item.phase !== "commentary")
            text = m.params.item.text + "\n";
        }
        if (m.method === "thread/tokenUsage/updated") {
          const u = m.params?.tokenUsage?.total;
          inputTokens = u?.inputTokens ?? inputTokens;
          outputTokens = u?.outputTokens ?? outputTokens;
        }
        if (m.method === "error") {
          const message = m.params?.error?.message ?? "Codex inference failed";
          fail(new Error(message));
        }
        if (m.method === "turn/completed") {
          if (m.params?.turn?.status === "failed")
            fail(
              new Error(m.params.turn.error?.message ?? "Codex turn failed"),
            );
          else
            settle({
              text,
              usage: {
                kind: "metered",
                status: "unknown",
                inputTokens,
                outputTokens,
              },
              inputTokens,
              outputTokens,
              sessionId,
            });
        }
      } catch (e) {
        fail(e as Error);
      }
    });
    try {
      await request("initialize", {
        clientInfo: { name: "mission-control", version: "1.0.0" },
        ...(c.mode === "implement"
          ? { capabilities: { experimentalApi: true } }
          : {}),
      });
      send({ method: "initialized", params: {} });
      const thread = await request("thread/start", {
        cwd: c.execution.workspace,
        model: this.config.model ?? null,
        approvalPolicy: "never",
        sandbox: c.execution
          ? "danger-full-access"
          : c.mode === "implement"
            ? "workspace-write"
            : "read-only",
        ephemeral: true,
        ...(c.mode === "implement" && !c.disableTaskHandoffs
          ? { dynamicTools: handoffTools }
          : {}),
      });
      sessionId = thread.thread.id;
      await request("turn/start", {
        threadId: sessionId,
        input: [{ type: "text", text: c.prompt }],
        ...(c.outputSchema ? { outputSchema: c.outputSchema } : {}),
        sandboxPolicy: c.execution
          ? { type: "dangerFullAccess" }
          : c.mode === "implement"
            ? {
                type: "workspaceWrite",
                writableRoots: [c.workspace],
                networkAccess: false,
              }
            : { type: "readOnly" },
      });
      return await completed;
    } finally {
      c.signal.removeEventListener("abort", abortProcess);
      lines.close();
      p.stdin.end();
      terminateProcessTree(p.pid, "SIGTERM");
    }
  }
}
export function parseReview(text: string, commit: string): Review {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  const schema = z.object({
    commit: z.literal(commit),
    verdict: z.enum(["pass", "fail"]),
    findings: z.array(
      z.object({
        summary: z.string(),
        blocking: z.boolean(),
        evidence: z.string(),
      }),
    ),
  });
  return schema.parse(JSON.parse(trimmed));
}
