import { createInterface } from "node:readline";
import { z } from "zod";
import { terminateProcessTree } from "../util.js";
import { type BackendConfig } from "./schema.js";
import {
  HumanWait,
  type AgentBackend,
  type BackendResult,
  type RunContext,
} from "./backend.js";
import { workerResponseSchema, responseHandoff } from "./workerHandoff.js";

// Claude supplies its own tool loop. MissionControl retains verification,
// integration, spending reservations and durable continuation ownership.
export class ClaudeCodeBackend implements AgentBackend {
  constructor(
    readonly config: Extract<BackendConfig, { kind: "claude-code" }>,
  ) {}
  async run(c: RunContext): Promise<BackendResult> {
    c.signal.throwIfAborted();
    const ceiling = c.claim.goal.config.estimatePerRunUsd;
    if (ceiling <= 0)
      throw new Error("Claude Code requires a positive run estimate");
    if (!c.execution)
      throw new Error(
        "Claude Code requires controller-supplied isolated execution; host fallback is disabled",
      );
    const tools = "default";
    const args = [
      "--print",
      "--safe-mode",
      "--disable-slash-commands",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      "--tools",
      tools,
      "--setting-sources",
      "",
      "--settings",
      JSON.stringify({ disableAllHooks: true }),
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
      "--no-session-persistence",
      "--max-turns",
      String(this.config.maxTurns),
      "--max-budget-usd",
      String(ceiling),
      "--json-schema",
      JSON.stringify(
        c.outputSchema ??
          z.toJSONSchema(workerResponseSchema, {
            io: "input",
            target: "draft-7",
          }),
      ),
    ];
    if (this.config.model) args.push("--model", this.config.model);
    await c.onCheckpoint(
      `${c.claim.task.checkpoint?.summary ?? ""}\nStarting Claude Code from the task contract and workspace checkpoint`,
    );
    const p = c.execution.spawn(this.config.command, args);
    const lines = createInterface({ input: p.stdout });
    let bytes = 0,
      stderrBytes = 0;
    let result: any;
    let protocolError: Error | undefined;
    const stop = () => terminateProcessTree(p.pid, "SIGKILL");
    c.signal.addEventListener("abort", stop, { once: true });
    const closed = new Promise<void>((resolve, reject) => {
      p.once("error", reject);
      p.once("close", (code) => {
        if (c.signal.aborted) reject(c.signal.reason);
        else if (protocolError) reject(protocolError);
        else if (code !== 0)
          reject(
            Object.assign(
              new Error(
                `Claude Code exited unsuccessfully${result?.api_error_status ? ` (provider HTTP ${result.api_error_status})` : ""}${result?.terminal_reason ? `: ${result.terminal_reason}` : ""}`,
              ),
              {
                costUsd: result?.total_cost_usd,
                usage:
                  result?.total_cost_usd === undefined
                    ? { kind: "metered", status: "unknown" }
                    : undefined,
              },
            ),
          );
        else resolve();
      });
    });
    lines.on("line", (line) => {
      try {
        bytes += Buffer.byteLength(line);
        if (bytes > 20000000)
          throw new Error("Claude Code output limit reached");
        const event = JSON.parse(line);
        if (event.type === "result") {
          if (result) {
            throw Object.assign(new Error("Duplicate Claude Code result"), {
              costUsd: undefined,
              usage: { kind: "metered", status: "unknown" },
              terminalEvents: [result, event].map((terminal) => ({
                subtype: terminal.subtype,
                isError: terminal.is_error,
                sessionId: terminal.session_id,
                uuid: terminal.uuid,
                costUsd: terminal.total_cost_usd,
                hasStructuredOutput: terminal.structured_output !== undefined,
              })),
            });
          }
          result = event;
        }
      } catch (e) {
        protocolError = e as Error;
        stop();
      }
    });
    p.stderr.on("data", (b) => {
      stderrBytes += b.length;
      if (stderrBytes > 1000000) {
        protocolError = new Error("Claude Code stderr limit reached");
        stop();
      }
    });
    p.stdin.on("error", () => {});
    p.stdin.end(
      c.outputSchema
        ? `${c.prompt}\nReturn the review object directly using the output schema.\n`
        : `${c.prompt}\nReturn text with the final task result (for review or planning, put the requested JSON in text). Set question to null unless a durable human decision is needed. ${c.mode === "implement" && !c.disableTaskHandoffs ? "For host/infrastructure access, stop work and return ownerOperation with action, scope, reason and a stable idempotencyKey. The controller checkpoints your progress and waits for an owner result; you cannot execute that action. Otherwise set ownerOperation to null." : "Set ownerOperation to null; review/planning cannot request task operations."} Do not claim tests ran: MissionControl runs checks separately.\n`,
    );
    if (c.signal.aborted) stop();
    try {
      await closed;
      if (!result) throw new Error("Claude Code ended without a result");
      const number = z.number().nonnegative().finite();
      const costUsd =
        result.total_cost_usd === undefined
          ? undefined
          : number.parse(result.total_cost_usd);
      if (result.permission_denials?.length)
        throw Object.assign(
          new HumanWait({
            question:
              "Claude Code needs a tool outside its configured scope. How should this task proceed?",
            reason:
              "Native tool permission was denied; inspect the task and execution environment before changing tool access.",
            options: [
              { id: "revise", label: "Continue within existing tools" },
              { id: "stop", label: "Stop and inspect" },
            ],
            category: "policy",
          }),
          { costUsd },
        );
      if (result.is_error || result.subtype !== "success")
        throw Object.assign(
          new Error(`Claude Code run failed: ${result.subtype ?? "unknown"}`),
          { costUsd },
        );
      const { response, wait } = c.outputSchema
        ? {
            response: { text: JSON.stringify(result.structured_output) },
            wait: undefined,
          }
        : responseHandoff(
            result.structured_output,
            c.mode === "implement" && !c.disableTaskHandoffs,
          );
      const usage = result.usage ?? {};
      if (c.disableTaskHandoffs && wait)
        throw Object.assign(
          new Error("Controller repair cannot issue task handoffs"),
          { costUsd },
        );
      const inputTokens =
        number.parse(usage.input_tokens ?? 0) +
        number.parse(usage.cache_creation_input_tokens ?? 0) +
        number.parse(usage.cache_read_input_tokens ?? 0);
      const outputTokens = number.parse(usage.output_tokens ?? 0);
      await c.onCheckpoint(response.text, undefined, undefined, costUsd);
      if (wait) throw Object.assign(wait, { costUsd });
      return {
        text: response.text,
        usage: {
          kind: "metered",
          status: result.total_cost_usd === undefined ? "unknown" : "reported",
          costUsd: result.total_cost_usd,
          inputTokens,
          outputTokens,
        },
        costUsd,
        inputTokens,
        outputTokens,
        sessionId: result.session_id,
      };
    } finally {
      c.signal.removeEventListener("abort", stop);
      lines.close();
      terminateProcessTree(p.pid, "SIGTERM");
    }
  }
}
