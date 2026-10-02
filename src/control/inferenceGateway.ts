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
  revoked?: boolean;
}
export interface TrustedUpstream {
  protocol: "responses" | "messages";
  endpoint: string;
  headers: () => Promise<Record<string, string>>;
  allowedBetaHeaders?: string[];
}
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class InferenceGateway {
  private readonly activeRequests = new Map<string, Set<AbortController>>();
  constructor(
    readonly db: SqliteStore,
    readonly upstreams: Record<string, TrustedUpstream>,
    readonly assertLease: (capability: InferenceCapability) => void,
    readonly fetcher: typeof fetch = fetch,
    readonly clock = Date.now,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS inference_capabilities(hash TEXT PRIMARY KEY,record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS inference_usage(id INTEGER PRIMARY KEY AUTOINCREMENT,capability_hash TEXT NOT NULL,record TEXT NOT NULL,created_at INTEGER NOT NULL);",
    );
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
      const requestedOutput =
        capability.protocol === "responses"
          ? body.max_output_tokens
          : body.max_tokens;
      if (
        requestedOutput !== undefined &&
        (!Number.isSafeInteger(requestedOutput) ||
          requestedOutput < 1 ||
          requestedOutput > 32768)
      )
        throw new ControlError(
          "output_limit",
          "Requested output must contain between 1 and 32768 tokens",
          400,
        );
      if (capability.protocol === "responses" && requestedOutput === undefined)
        body.max_output_tokens = 32768;
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
      const trustedHeaders = await upstream.headers();
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
      const response = await this.fetcher(upstream.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3600000)]),
      });
      if (!response.ok) {
        this.usage(tokenHash, {
          ...capability,
          status: response.status,
          usage: null,
          costUsd: null,
          complete: false,
        });
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `Upstream inference failed (${response.status})`,
            },
          }),
        );
        return;
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
        const { value, done } = await reader.read();
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
            for (const line of frame.split("\n"))
              if (line.startsWith("data: ") && line !== "data: [DONE]")
                try {
                  consume(JSON.parse(line.slice(6)));
                } catch {}
          }
        }
        if (!res.write(value))
          await new Promise<void>((yes, no) => {
            res.once("drain", yes);
            res.once("close", () => no(new Error("Client disconnected")));
          });
      }
      if (!type.includes("text/event-stream")) {
        const data = JSON.parse(scan);
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
        costUsd: null,
        complete,
      });
      res.end();
    } catch (error) {
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
          usage: null,
          costUsd: null,
          complete: false,
        });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error instanceof ControlError ? error.status : 502;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message:
              error instanceof ControlError
                ? error.message
                : "Inference gateway failed",
          },
        }),
      );
    } finally {
      abort.abort();
      if (sessionId) {
        const active = this.activeRequests.get(sessionId);
        active?.delete(abort);
        if (!active?.size) this.activeRequests.delete(sessionId);
      }
    }
  }
  private usage(tokenHash: string, record: unknown) {
    this.db.exec(
      `INSERT INTO inference_usage(capability_hash,record,created_at) VALUES(${sql(tokenHash)},${sql(JSON.stringify(record))},${this.clock()})`,
    );
  }
}
