import { randomUUID } from "node:crypto";
import {
  ProviderFailure,
  ReliabilityStore,
  classifyFailure,
  failureRecord,
  boundedErrorBody,
  requestIds,
  sanitizedEndpoint,
  safeDiagnosticText,
  abortable,
  retryProvider,
  type InferenceDiagnostic,
} from "./reliability.js";
export interface InferenceContext {
  attemptId?: string;
  goalId?: string;
  taskId?: string;
  generation?: number;
  sessionId?: string;
  progress?: (kind: string) => void;
}
import { inferenceHttpFetch } from "./inferenceHttp.js";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { BackendConfig } from "./schema.js";
import { z } from "zod";
const tokens = z.number().int().nonnegative().max(100000000);
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  calls?: ToolCall[];
  callId?: string;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ModelResult {
  text: string;
  calls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
}
export interface ModelProvider {
  generate(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    context?: InferenceContext,
  ): Promise<ModelResult>;
  cost(result: ModelResult): number;
}
export class ProviderUnavailable extends ProviderFailure {
  constructor(message: string) {
    super(classifyFailure(new Error(message)));
  }
}
export class AzureProvider implements ModelProvider {
  constructor(
    readonly config: Extract<BackendConfig, { kind: "azure" }>,
    readonly fetcher: typeof fetch = inferenceHttpFetch,
    readonly authentication: () => Promise<
      Record<string, string>
    > = async () => {
      throw new Error(
        "Azure requires explicit controller-owned authentication; ambient credential discovery is disabled",
      );
    },
    readonly diagnostics?: ReliabilityStore,
    readonly providerId = "azure",
  ) {}
  cost(r: ModelResult) {
    return (
      (r.inputTokens * this.config.inputUsdPerMillion +
        r.outputTokens * this.config.outputUsdPerMillion) /
      1e6
    );
  }
  async generate(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    context: InferenceContext = {},
  ) {
    const runtime = context.attemptId
      ? this.diagnostics?.runtime(context.attemptId)
      : undefined;
    if (
      runtime?.failure &&
      [
        "policy_refusal",
        "authentication",
        "quota",
        "invalid_request",
        "deployment_missing",
      ].includes(runtime.failure.kind)
    )
      throw new ProviderFailure(runtime.failure);
    return retryProvider(
      () => this.generateOnce(messages, tools, signal, context),
      signal,
      runtime,
      (r) => {
        const current = this.diagnostics?.runtime(r.attemptId);
        if (current)
          this.diagnostics?.saveRuntime({
            ...current,
            retryCount: r.retryCount,
            nextRetryAt: r.nextRetryAt,
            failure: r.failure,
          });
      },
    );
  }
  private async generateOnce(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    context: InferenceContext = {},
  ): Promise<ModelResult> {
    const diagnostic: InferenceDiagnostic = {
      version: 1,
      id: `inference_${String(Date.now()).padStart(13, "0")}_${randomUUID()}`,
      ...context,
      provider: this.providerId,
      endpoint: sanitizedEndpoint(this.config.endpoint),
      model: this.config.model,
      startedAt: Date.now(),
      phase: "authentication",
      status: "active",
    };
    delete (diagnostic as any).progress;
    this.diagnostics?.diagnostic(diagnostic);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(await abortable(this.authentication(), signal)),
      };
      const input = messages.flatMap<any>((m) =>
        m.role === "tool"
          ? [
              {
                type: "function_call_output",
                call_id: m.callId,
                output: m.content,
              },
            ]
          : m.calls?.length
            ? [
                ...(m.content
                  ? [{ role: "assistant", content: m.content }]
                  : []),
                ...m.calls.map((c) => ({
                  type: "function_call",
                  call_id: c.id,
                  name: c.name,
                  arguments: JSON.stringify(c.arguments),
                })),
              ]
            : [{ role: m.role, content: m.content }],
      );
      const base = this.config.endpoint.replace(/\/$/, "");
      const url = base.endsWith("/openai/v1")
        ? `${base}/responses`
        : `${base}/openai/v1/responses`;
      diagnostic.phase = "headers";
      const response = await abortable(
        this.fetcher(url, {
          method: "POST",
          headers,
          signal,
          redirect: "error",
          body: JSON.stringify({
            model: this.config.model,
            input,
            tools: tools.map((t) => ({
              type: "function",
              ...t,
              strict: false,
            })),
            stream: true,
            max_output_tokens: this.config.maxOutputTokens,
            reasoning: { effort: this.config.reasoningEffort },
            store: false,
          }),
        }),
        signal,
      );
      diagnostic.httpStatus = response.status;
      diagnostic.requestIds = requestIds(response.headers);
      diagnostic.phase = "body";
      if (!response.ok) {
        const raw = await boundedErrorBody(response, signal);
        const failure = {
          ...classifyFailure(raw, response.status, diagnostic.id),
          requestIds: diagnostic.requestIds,
        };
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const n = Number(retryAfter);
          failure.retryAfterMs = Math.min(
            300000,
            Math.max(
              0,
              Number.isFinite(n)
                ? n * 1000
                : Date.parse(retryAfter) - Date.now(),
            ),
          );
        }
        throw new ProviderFailure(failure);
      }
      let final: any;
      for await (const event of sse(response, signal)) {
        if (
          event.type === "response.refusal.delta" ||
          event.type === "response.refusal.done"
        )
          throw new ProviderFailure(
            failureRecord("policy_refusal", { diagnosticId: diagnostic.id }),
          );
        if (
          event.type === "response.output_text.delta" ||
          event.type === "response.function_call_arguments.delta"
        )
          context.progress?.("model_output");
        if (event.type === "response.completed") {
          if (final)
            throw Error(
              "Duplicate Azure completion; usage requires reconciliation",
            );
          final = event.response;
        }
        if (event.type === "error" || event.type === "response.failed")
          throw new ProviderFailure(
            classifyFailure(event, undefined, diagnostic.id),
          );
      }
      if (!final)
        throw new Error("Azure stream ended without a complete response");
      if (
        (final.output ?? []).some((item: any) =>
          (item.content ?? []).some((part: any) => part.type === "refusal"),
        )
      )
        throw new ProviderFailure(
          failureRecord("policy_refusal", { diagnosticId: diagnostic.id }),
        );
      const usage = z
        .object({ input_tokens: tokens, output_tokens: tokens })
        .parse(final.usage);
      diagnostic.status = "completed";
      diagnostic.usageStatus = "reported";
      context.progress?.("model_completed");
      return {
        text: (final.output ?? [])
          .flatMap((i: any) => i.content ?? [])
          .filter((i: any) => i.type === "output_text")
          .map((i: any) => i.text)
          .join("\n"),
        calls: (final.output ?? [])
          .filter((i: any) => i.type === "function_call")
          .map((i: any) => ({
            id: i.call_id,
            name: i.name,
            arguments: JSON.parse(i.arguments),
          })),
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      };
    } catch (error) {
      const failure =
        error instanceof ProviderFailure
          ? error.failure
          : classifyFailure(
              signal.aborted ? signal.reason : error,
              diagnostic.httpStatus,
              diagnostic.id,
            );
      if (
        error instanceof Error &&
        /^(Inference event exceeded bound|Inference stream ended with an incomplete event|Duplicate Azure completion; usage requires reconciliation|Inference response exceeded bound)$/.test(
          error.message,
        )
      )
        failure.message = error.message;
      diagnostic.status = "failed";
      diagnostic.failure = failure;
      diagnostic.usageStatus = "unknown";
      throw new ProviderFailure(failure);
    } finally {
      diagnostic.endedAt = Date.now();
      diagnostic.durationMs = diagnostic.endedAt - diagnostic.startedAt;
      this.diagnostics?.diagnostic(diagnostic);
    }
  }
}
export class BedrockProvider implements ModelProvider {
  private client: BedrockRuntimeClient;
  constructor(
    readonly config: Extract<BackendConfig, { kind: "bedrock" }>,
    client?: BedrockRuntimeClient,
    readonly diagnostics?: ReliabilityStore,
  ) {
    if (!client)
      throw new Error(
        "Bedrock requires explicit controller-owned credentials; ambient credential discovery is disabled",
      );
    this.client = client;
  }
  cost(r: ModelResult) {
    return (
      (r.inputTokens * this.config.inputUsdPerMillion +
        r.outputTokens * this.config.outputUsdPerMillion) /
      1e6
    );
  }
  async generate(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    context: InferenceContext = {},
  ): Promise<ModelResult> {
    const diagnostic: InferenceDiagnostic = {
      version: 1,
      id: `inference_${String(Date.now()).padStart(13, "0")}_${randomUUID()}`,
      ...context,
      provider: "bedrock",
      endpoint: `https://bedrock-runtime.${this.config.region}.amazonaws.com`,
      model: this.config.model,
      startedAt: Date.now(),
      phase: "headers",
      status: "active",
    };
    delete (diagnostic as any).progress;
    this.diagnostics?.diagnostic(diagnostic);
    const converted: Message[] = [];
    try {
      for (const m of messages) {
        const role = m.role === "tool" ? "user" : m.role;
        const content: any[] =
          m.role === "tool"
            ? [
                {
                  toolResult: {
                    toolUseId: m.callId,
                    content: [{ text: m.content }],
                  },
                },
              ]
            : [
                ...(m.content ? [{ text: m.content }] : []),
                ...(m.calls ?? []).map((c) => ({
                  toolUse: {
                    toolUseId: c.id,
                    name: c.name,
                    input: c.arguments,
                  },
                })),
              ];
        if (!content.length) continue;
        const last = converted.at(-1);
        if (last?.role === role) last.content!.push(...content);
        else converted.push({ role, content });
      }
      const response = await abortable(
        this.client.send(
          new ConverseStreamCommand({
            modelId: this.config.model,
            messages: converted,
            toolConfig: {
              tools: tools.map((t) => ({
                toolSpec: {
                  name: t.name,
                  description: t.description,
                  inputSchema: { json: t.parameters as any },
                },
              })) as Tool[],
            },
            inferenceConfig: { maxTokens: 8192 },
          }),
          { abortSignal: signal },
        ),
        signal,
      );
      diagnostic.phase = "body";
      diagnostic.httpStatus = response.$metadata?.httpStatusCode;
      if (response.$metadata?.requestId)
        diagnostic.requestIds = {
          "x-amzn-requestid": safeDiagnosticText(response.$metadata.requestId),
        };
      let text = "";
      let inputTokens = 0,
        outputTokens = 0;
      const calls = new Map<
        number,
        { id: string; name: string; json: string }
      >();
      let complete = false,
        usageReceived = false,
        bytes = 0;
      const iterator = response.stream?.[Symbol.asyncIterator]();
      while (iterator) {
        const next = await abortable(iterator.next(), signal);
        if (next.done) break;
        const e = next.value;
        bytes += Buffer.byteLength(JSON.stringify(e));
        if (bytes > 32 * 1024 * 1024)
          throw new Error("Bedrock response exceeded bound");
        if (e.messageStop) {
          if (
            ["guardrail_intervened", "content_filtered"].includes(
              e.messageStop.stopReason ?? "",
            )
          )
            throw new ProviderFailure(
              failureRecord("policy_refusal", { diagnosticId: diagnostic.id }),
            );
          complete = true;
        }
        if (e.contentBlockStart?.start?.toolUse) {
          const t = e.contentBlockStart.start.toolUse;
          calls.set(e.contentBlockStart.contentBlockIndex!, {
            id: t.toolUseId!,
            name: t.name!,
            json: "",
          });
        }
        const d = e.contentBlockDelta;
        if (d?.delta?.text) {
          text += d.delta.text;
          context.progress?.("model_output");
        }
        if (d?.delta?.toolUse?.input) {
          const c = calls.get(d.contentBlockIndex!);
          if (c) c.json += d.delta.toolUse.input;
        }
        if (e.metadata?.usage) {
          inputTokens = tokens.parse(e.metadata.usage.inputTokens);
          outputTokens = tokens.parse(e.metadata.usage.outputTokens);
          usageReceived = true;
        }
        if (e.throttlingException || e.serviceUnavailableException)
          throw new ProviderFailure(
            failureRecord(e.throttlingException ? "rate_limit" : "service", {
              diagnosticId: diagnostic.id,
            }),
          );
        if (
          e.modelStreamErrorException ||
          e.internalServerException ||
          e.validationException
        )
          throw new ProviderFailure(
            failureRecord(
              e.validationException
                ? "invalid_request"
                : e.internalServerException
                  ? "service"
                  : "incomplete_stream",
              { diagnosticId: diagnostic.id },
            ),
          );
      }
      if (!complete || !usageReceived)
        throw new Error(
          "Bedrock stream ended without complete result and usage",
        );
      diagnostic.status = "completed";
      diagnostic.usageStatus = "reported";
      return {
        text,
        calls: [...calls.values()].map((c) => ({
          id: c.id,
          name: c.name,
          arguments: JSON.parse(c.json || "{}"),
        })),
        inputTokens,
        outputTokens,
      };
    } catch (e) {
      const error = e as any;
      const failure = classifyFailure(
        e instanceof ProviderFailure
          ? e
          : { error: { code: error.name, message: error.message } },
        error.$metadata?.httpStatusCode,
        diagnostic.id,
      );
      diagnostic.status = "failed";
      diagnostic.failure = failure;
      diagnostic.usageStatus = "unknown";
      throw new ProviderFailure(failure);
    } finally {
      diagnostic.endedAt = Date.now();
      diagnostic.durationMs = diagnostic.endedAt - diagnostic.startedAt;
      this.diagnostics?.diagnostic(diagnostic);
    }
  }
}
export function createProvider(c: BackendConfig): ModelProvider {
  if (c.kind === "azure") return new AzureProvider(c);
  if (c.kind === "bedrock") return new BedrockProvider(c);
  throw new Error(`No inference provider for ${c.kind}`);
}
async function* sse(response: Response, signal: AbortSignal) {
  if (!response.body) throw new Error("Empty inference response");
  let buffer = "";
  const decoder = new TextDecoder();
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      const bytes = next.value;
      total += bytes.byteLength;
      if (total > 32 * 1024 * 1024)
        throw Error("Inference response exceeded bound");
      buffer += decoder.decode(bytes, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        if (Buffer.byteLength(block) > 1024 * 1024)
          throw Error("Inference event exceeded bound");
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") yield JSON.parse(data);
      }
      if (Buffer.byteLength(buffer) > 1024 * 1024)
        throw Error("Inference event exceeded bound");
    }
    if (buffer.trim())
      throw Error("Inference stream ended with an incomplete event");
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
