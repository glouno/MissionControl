import type { NativeProfile } from "./nativeConfig.js";
import type { RunContext, BackendResult } from "./backend.js";
import { subscriptionUsage } from "./subscriptionNative.js";
import {
  ProviderFailure,
  classifyFailure,
  failureRecord,
} from "./reliability.js";

/** Codex protocol only: no Docker resources, credentials, Git or task-state writes. */
export function codexArguments(
  profile: NativeProfile,
  model: string | undefined,
  schemaPath: string,
  finalPath: string,
  mode: RunContext["mode"],
  sessionId?: string,
  reasoningEffort?: string,
) {
  const args = [
    "exec",
    ...(sessionId ? ["resume", sessionId] : []),
    "--json",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    finalPath,
    "-c",
    'approval_policy="never"',
    "-c",
    `sandbox_mode=${JSON.stringify(mode === "review" ? "read-only" : profile.permissions === "devbox" ? "danger-full-access" : "workspace-write")}`,
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'model_provider="openai"',
    ...(reasoningEffort
      ? ["-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]
      : []),
    ...(profile.profile ? ["--profile", profile.profile] : []),
    ...(model ? ["--model", model] : []),
    "-",
  ];
  // Resume has no --profile option; profile layering is a global CLI option.
  if (profile.profile) {
    const index = args.indexOf("--profile");
    args.splice(index, 2);
    args.unshift("--profile", profile.profile);
  }
  return args;
}
export class CodexEvents {
  completed = false;
  failed = false;
  sessionId?: string;
  usage: BackendResult["usage"] = { kind: "subscription", status: "unknown" };
  turns = 0;
  toolEvents = 0;
  retryEvents = 0;
  private invalid = false;
  terminalFailure?: ProviderFailure;
  constructor(
    readonly context: Pick<RunContext, "observe" | "onProgress">,
    sessionId?: string,
  ) {
    this.sessionId = sessionId;
  }
  feed(line: string) {
    if (this.invalid) throw Error("Native protocol is already invalid");
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || typeof event.type !== "string")
        throw Error("Invalid native event");
      if (
        (this.completed || this.failed) &&
        [
          "turn.started",
          "turn.completed",
          "turn.failed",
          "item.started",
          "item.completed",
        ].includes(event.type)
      )
        throw Error("Events after native terminal result");
      if (
        [
          "turn.started",
          "turn.completed",
          "turn.failed",
          "item.started",
          "item.completed",
        ].includes(event.type)
      )
        this.context.onProgress?.(event.type);
      if (event.type === "thread.started") {
        if (
          typeof event.thread_id !== "string" ||
          !event.thread_id ||
          (this.sessionId && event.thread_id !== this.sessionId)
        )
          throw Error("Ambiguous native session identity");
        this.sessionId = event.thread_id;
        this.context.observe?.({ sessionId: this.sessionId });
      }
      if (event.type === "turn.completed") {
        this.completed = true;
        this.turns++;
        this.usage = subscriptionUsage("codex", event.usage);
        this.context.observe?.({
          turns: this.turns,
          usage: this.usage,
          ...(Number.isSafeInteger(event.usage?.cached_input_tokens) &&
          event.usage.cached_input_tokens >= 0
            ? { cachedInputTokens: event.usage.cached_input_tokens }
            : {}),
        });
      }
      if (event.type === "turn.failed") {
        this.failed = true;
        this.turns++;
        this.context.observe?.({ turns: this.turns });
        this.terminalFailure = new ProviderFailure(
          classifyFailure(event.error ?? event),
        );
      }
      if (
        event.type === "item.completed" &&
        ["command_execution", "mcp_tool_call", "web_search"].includes(
          event.item?.type,
        )
      ) {
        this.toolEvents++;
        this.context.observe?.({ toolEvents: this.toolEvents });
      }
      if (event.type === "error") {
        if (
          event.retrying === true ||
          /\bretrying\b|\breconnecting\b/i.test(event.message ?? "")
        ) {
          this.retryEvents++;
          this.context.observe?.({ retryEvents: this.retryEvents });
        } else
          this.terminalFailure = new ProviderFailure(classifyFailure(event));
      }
    } catch (error) {
      this.invalid = true;
      this.usage = {
        ...this.usage!,
        status: "unknown",
      } as BackendResult["usage"];
      this.context.observe?.({ usage: this.usage });
      throw error;
    }
  }
  assertSuccessful(code: number, parseError?: unknown) {
    if (this.terminalFailure) throw this.terminalFailure;
    if (
      this.invalid ||
      parseError ||
      code !== 0 ||
      this.failed ||
      !this.completed
    )
      throw new ProviderFailure(failureRecord("incomplete_stream"));
  }
}
