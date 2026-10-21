import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ModelMessage,
  ModelProvider,
  ModelResult,
  ToolDefinition,
} from "./providers.js";
import { sse } from "./providers.js";
import type { InferenceContext } from "./providers.js";
import {
  vertexBackendSchema,
  vertexEndpoint,
  type VertexConfig,
} from "./vertexConfig.js";
import { boundedJson } from "./vertexAuth.js";
import { inferenceHttpFetch } from "./inferenceHttp.js";
import {
  abortable,
  invocationFence,
  classifyFailure,
  failureRecord,
  ProviderFailure,
  ReliabilityStore,
  requestIds,
  type InferenceDiagnostic,
} from "./reliability.js";
const count = z.number().int().nonnegative().max(100000000);
const usageSchema = z
  .object({
    promptTokenCount: count,
    candidatesTokenCount: count,
    thoughtsTokenCount: count.optional().default(0),
    cachedContentTokenCount: count.optional().default(0),
    totalTokenCount: count,
  })
  .passthrough()
  .refine(
    (u) =>
      u.cachedContentTokenCount <= u.promptTokenCount &&
      u.totalTokenCount ===
        u.promptTokenCount + u.candidatesTokenCount + u.thoughtsTokenCount,
    "Inconsistent Vertex usage",
  );
const partSchema = z
  .object({
    text: z.string().max(1000000).optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().max(1000000).optional(),
    functionCall: z
      .object({
        name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
        args: z.record(z.string(), z.unknown()),
        id: z.string().max(128).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (p) =>
      (p.text !== undefined) !== (p.functionCall !== undefined) ||
      (p.text === undefined &&
        p.functionCall === undefined &&
        p.thoughtSignature !== undefined),
    "Unsupported Vertex part",
  );
const eventSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            index: z.literal(0).optional(),
            content: z
              .object({
                role: z.literal("model").optional(),
                parts: z.array(partSchema).max(256),
              })
              .strict()
              .optional(),
            finishReason: z.string().max(80).optional(),
          })
          .passthrough(),
      )
      .max(1)
      .optional(),
    usageMetadata: usageSchema.optional(),
    modelVersion: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]{1,128}$/)
      .optional(),
    responseId: z
      .string()
      .regex(/^[a-zA-Z0-9_.:/-]{1,256}$/)
      .optional(),
    promptFeedback: z
      .object({ blockReason: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export class VertexProvider implements ModelProvider {
  readonly config: VertexConfig;
  constructor(
    config: VertexConfig,
    readonly fetcher: typeof fetch = inferenceHttpFetch,
    readonly authentication: (
      signal: AbortSignal,
      context?: InferenceContext,
    ) => Promise<Record<string, string>> = async () => {
      throw new ProviderFailure(failureRecord("authentication"));
    },
    readonly diagnostics?: ReliabilityStore,
    readonly providerId = "vertex",
    readonly clock: () => number = Date.now,
  ) {
    this.config = vertexBackendSchema.parse(config);
  }
  private price(at: number) {
    const p = this.config.pricing.find(
      (p) =>
        Date.parse(p.effectiveFrom) <= at && at < Date.parse(p.effectiveUntil),
    );
    if (!p) throw new ProviderFailure(failureRecord("invalid_request"));
    return p;
  }
  cost(r: ModelResult) {
    const u = r.vertexUsage;
    const p = u
      ? this.config.pricing.find((p) => p.version === u.pricingVersion)
      : this.price(this.clock());
    if (!p) throw Error("Unknown Vertex pricing version");
    return u
      ? ((u.prompt - u.cached) * p.inputUsdPerMillion +
          u.cached * p.cachedInputUsdPerMillion +
          u.candidates * p.outputUsdPerMillion +
          u.thinking * p.thinkingUsdPerMillion) /
          1e6
      : (r.inputTokens * p.inputUsdPerMillion +
          r.outputTokens *
            Math.max(p.outputUsdPerMillion, p.thinkingUsdPerMillion)) /
          1e6;
  }
  reservation(messages: ModelMessage[], tools: ToolDefinition[]) {
    this.price(this.clock());
    // Full configured context and combined generation limits, rather than a character heuristic.
    const upper = Math.max(
      ...this.config.pricing.map(
        (p) =>
          (this.config.maxInputTokens *
            Math.max(p.inputUsdPerMillion, p.cachedInputUsdPerMillion) +
            this.config.maxOutputTokens *
              Math.max(p.outputUsdPerMillion, p.thinkingUsdPerMillion)) /
          1e6,
      ),
    );
    if (upper > this.config.maxRequestCostUsd)
      throw new ProviderFailure(failureRecord("quota"));
    this.body(messages, tools); // reject oversize/invalid input before authentication
    return upper;
  }
  private body(messages: ModelMessage[], tools: ToolDefinition[]) {
    const calls = new Map(
      messages.flatMap((m) => m.calls ?? []).map((c) => [c.id, c.name]),
    );
    const nativeIds = new Set(
      messages
        .flatMap((m) => m.nativeParts ?? [])
        .flatMap((p) => {
          const f = p.functionCall as any;
          return f?.id ? [f.id] : [];
        }),
    );
    const contents: { role: string; parts: unknown[] }[] = [];
    for (const m of messages) {
      const role = m.role === "assistant" ? "model" : "user";
      let parts: unknown[];
      if (m.role === "tool") {
        const name = m.callId && calls.get(m.callId);
        if (!name) throw Error("Unmatched Vertex tool response");
        parts = [
          {
            functionResponse: {
              name,
              ...(nativeIds.has(m.callId!) ? { id: m.callId } : {}),
              response: { result: m.content },
            },
          },
        ];
      } else if (m.nativeParts)
        parts = m.nativeParts.map((p) => partSchema.parse(p));
      else
        parts = [
          ...(m.content ? [{ text: m.content }] : []),
          ...(m.calls ?? []).map((c) => ({
            functionCall: { name: c.name, args: c.arguments },
          })),
        ];
      if (!parts.length) throw Error("Empty Vertex message");
      const last = contents.at(-1);
      if (last?.role === role) last.parts.push(...parts);
      else contents.push({ role, parts });
    }
    const body = JSON.stringify({
      contents,
      ...(tools.length
        ? {
            tools: [
              {
                functionDeclarations: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.parameters,
                })),
              },
            ],
          }
        : {}),
      generationConfig: {
        candidateCount: 1,
        maxOutputTokens: this.config.maxOutputTokens,
        thinkingConfig: {
          thinkingLevel: this.config.thinkingLevel.toUpperCase(),
        },
      },
    });
    // UTF-8 bytes bound is a conservative token bound for this text/JSON-only protocol.
    if (
      Buffer.byteLength(body) > this.config.maxInputTokens ||
      Buffer.byteLength(body) > 4 * 1024 * 1024
    )
      throw Error("Vertex input exceeds configured bound");
    return body;
  }
  async generate(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    context: InferenceContext = {},
  ): Promise<ModelResult> {
    const fence = invocationFence(
      signal,
      context.deadlineAt,
      context.assertAuthority,
    );
    signal = fence.signal;
    const check = fence.check;
    check();
    this.reservation(messages, tools);
    let pricing = this.price(this.clock());
    const body = this.body(messages, tools);
    const diagnostic: InferenceDiagnostic = {
      version: 1,
      id: `inference_${String(this.clock()).padStart(13, "0")}_${randomUUID()}`,
      attemptId: context.attemptId,
      goalId: context.goalId,
      taskId: context.taskId,
      generation: context.generation,
      sessionId: context.sessionId,
      provider: this.providerId,
      endpoint: "https://aiplatform.googleapis.com/",
      model: this.config.model,
      maxOutputTokens: this.config.maxOutputTokens,
      project: this.config.project,
      location: this.config.location,
      quotaProject: this.config.quotaProject,
      thinkingLevel: this.config.thinkingLevel,
      pricingVersion: pricing.version,
      startedAt: this.clock(),
      phase: "authentication",
      status: "active",
      usageStatus: "unknown",
    };
    this.diagnostics?.diagnostic(diagnostic);
    try {
      const headers = await abortable(
        this.authentication(signal, { ...context, assertAuthority: check }),
        signal,
      );
      check();
      pricing = this.price(this.clock());
      diagnostic.pricingVersion = pricing.version;
      // No inference POST retries: any dispatched request can have incurred charges.
      diagnostic.phase = "headers";
      this.diagnostics?.diagnostic(diagnostic);
      check();
      diagnostic.providerRequestStarted = true;
      const response = await abortable(
        this.fetcher(vertexEndpoint(this.config), {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "x-goog-user-project": this.config.quotaProject,
          },
          body,
        }),
        signal,
      );
      try {
        check();
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      diagnostic.httpStatus = response.status;
      diagnostic.requestIds = requestIds(response.headers);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new ProviderFailure(
          classifyFailure({}, response.status, diagnostic.id),
        );
      }
      diagnostic.phase = "body";
      let finished = false;
      let finalUsage = false;
      let usage: z.output<typeof usageSchema> | undefined;
      let modelVersion: string | undefined, responseId: string | undefined;
      const parts: z.output<typeof partSchema>[] = [];
      const events = this.config.stream
        ? sse(response, signal, check)
        : [await boundedJson(response, signal, 32 * 1024 * 1024, check)];
      for await (const raw of events) {
        check();
        const e = eventSchema.parse(raw);
        if (e.promptFeedback?.blockReason)
          throw new ProviderFailure(failureRecord("policy_refusal"));
        if (e.modelVersion) {
          if (modelVersion && modelVersion !== e.modelVersion)
            throw Error("Inconsistent Vertex model version");
          modelVersion = e.modelVersion;
        }
        if (e.responseId) {
          if (responseId && responseId !== e.responseId)
            throw Error("Inconsistent Vertex response ID");
          responseId = e.responseId;
        }
        if (e.usageMetadata) {
          if (
            usage &&
            (e.usageMetadata.promptTokenCount < usage.promptTokenCount ||
              e.usageMetadata.candidatesTokenCount <
                usage.candidatesTokenCount ||
              e.usageMetadata.thoughtsTokenCount < usage.thoughtsTokenCount ||
              e.usageMetadata.cachedContentTokenCount <
                usage.cachedContentTokenCount)
          )
            throw Error("Vertex usage decreased");
          usage = e.usageMetadata; // cumulative snapshots, never sum them
          diagnostic.tokenUsage = {
            prompt: usage.promptTokenCount,
            candidates: usage.candidatesTokenCount,
            thinking: usage.thoughtsTokenCount,
            cached: usage.cachedContentTokenCount,
          };
        }
        diagnostic.modelVersion = modelVersion;
        if (responseId)
          diagnostic.requestIds = {
            ...diagnostic.requestIds,
            "vertex-response-id": responseId,
          };
        const candidate = e.candidates?.[0];
        if (finished && candidate?.content?.parts.length)
          throw Error("Content after Vertex completion");
        parts.push(...(candidate?.content?.parts ?? []));
        if (
          parts.length > 4096 ||
          parts.filter((p) => p.functionCall).length > 64
        )
          throw Error("Vertex output exceeded bound");
        if (candidate?.content?.parts.length)
          context.progress?.("model_output");
        if (candidate?.finishReason) {
          if (finished) throw Error("Duplicate Vertex completion");
          if (candidate.finishReason !== "STOP")
            throw new ProviderFailure(
              failureRecord(
                candidate.finishReason === "MAX_TOKENS"
                  ? "incomplete_stream"
                  : "policy_refusal",
              ),
            );
          finished = true;
        }
        // An interim snapshot cannot settle later output. Vertex may supply
        // final cumulative usage on STOP or in a subsequent usage-only event.
        if (finished && e.usageMetadata) finalUsage = true;
      }
      check();
      if (!finished || !finalUsage || !usage || !modelVersion)
        throw Error("Vertex stream incomplete or missing usage/model version");
      if (
        (parts.some((p) => p.functionCall || (!p.thought && p.text)) &&
          usage.candidatesTokenCount === 0) ||
        (parts.some((p) => p.thought && p.text) &&
          usage.thoughtsTokenCount === 0)
      )
        throw Error("Vertex usage omits generated tokens");
      if (
        usage.promptTokenCount > this.config.maxInputTokens ||
        usage.candidatesTokenCount + usage.thoughtsTokenCount >
          this.config.maxOutputTokens
      )
        throw Error("Vertex usage exceeds admitted bounds");
      const result: ModelResult = {
        text: parts
          .filter((p) => !p.thought)
          .map((p) => p.text ?? "")
          .join(""),
        calls: parts.flatMap((p) =>
          p.functionCall
            ? [
                {
                  id: p.functionCall.id ?? randomUUID(),
                  name: p.functionCall.name,
                  arguments: p.functionCall.args,
                },
              ]
            : [],
        ),
        nativeParts: parts,
        inputTokens: usage.promptTokenCount,
        outputTokens: usage.candidatesTokenCount + usage.thoughtsTokenCount,
        vertexUsage: {
          prompt: usage.promptTokenCount,
          candidates: usage.candidatesTokenCount,
          thinking: usage.thoughtsTokenCount,
          cached: usage.cachedContentTokenCount,
          pricingVersion: pricing.version,
          modelVersion,
          requestId: responseId,
        },
      };
      if (new Set(result.calls.map((c) => c.id)).size !== result.calls.length)
        throw Error("Duplicate Vertex tool ID");
      if (result.calls.some((c) => !tools.some((t) => t.name === c.name)))
        throw Error("Unknown Vertex tool");
      diagnostic.modelVersion = modelVersion;
      diagnostic.tokenUsage = result.vertexUsage;
      if (responseId)
        diagnostic.requestIds = {
          ...diagnostic.requestIds,
          "vertex-response-id": responseId,
        };
      const cost = this.cost(result);
      check();
      diagnostic.providerCostUsd = cost;
      diagnostic.usageStatus = "reported";
      diagnostic.status = "completed";
      return result;
    } catch (error) {
      const failure = classifyFailure(
        signal.aborted ? signal.reason : error,
        diagnostic.httpStatus,
        diagnostic.id,
      );
      diagnostic.failure = failure;
      diagnostic.status = "failed";
      if (signal.aborted && signal.reason?.name !== "TimeoutError")
        throw signal.reason;
      throw new ProviderFailure(failure);
    } finally {
      diagnostic.endedAt = this.clock();
      diagnostic.durationMs = diagnostic.endedAt - diagnostic.startedAt;
      this.diagnostics?.diagnostic(diagnostic);
    }
  }
}
