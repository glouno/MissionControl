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
  ): Promise<ModelResult>;
  cost(result: ModelResult): number;
}
export class ProviderUnavailable extends Error {}
export class AzureProvider implements ModelProvider {
  constructor(
    readonly config: Extract<BackendConfig, { kind: "azure" }>,
    readonly fetcher: typeof fetch = fetch,
    readonly authentication: () => Promise<
      Record<string, string>
    > = async () => {
      throw new Error(
        "Azure requires explicit controller-owned authentication; ambient credential discovery is disabled",
      );
    },
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
  ): Promise<ModelResult> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(await this.authentication()),
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
              ...(m.content ? [{ role: "assistant", content: m.content }] : []),
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
    const response = await this.fetcher(url, {
      method: "POST",
      headers,
      signal,
      redirect: "error",
      body: JSON.stringify({
        model: this.config.model,
        input,
        tools: tools.map((t) => ({ type: "function", ...t, strict: false })),
        stream: true,
        max_output_tokens: this.config.maxOutputTokens,
        reasoning: { effort: this.config.reasoningEffort },
        store: false,
      }),
    });
    if ([429, 503].includes(response.status))
      throw new ProviderUnavailable(`Azure unavailable (${response.status})`);
    if (!response.ok)
      throw new Error(`Azure request failed (${response.status})`);
    let final: any;
    for await (const event of sse(response)) {
      if (event.type === "response.completed") {
        if (final)
          throw Error(
            "Duplicate Azure completion; usage requires reconciliation",
          );
        final = event.response;
      }
      if (event.type === "error" || event.type === "response.failed")
        throw new Error("Azure inference failed");
    }
    if (!final)
      throw new Error("Azure stream ended without a complete response");
    const usage = z
      .object({ input_tokens: tokens, output_tokens: tokens })
      .parse(final.usage);
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
  }
}
export class BedrockProvider implements ModelProvider {
  private client: BedrockRuntimeClient;
  constructor(
    readonly config: Extract<BackendConfig, { kind: "bedrock" }>,
    client?: BedrockRuntimeClient,
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
  ): Promise<ModelResult> {
    const converted: Message[] = [];
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
                toolUse: { toolUseId: c.id, name: c.name, input: c.arguments },
              })),
            ];
      if (!content.length) continue;
      const last = converted.at(-1);
      if (last?.role === role) last.content!.push(...content);
      else converted.push({ role, content });
    }
    try {
      const response = await this.client.send(
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
      );
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
      for await (const e of response.stream ?? []) {
        bytes += Buffer.byteLength(JSON.stringify(e));
        if (bytes > 32 * 1024 * 1024)
          throw new Error("Bedrock response exceeded bound");
        if (e.messageStop) complete = true;
        if (e.contentBlockStart?.start?.toolUse) {
          const t = e.contentBlockStart.start.toolUse;
          calls.set(e.contentBlockStart.contentBlockIndex!, {
            id: t.toolUseId!,
            name: t.name!,
            json: "",
          });
        }
        const d = e.contentBlockDelta;
        if (d?.delta?.text) text += d.delta.text;
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
          throw new ProviderUnavailable("Bedrock unavailable");
        if (
          e.modelStreamErrorException ||
          e.internalServerException ||
          e.validationException
        )
          throw new Error("Bedrock stream failed");
      }
      if (!complete || !usageReceived)
        throw new Error(
          "Bedrock stream ended without complete result and usage",
        );
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
      if ((e as Error).name === "ThrottlingException")
        throw new ProviderUnavailable("Bedrock rate limit");
      throw e;
    }
  }
}
export function createProvider(c: BackendConfig): ModelProvider {
  if (c.kind === "azure") return new AzureProvider(c);
  if (c.kind === "bedrock") return new BedrockProvider(c);
  throw new Error(`No inference provider for ${c.kind}`);
}
async function* sse(response: Response) {
  if (!response.body) throw new Error("Empty inference response");
  let buffer = "";
  const decoder = new TextDecoder();
  let total = 0;
  for await (const bytes of response.body as any) {
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
}
