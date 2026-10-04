import { z } from "zod";
import { createInterface } from "node:readline";
import type { AgentBackend, BackendResult, RunContext } from "./backend.js";
import type { Usage } from "./usage.js";
import {
  executionContractSchema,
  validateBackendContract,
  validateExecutionLimits,
} from "./executionContract.js";
import { workerResponseSchema, responseHandoff } from "./workerHandoff.js";
import { terminateProcessTree } from "../util.js";
import {
  nativeOutputSchema,
  normalizeNativeOutput,
} from "./nativeOutputSchema.js";

const count = z.number().int().nonnegative().safe();
/** Native counters are reports, not provider-enforced limits or dollar charges. */
export function subscriptionUsage(
  harness: "codex" | "claude-code",
  raw: unknown,
): Extract<Usage, { kind: "subscription" }> {
  if (raw === undefined) return { kind: "subscription", status: "unknown" };
  const u = z.record(z.string(), z.unknown()).parse(raw);
  const inputKeys =
    harness === "codex"
      ? ["input_tokens"]
      : [
          "input_tokens",
          "cache_creation_input_tokens",
          "cache_read_input_tokens",
        ];
  // Do not label an incomplete Claude input aggregate as a measured total.
  const inputTokens = inputKeys.every((k) => u[k] !== undefined)
    ? count.parse(inputKeys.reduce((n, k) => n + count.parse(u[k]), 0))
    : undefined;
  for (const key of inputKeys) if (u[key] !== undefined) count.parse(u[key]);
  const outputTokens =
    u.output_tokens === undefined ? undefined : count.parse(u.output_tokens);
  return {
    kind: "subscription",
    status:
      inputTokens === undefined && outputTokens === undefined
        ? "unknown"
        : "reported",
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/** Only the dedicated authentication runtime may supply this backend's execution. */
export class SubscriptionNativeBackend implements AgentBackend {
  async run(c: RunContext): Promise<BackendResult> {
    c.signal.throwIfAborted();
    const configuration = c.claim.goal.config;
    const contract = executionContractSchema.parse(
      configuration.executionContract,
    );
    validateBackendContract(configuration.backend, contract);
    validateExecutionLimits(configuration);
    if (contract.usagePolicy.kind !== "subscription" || !c.execution)
      throw Error(
        "Subscription coding requires its admitted limits and dedicated isolated execution",
      );
    const harness = contract.harness;
    const originalOutputSchema =
      c.outputSchema ??
      z.toJSONSchema(workerResponseSchema, { io: "input", target: "draft-7" });
    const outputSchema = nativeOutputSchema(originalOutputSchema);
    if (harness !== "codex" && harness !== "claude-code")
      throw Error("Native subscription harness required");
    const policy = contract.usagePolicy;
    const args =
      harness === "codex"
        ? [
            "exec",
            "--json",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--dangerously-bypass-approvals-and-sandbox",
            "--color",
            "never",
            "-c",
            'cli_auth_credentials_store="file"',
            "-c",
            'forced_login_method="chatgpt"',
            "-c",
            'model_provider="openai"',
            "-c",
            "project_doc_max_bytes=0",
            "-c",
            "features.hooks=false",
            "-c",
            "features.multi_agent=false",
            "-c",
            'web_search="disabled"',
            "-c",
            "features.apps=false",
            "-c",
            "features.plugins=false",
            "-c",
            "features.memories=false",
            "-c",
            "features.skill_search=false",
            "-c",
            "features.shell_snapshot=false",
            "-c",
            "mcp_servers={}",
          ]
        : [
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
            "default",
            "--setting-sources",
            "",
            "--settings",
            JSON.stringify({
              disableAllHooks: true,
              forceLoginMethod: "claudeai",
            }),
            "--strict-mcp-config",
            "--mcp-config",
            JSON.stringify({ mcpServers: {} }),
            "--no-session-persistence",
            "--max-turns",
            String(
              configuration.backend.kind === "claude-code"
                ? configuration.backend.maxTurns
                : 1,
            ),
            "--json-schema",
            JSON.stringify(outputSchema),
          ];
    if (configuration.backend.model)
      args.push("--model", configuration.backend.model);
    if (harness === "codex") args.push("-");
    const startedAt = Date.now();
    const p = c.execution.spawn(
      harness === "codex" ? "codex" : "claude",
      args,
      outputSchema,
    );
    const lines = createInterface({ input: p.stdout });
    let terminal: any,
      sessionId: string | undefined,
      finalText: string | undefined,
      bytes = 0,
      failure: Error | undefined;
    const stop = () => terminateProcessTree(p.pid, "SIGKILL");
    const unknown = () => ({
      kind: "subscription" as const,
      status: "unknown" as const,
      elapsedMs: Date.now() - startedAt,
    });
    const fail = (message: string) => {
      failure ??= Object.assign(Error(message), { usage: unknown() });
      stop();
    };
    const abort = () => {
      fail("Subscription execution cancelled");
    };
    c.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => fail("Subscription execution time limit reached"),
      Math.min(configuration.timeoutMs, policy.timeoutMs),
    );
    const closed = new Promise<void>((resolve, reject) => {
      p.once("error", () =>
        reject(
          Object.assign(
            Error("Isolated subscription harness could not start"),
            { usage: unknown() },
          ),
        ),
      );
      p.once("close", (code) => {
        if (c.signal.aborted)
          reject(
            Object.assign(Error("Subscription execution cancelled"), {
              usage: unknown(),
            }),
          );
        else if (failure) reject(failure);
        else if (code !== 0)
          reject(
            Object.assign(
              Error("Isolated subscription harness exited unsuccessfully"),
              { usage: unknown() },
            ),
          );
        else resolve();
      });
    });
    const bound = (b: Buffer) => {
      bytes += b.length;
      if (bytes > 8 * 1024 * 1024) fail("Subscription output limit reached");
    };
    p.stdout.on("data", bound);
    p.stderr.on("data", bound); // Raw stderr/account diagnostics are never retained.
    lines.on("line", (line) => {
      if (failure) return;
      try {
        const event = JSON.parse(line);
        if (harness === "codex") {
          if (
            terminal &&
            ["item.completed", "turn.started"].includes(event.type)
          )
            throw Error("Subscription events continued after terminal result");
          if (event.type === "thread.started") {
            if (sessionId || typeof event.thread_id !== "string")
              throw Error("Ambiguous subscription session");
            sessionId = event.thread_id;
          }
          if (
            event.type === "item.completed" &&
            event.item?.type === "agent_message"
          )
            finalText = z.string().parse(event.item.text);
          if (event.type === "turn.failed" || event.type === "error")
            throw Error("Subscription inference failed");
          if (event.type === "turn.completed") {
            if (terminal) throw Error("Duplicate subscription terminal result");
            terminal = event;
          }
        } else if (event.type === "result") {
          if (terminal) throw Error("Duplicate subscription terminal result");
          terminal = event;
          sessionId =
            typeof event.session_id === "string" ? event.session_id : undefined;
        }
      } catch (e) {
        fail(
          e instanceof SyntaxError
            ? "Invalid subscription protocol"
            : (e as Error).message,
        );
      }
    });
    p.stdin.on("error", () => {});
    const instructions =
      `Return only a JSON object matching this schema: ${JSON.stringify(outputSchema)}.` +
      (c.outputSchema
        ? ""
        : " Set question/ownerOperation to null unless you must stop for an authorized handoff. Do not perform host or infrastructure operations; request ownerOperation instead. MissionControl runs independent checks and review.");
    p.stdin.end(c.prompt + "\n" + instructions + "\n");
    if (c.signal.aborted) abort();
    try {
      await closed;
      if (!terminal)
        throw Error("Subscription harness ended without a terminal result");
      if (
        harness === "claude-code" &&
        (terminal.subtype !== "success" ||
          terminal.is_error ||
          terminal.permission_denials?.length)
      )
        throw Error("Subscription native result was unsuccessful or denied");
      const usage = {
        ...subscriptionUsage(harness, terminal.usage),
        elapsedMs: Date.now() - startedAt,
      };
      if (policy.maxReportedTokens !== undefined) {
        if (
          usage.status !== "reported" ||
          usage.inputTokens === undefined ||
          usage.outputTokens === undefined
        )
          throw Object.assign(
            Error(
              "Subscription token limit cannot be checked against missing counters",
            ),
            { usage },
          );
        if (usage.inputTokens + usage.outputTokens > policy.maxReportedTokens)
          throw Object.assign(
            Error("Subscription reported token limit exceeded"),
            { usage },
          );
      }
      const raw = normalizeNativeOutput(
        harness === "codex"
          ? JSON.parse(z.string().parse(finalText))
          : terminal.structured_output,
        originalOutputSchema,
      );
      const handoff = c.outputSchema
        ? undefined
        : responseHandoff(
            raw,
            c.mode === "implement" && !c.disableTaskHandoffs,
          );
      if (c.disableTaskHandoffs && handoff?.wait)
        throw Error("Controller operation cannot issue task handoffs");
      const text = handoff ? handoff.response.text : JSON.stringify(raw);
      await c.onCheckpoint(text);
      if (handoff?.wait) throw Object.assign(handoff.wait, { usage });
      return {
        text,
        usage,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        sessionId,
      };
    } catch (error) {
      if (error instanceof Error && !(error as any).usage)
        Object.assign(error, { usage: unknown() });
      throw error;
    } finally {
      clearTimeout(timer);
      c.signal.removeEventListener("abort", abort);
      lines.close();
      stop();
    }
  }
}
