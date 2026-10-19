import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ReliabilityStore,
  ProviderFailure,
  classifyFailure,
  failureRecord,
  requestIds,
  sanitizedEndpoint,
  abortable,
  boundedErrorBody,
  deadlineSignal,
  type InferenceDiagnostic,
} from "./reliability.js";
import { inferenceHttpFetch } from "./inferenceHttp.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { SqliteStore, sql } from "../sqlite.js";
import { ControlError } from "./schema.js";
export interface InferenceCapability {
  sessionId: string;
  goalId: string;
  taskId: string;
  generation: number;
  provider: string;
  protocol: "responses" | "messages";
  model: string;
  expiresAt: number;
  maxOutputTokens?: number;
  revoked?: boolean;
}
export interface TrustedUpstream {
  protocol: "responses" | "messages";
  endpoint: string;
  headers: () => Promise<Record<string, string>>;
  allowedBetaHeaders?: string[];
  maxOutputTokens?: number;
  pricing?: {
    inputUsdPerMillion: number;
    cachedInputUsdPerMillion: number;
    outputUsdPerMillion: number;
    evidenceUrl: string;
  };
}
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class InferenceGateway {
  private readonly activeRequests = new Map<string, Set<AbortController>>();
  private readonly admittedRequests = new Set<string>();
  constructor(
    readonly db: SqliteStore,
    readonly upstreams: Record<string, TrustedUpstream>,
    readonly assertLease: (capability: InferenceCapability) => void,
    readonly fetcher: typeof fetch = inferenceHttpFetch,
    readonly clock = Date.now,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS inference_capabilities(hash TEXT PRIMARY KEY,record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS inference_usage(id INTEGER PRIMARY KEY AUTOINCREMENT,capability_hash TEXT NOT NULL,record TEXT NOT NULL,created_at INTEGER NOT NULL);",
    );
    new ReliabilityStore(db, clock).migrate();
    for (const upstream of Object.values(upstreams)) {
      const url = new URL(upstream.endpoint);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          "Gateway upstream requires a fixed credential-free HTTPS endpoint",
        );
    }
  }
  issue(capability: InferenceCapability) {
    if (
      !this.upstreams[capability.provider] ||
      this.upstreams[capability.provider].protocol !== capability.protocol ||
      !capability.model ||
      capability.expiresAt <= this.clock()
    )
      throw new Error("Invalid inference capability");
    this.assertLease(capability);
    const token = randomBytes(32).toString("base64url");
    this.db.exec(
      `INSERT INTO inference_capabilities VALUES(${sql(hash(token))},${sql(JSON.stringify(capability))})`,
    );
    return token;
  }
  revoke(sessionId: string) {
    for (const row of this.db.query<{ hash: string; record: string }>(
      "SELECT hash,record FROM inference_capabilities",
    )) {
      const capability: InferenceCapability = JSON.parse(row.record);
      if (capability.sessionId === sessionId)
        this.db.exec(
          `UPDATE inference_capabilities SET record=${sql(JSON.stringify({ ...capability, revoked: true }))} WHERE hash=${sql(row.hash)}`,
        );
    }
    for (const abort of this.activeRequests.get(sessionId) ?? []) abort.abort();
  }
  authenticate(token: string) {
    const row = this.db.one<{ record: string }>(
      `SELECT record FROM inference_capabilities WHERE hash=${sql(hash(token))}`,
    );
    if (!row)
      throw new ControlError(
        "unauthorized",
        "Invalid inference capability",
        401,
      );
    const capability: InferenceCapability = JSON.parse(row.record);
    if (capability.revoked || capability.expiresAt <= this.clock())
      throw new ControlError(
        "unauthorized",
        "Inference capability expired or revoked",
        401,
      );
    this.assertLease(capability);
    return capability;
  }
  server() {
    return createServer((req, res) => {
      void this.handle(req, res);
    });
  }
  async handle(req: IncomingMessage, res: ServerResponse) {
    let tokenHash: string | undefined;
    let sessionId: string | undefined;
    let capability: InferenceCapability | undefined;
    const abort = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let diagnostic: InferenceDiagnostic | undefined;
    let admittedKey: string | undefined;
    let requestAdmitted = false;
    let providerRequestStarted = false;
    let reportedUsage: any = null;
    const diagnostics = new ReliabilityStore(this.db, this.clock);
    req.on("aborted", () => abort.abort());
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const token =
        req.headers.authorization?.replace(/^Bearer /, "") ??
        String(req.headers["x-api-key"] ?? "");
      capability = this.authenticate(token);
      sessionId = capability.sessionId;
      const active =
        this.activeRequests.get(sessionId) ?? new Set<AbortController>();
      active.add(abort);
      this.activeRequests.set(sessionId, active);
      tokenHash = hash(token);
      const path =
        capability.protocol === "responses" ? "/v1/responses" : "/v1/messages";
      if (req.method !== "POST" || req.url !== path)
        throw new ControlError("protocol", "Unsupported inference route", 400);
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024)
          throw new ControlError(
            "input_limit",
            "Inference request too large",
            413,
          );
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.model !== capability.model)
        throw new ControlError(
          "model_scope",
          "Requested model is outside the session capability",
          403,
        );
      const outputLimit = Math.min(
        capability.maxOutputTokens ?? 32768,
        this.upstreams[capability.provider].maxOutputTokens ?? 32768,
      );
      const requestedOutput =
        capability.protocol === "responses"
          ? body.max_output_tokens
          : body.max_tokens;
      if (
        requestedOutput !== undefined &&
        (!Number.isSafeInteger(requestedOutput) ||
          requestedOutput < 1 ||
          requestedOutput > outputLimit)
      )
        throw new ControlError(
          "output_limit",
          `Requested output must contain between 1 and ${outputLimit} tokens`,
          400,
        );
      if (capability.protocol === "responses" && requestedOutput === undefined)
        body.max_output_tokens = outputLimit;
      if (capability.protocol === "messages" && requestedOutput === undefined)
        throw new ControlError(
          "output_limit",
          "Messages requests require bounded max_tokens",
          400,
        );
      // Reject server-executed tools and external references; local harness function
      // definitions and tool outputs retain their original protocol representation.
      if (
        body.background ||
        body.previous_response_id ||
        body.store ||
        (body.tools ?? []).some((tool: any) =>
          capability!.protocol === "responses"
            ? tool.type !== "function"
            : Boolean(tool.type),
        )
      )
        throw new ControlError(
          "protocol",
          "Unsupported server-side inference feature",
          400,
        );
      if (capability.protocol === "responses") body.store = false;
      const upstream = this.upstreams[capability.provider];
      diagnostic = {
        version: 1,
        id: `inference_${String(this.clock()).padStart(13, "0")}_${randomUUID()}`,
        attemptId: this.db.one(
          "SELECT name FROM sqlite_master WHERE name='control_attempts'",
        )
          ? this.db.one<{ id: string }>(
              `SELECT id FROM control_attempts WHERE execution_session_id=${sql(sessionId)} AND outcome='active' LIMIT 1`,
            )?.id
          : undefined,
        goalId: capability.goalId,
        taskId: capability.taskId,
        generation: capability.generation,
        sessionId,
        provider: capability.provider,
        model: capability.model,
        maxOutputTokens: body.max_output_tokens ?? body.max_tokens,
        reasoningEffort: ["low", "medium", "high"].includes(
          body.reasoning?.effort,
        )
          ? body.reasoning.effort
          : undefined,
        endpoint: sanitizedEndpoint(upstream.endpoint),
        startedAt: this.clock(),
        phase: "authentication",
        status: "active",
      };
      // Native harness retries are requests, not new authority. Serialize them
      // before any await and retain failure/backoff across gateway restarts.
      const key = diagnostic.attemptId ?? sessionId;
      if (this.admittedRequests.has(key))
        throw new ControlError(
          "inference_busy",
          "Inference is already in flight",
          409,
        );
      this.admittedRequests.add(key);
      admittedKey = key;
      const runtime = diagnostic.attemptId
        ? diagnostics.runtime(diagnostic.attemptId)
        : undefined;
      requestSignal = deadlineSignal(
        Math.min(
          capability.expiresAt,
          runtime?.deadlineAt ?? capability.expiresAt,
        ),
        abort.signal,
      );
      const unresolved = this.db.one<{ record: string }>(
        `SELECT record FROM inference_diagnostics WHERE ${diagnostic.attemptId ? `attempt_id=${sql(diagnostic.attemptId)}` : `json_extract(record,'$.sessionId')=${sql(sessionId)}`} AND json_extract(record,'$.status')='active' LIMIT 1`,
      );
      if (unresolved)
        throw new ProviderFailure(
          failureRecord("interrupted", {
            diagnosticId: JSON.parse(unresolved.record).id,
          }),
        );
      if (runtime?.failure) {
        const previous = runtime.failure;
        if (
          !previous.httpStatus ||
          !["rate_limit", "service"].includes(previous.kind) ||
          runtime.retryCount >= 3
        )
          throw new ProviderFailure(previous);
        if (!runtime.nextRetryAt || runtime.nextRetryAt >= runtime.deadlineAt)
          throw new ProviderFailure(previous);
        const wait = runtime.nextRetryAt - this.clock();
        if (wait > 0) await delay(wait, undefined, { signal: requestSignal });
        this.authenticate(token);
        requestSignal.throwIfAborted();
        const current = diagnostics.runtime(runtime.attemptId)!;
        current.retryCount++;
        diagnostics.saveRuntime(current);
      }
      if (!runtime) {
        const previous = this.db.one<{ record: string }>(
          `SELECT record FROM inference_diagnostics WHERE json_extract(record,'$.sessionId')=${sql(sessionId)} AND json_extract(record,'$.failure') IS NOT NULL ORDER BY id DESC LIMIT 1`,
        );
        if (previous)
          throw new ProviderFailure(JSON.parse(previous.record).failure);
      }
      requestAdmitted = true;
      diagnostics.diagnostic(diagnostic);
      const trustedHeaders = await import("./reliability.js").then(
        ({ abortable }) => abortable(upstream.headers(), requestSignal!),
      );
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...trustedHeaders,
      };
      if (capability.protocol === "messages") {
        headers["anthropic-version"] = "2023-06-01";
        // Beta semantics require explicit gateway support rather than silent forwarding.
        const requested = String(req.headers["anthropic-beta"] ?? "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        if (
          requested.some((beta) => !upstream.allowedBetaHeaders?.includes(beta))
        )
          throw new ControlError(
            "protocol",
            "Anthropic beta headers require explicit gateway support",
            400,
          );
        if (requested.length) headers["anthropic-beta"] = requested.join(",");
      }
      this.authenticate(token);
      diagnostic.phase = "headers";
      diagnostics.diagnostic(diagnostic);
      providerRequestStarted = true;
      const response = await abortable(
        this.fetcher(upstream.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          signal: requestSignal,
        }),
        requestSignal,
      );
      diagnostic.httpStatus = response.status;
      diagnostic.requestIds = requestIds(response.headers);
      diagnostic.phase = "body";
      diagnostics.diagnostic(diagnostic);
      if (!response.ok) {
        const raw = await boundedErrorBody(response, requestSignal);
        throw new ProviderFailure({
          ...classifyFailure(raw, response.status, diagnostic.id),
          requestIds: diagnostic.requestIds,
          retryAfterMs: (() => {
            const value = response.headers.get("retry-after");
            if (!value) return undefined;
            const ms = /^\d+(\.\d+)?$/.test(value)
              ? Number(value) * 1000
              : Date.parse(value) - this.clock();
            return Number.isFinite(ms)
              ? Math.min(300000, Math.max(0, ms))
              : undefined;
          })(),
        });
      }
      const type = response.headers.get("content-type") ?? "application/json";
      if (!response.body) throw new Error("Missing upstream response");
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      const reader = response.body.getReader();
      let total = 0,
        scan = "",
        usage: any = null,
        complete = false;
      const consume = (event: any) => {
        if (event.response?.usage) reportedUsage = event.response.usage;
        if (event.type === "response.incomplete")
          throw new ProviderFailure(
            failureRecord("incomplete_stream", {
              diagnosticId: diagnostic?.id,
              providerCode: event.response?.incomplete_details?.reason,
            }),
          );
        if (event.type === "error" || event.type === "response.failed")
          throw new ProviderFailure(
            classifyFailure(event, undefined, diagnostic?.id),
          );
        if (
          event.type === "response.refusal.delta" ||
          event.type === "response.refusal.done" ||
          (event.response?.output ?? []).some((item: any) =>
            (item.content ?? []).some((part: any) => part.type === "refusal"),
          )
        )
          throw new ProviderFailure(
            failureRecord("policy_refusal", { diagnosticId: diagnostic?.id }),
          );
        if (
          [
            "response.output_text.delta",
            "response.function_call_arguments.delta",
            "content_block_delta",
          ].includes(event.type) &&
          diagnostic?.attemptId
        ) {
          const runtime = diagnostics.runtime(diagnostic.attemptId);
          if (runtime && this.clock() - runtime.lastProgressAt >= 1000)
            diagnostics.progress(diagnostic.attemptId, "model_output");
        }
        if (event.type === "response.completed") {
          usage = event.response?.usage ?? null;
          complete = true;
        }
        if (event.type === "message_start")
          usage = event.message?.usage ?? usage;
        if (event.type === "message_delta")
          usage = { ...(usage ?? {}), ...(event.usage ?? {}) };
        if (event.type === "message_stop") complete = true;
      };
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await abortable(reader.read(), requestSignal);
        if (done) break;
        this.authenticate(token);
        total += value.length;
        if (total > 32 * 1024 * 1024)
          throw new Error("Inference response limit exceeded");
        scan += decoder.decode(value, { stream: true });
        scan = scan.replace(/\r\n/g, "\n");
        if (type.includes("text/event-stream")) {
          let boundary: number;
          while ((boundary = scan.indexOf("\n\n")) >= 0) {
            const frame = scan.slice(0, boundary);
            scan = scan.slice(boundary + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data && data !== "[DONE]") {
              let event;
              try {
                event = JSON.parse(data);
              } catch {
                throw new ControlError(
                  "protocol",
                  "Upstream inference event was malformed",
                  502,
                );
              }
              consume(event);
            }
          }
        }
        if (!res.write(value))
          await abortable(
            new Promise<void>((yes, no) => {
              res.once("drain", yes);
              res.once("close", () => no(new Error("Client disconnected")));
            }),
            requestSignal,
          );
      }
      if (type.includes("text/event-stream") && scan.trim())
        throw new ControlError(
          "protocol",
          "Upstream stream ended with an incomplete event",
          502,
        );
      if (!type.includes("text/event-stream")) {
        const data = JSON.parse(scan);
        consume({
          type:
            data.status === "incomplete"
              ? "response.incomplete"
              : data.status === "failed"
                ? "response.failed"
                : "response.completed",
          response: data,
        });
        usage = data.usage ?? null;
        complete = true;
      }
      if (!complete)
        throw new ControlError(
          "protocol",
          "Upstream stream ended without a complete result",
          502,
        );
      this.usage(tokenHash, {
        ...capability,
        status: 200,
        usage,
        costUsd: this.price(capability.provider, usage),
        costStatus:
          this.price(capability.provider, usage) === null
            ? "unknown"
            : "estimated",
        pricingEvidence: upstream.pricing?.evidenceUrl,
        complete,
      });
      diagnostic.status = "completed";
      diagnostic.usageStatus = usage ? "reported" : "unknown";
      if (diagnostic.attemptId) {
        const runtime = diagnostics.runtime(diagnostic.attemptId);
        if (runtime) {
          runtime.failure = undefined;
          runtime.nextRetryAt = undefined;
          diagnostics.saveRuntime(runtime);
        }
      }
      res.end();
    } catch (error) {
      const failure =
        error instanceof ProviderFailure
          ? error.failure
          : classifyFailure(
              requestSignal?.aborted
                ? requestSignal.reason
                : abort.signal.aborted
                  ? new Error("Execution interrupted")
                  : error,
              error instanceof ControlError && !providerRequestStarted
                ? error.status
                : undefined,
              diagnostic?.id,
            );
      if (diagnostic) {
        diagnostic.status = "failed";
        diagnostic.failure = failure;
        diagnostic.usageStatus = reportedUsage ? "reported" : "unknown";
        // Persist before closing a refused/failed stream: the native server can
        // submit another POST immediately. Local protocol errors grant no retry.
        if (requestAdmitted && diagnostic.attemptId) {
          const runtime = diagnostics.runtime(diagnostic.attemptId);
          if (runtime) {
            runtime.failure = failure;
            runtime.nextRetryAt =
              failure.httpStatus &&
              ["rate_limit", "service"].includes(failure.kind)
                ? this.clock() +
                  Math.min(
                    300000,
                    Math.max(
                      failure.retryAfterMs ?? 0,
                      10000 * 2 ** runtime.retryCount,
                    ) + Math.floor(Math.random() * 1000),
                  )
                : undefined;
            diagnostics.saveRuntime(runtime);
          }
        }
      }
      if (tokenHash)
        this.usage(tokenHash, {
          ...capability,
          status: "failed",
          errorCode:
            error instanceof ControlError ? error.code : "gateway_failed",
          ...(error instanceof ControlError && error.code === "protocol"
            ? {
                betaHeaders: String(req.headers["anthropic-beta"] ?? "")
                  .split(",")
                  .filter(Boolean),
              }
            : {}),
          usage: reportedUsage,
          costUsd: capability
            ? this.price(capability.provider, reportedUsage)
            : null,
          costStatus:
            capability &&
            this.price(capability.provider, reportedUsage) !== null
              ? "estimated"
              : "unknown",
          complete: false,
        });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status =
        error instanceof ControlError
          ? error.status
          : error instanceof ProviderFailure && !requestAdmitted
            ? 400 // Terminal admission denial; do not invite native POST retries.
            : error instanceof ProviderFailure
              ? (error.failure.httpStatus ??
                (error.failure.kind === "policy_refusal" ? 403 : 502))
              : 502;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message:
              error instanceof ControlError ? error.message : failure.message,
            ...(diagnostic
              ? {
                  code: failure.providerCode ?? failure.kind,
                  diagnosticId: diagnostic.id,
                }
              : {}),
          },
        }),
      );
    } finally {
      if (diagnostic) {
        diagnostic.endedAt = this.clock();
        diagnostic.durationMs = diagnostic.endedAt - diagnostic.startedAt;
        diagnostics.diagnostic(diagnostic);
      }
      abort.abort();
      if (admittedKey) this.admittedRequests.delete(admittedKey);
      if (sessionId) {
        const active = this.activeRequests.get(sessionId);
        active?.delete(abort);
        if (!active?.size) this.activeRequests.delete(sessionId);
      }
    }
  }
  private price(provider: string, usage: any): number | null {
    const pricing = this.upstreams[provider]?.pricing;
    if (
      !pricing ||
      !usage ||
      !Number.isSafeInteger(usage.input_tokens) ||
      !Number.isSafeInteger(usage.output_tokens) ||
      usage.input_tokens < 0 ||
      usage.output_tokens < 0
    )
      return null;
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    if (
      !Number.isSafeInteger(cached) ||
      cached < 0 ||
      cached > usage.input_tokens
    )
      return null;
    return (
      ((usage.input_tokens - cached) * pricing.inputUsdPerMillion +
        cached * pricing.cachedInputUsdPerMillion +
        usage.output_tokens * pricing.outputUsdPerMillion) /
      1e6
    );
  }
  sessionUsage(sessionId: string) {
    const records = this.db
      .query<{ record: string }>("SELECT record FROM inference_usage")
      .map((row) => JSON.parse(row.record))
      .filter((row) => row.sessionId === sessionId);
    const completeCounters =
      records.length > 0 &&
      records.every(
        (row) =>
          Number.isSafeInteger(row.usage?.input_tokens) &&
          row.usage.input_tokens >= 0 &&
          Number.isSafeInteger(row.usage?.output_tokens) &&
          row.usage.output_tokens >= 0,
      );
    const counters = completeCounters
      ? {
          inputTokens: records.reduce(
            (sum, row) => sum + row.usage.input_tokens,
            0,
          ),
          outputTokens: records.reduce(
            (sum, row) => sum + row.usage.output_tokens,
            0,
          ),
        }
      : {};
    if (
      !records.length ||
      records.some(
        (row) =>
          !row.usage || row.costUsd === null || row.costUsd === undefined,
      )
    )
      return {
        kind: "metered" as const,
        status: "unknown" as const,
        ...counters,
      };
    return {
      kind: "metered" as const,
      status: "estimated" as const,
      costUsd: records.reduce((sum, row) => sum + row.costUsd, 0),
      ...counters,
    };
  }

  private usage(tokenHash: string, record: unknown) {
    this.db.exec(
      `INSERT INTO inference_usage(capability_hash,record,created_at) VALUES(${sql(tokenHash)},${sql(JSON.stringify(record))},${this.clock()})`,
    );
  }
}
