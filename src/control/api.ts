import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual, randomBytes, createHash } from "node:crypto";
import { usageReconciliationSchema } from "./usage.js";
import { z } from "zod";
import { ControlStore, type Principal } from "./store.js";
import {
  ControlError,
  goalSchema,
  backendSwitchSchema,
  planSchema,
  questionSchema,
  ownerOperationSchema,
  scheduleSchema,
  projectSchema,
} from "./schema.js";
import { CONTROL_HTML } from "./ui.js";
import { dashboardSnapshot } from "./dashboard.js";
import {
  connectorHealth,
  recordConnectorHealth,
  type ConnectorDescriptor,
} from "./connectorHealth.js";
import { readArtifact } from "./artifacts.js";
import { releaseSource } from "./sourceDelivery.js";
import { sql } from "../sqlite.js";
import {
  pendingDeliveries,
  settleDelivery,
  retryDelivery,
  humanCommandSchema,
  type HumanCommandService,
} from "./human.js";
import {
  provisionAutomation,
  revokeAutomation,
  automationPolicies,
  authorizeAutomation,
  automationPolicy,
  automationPolicySchema,
} from "./automationAuth.js";
const claimSchema = z.object({
  workerId: z.string().min(1),
  goalId: z.string().optional(),
});
const leaseSchema = z.object({
  workerId: z.string().min(1),
  generation: z.number().int().positive(),
});
const actionSchema = z.object({
  status: z.enum(["paused", "running", "cancelled"]),
  revision: z.number().int().positive(),
});
export function createControlServer(
  store: ControlStore,
  options: {
    token: string;
    host?: string;
    stateRoot?: string;
    allowedOrigins?: string[];
    validateGoal?: (
      input: import("./schema.js").GoalInput,
    ) => import("./schema.js").GoalConfig;
    applyConfiguration?: (hash: string) => Promise<unknown>;
    onBackup?: (
      destination: string,
      recipientFile: string,
      complete: boolean,
    ) => Promise<unknown>;
    provisionConnector?: (id: string) => Promise<unknown>;
    humanService?: () => HumanCommandService;
    connectors?: () => ConnectorDescriptor[];
    externalClaimsDisabled?: boolean;
    onExecutionMaintenance?: (apply: boolean) => Promise<unknown>;
    claimTask?: (
      workerId: string,
      goalId?: string,
    ) => Promise<import("./schema.js").Claim | null>;
    onClaim?: (
      claim: import("./schema.js").Claim,
    ) => Promise<import("./schema.js").Claim>;
    replayResult?: (
      taskId: string,
      workerId: string,
      generation: number,
      result: unknown,
    ) => unknown | undefined;
    onResult?: (
      taskId: string,
      workerId: string,
      generation: number,
      result: unknown,
    ) => Promise<unknown>;
  },
) {
  if (options.token.length < 24)
    throw new Error("Control token must contain at least 24 characters");
  const sessions = new Map<string, { csrf: string; expiresAt: number }>();
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    );
    try {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      const authority = req.headers.host ?? "";
      const localPort = req.socket.localPort;
      const allowedHosts = [
        `127.0.0.1:${localPort}`,
        `localhost:${localPort}`,
        ...(options.allowedOrigins ?? []).map((o) => new URL(o).host),
      ];
      if (!allowedHosts.includes(authority))
        throw new ControlError("host", "Host is not authorized", 403);
      const originAllowed =
        !req.headers.origin ||
        [
          `http://127.0.0.1:${localPort}`,
          `http://localhost:${localPort}`,
          ...(options.allowedOrigins ?? []),
        ].includes(req.headers.origin);
      if (!originAllowed)
        throw new ControlError("origin", "Origin is not authorized", 403);
      if (url.pathname === "/") return html(res, CONTROL_HTML);
      if (url.pathname === "/api/v1/openapi.json")
        return send(res, 200, openApi());
      if (!url.pathname.startsWith("/api/v1/"))
        throw new ControlError(
          "not_found",
          "Use the /api/v1 application contract",
          404,
        );
      const credential =
        req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      for (const [id, session] of sessions)
        if (session.expiresAt <= Date.now()) sessions.delete(id);
      const cookieId = /(?:^|;\s*)mc_session=([a-f0-9]{64})(?:;|$)/.exec(
        req.headers.cookie ?? "",
      )?.[1];
      const session = cookieId ? sessions.get(cookieId) : undefined;
      const principal =
        equal(credential, options.token) || session
          ? ({ actor: "operator", role: "operator" } as Principal)
          : store.authenticate(credential);
      if (!principal)
        throw new ControlError("unauthorized", "Authentication required", 401);
      if (
        session &&
        !["GET", "HEAD"].includes(req.method ?? "GET") &&
        (!req.headers.origin ||
          !equal(String(req.headers["x-csrf-token"] ?? ""), session.csrf))
      )
        throw new ControlError(
          "csrf",
          "Authenticated browser action requires its session CSRF token and exact origin",
          403,
        );
      const path = url.pathname.replace(/^\/api\/v1/, "");
      const method = req.method ?? "GET";
      const body = method === "POST" ? await readBody(req) : undefined;
      if (path === "/session" && method === "POST") {
        if (!equal(credential, options.token))
          throw new ControlError(
            "unauthorized",
            "Operator authentication required",
            401,
          );
        const id = randomBytes(32).toString("hex"),
          csrf = randomBytes(32).toString("hex");
        sessions.set(id, { csrf, expiresAt: Date.now() + 8 * 3600000 });
        // Remote access is explicitly configured through an HTTPS origin. No
        // forwarded header alone can claim TLS or widen the origin allowlist.
        const secure = !!req.headers.origin?.startsWith("https:");
        res.setHeader(
          "Set-Cookie",
          `mc_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? "; Secure" : ""}`,
        );
        return send(res, 200, { csrf, expiresInSeconds: 28800 });
      }
      if (path === "/session/logout" && method === "POST") {
        if (cookieId) sessions.delete(cookieId);
        res.setHeader(
          "Set-Cookie",
          "mc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        return send(res, 200, { signedOut: true });
      }
      if (
        path.startsWith("/human/") ||
        path.startsWith("/connector-deliveries")
      ) {
        if (principal.role !== "connector" || !options.humanService)
          throw new ControlError(
            "connector_role",
            "Scoped connector authority required",
            403,
          );
        const connectorId = principal.actor;
        if (path === "/human/health" && method === "POST") {
          if (
            options.connectors &&
            !options.connectors().some((c) => c.id === connectorId && c.enabled)
          )
            throw new ControlError(
              "connector_scope",
              "Connector is disabled or absent from applied configuration",
              403,
            );
          return send(
            res,
            200,
            recordConnectorHealth(store, connectorId, body),
          );
        }
        if (path === "/human/transport-state" && method === "GET")
          return send(
            res,
            200,
            store.setting(`connector-transport:${connectorId}`) ?? {},
          );
        if (path === "/human/transport-state" && method === "POST") {
          const value = z
              .object({ offset: z.number().int().nonnegative() })
              .strict()
              .parse(body),
            old = store.setting(`connector-transport:${connectorId}`) ?? {};
          if (value.offset < (old.offset ?? 0))
            throw new ControlError(
              "cursor",
              "Transport cursor cannot go backwards",
              409,
            );
          store.setting(`connector-transport:${connectorId}`, value);
          return send(res, 200, { recorded: true });
        }
        if (path === "/human/commands" && method === "POST") {
          if (store.setting("instance-maintenance"))
            throw new ControlError(
              "maintenance",
              "Connector intake paused during complete backup",
              503,
            );
          const input = z
            .object({
              principal: z
                .object({
                  externalIdentity: z.string(),
                  destination: z.string(),
                  trust: z
                    .object({
                      encrypted: z.boolean(),
                      verifiedDevice: z.boolean(),
                      allowedMembership: z.boolean(),
                      deviceId: z.string().optional(),
                    })
                    .strict(),
                })
                .strict(),
              command: z.unknown(),
            })
            .strict()
            .parse(body);
          return send(
            res,
            200,
            options
              .humanService()
              .execute({ ...input.principal, connectorId }, input.command),
          );
        }
        if (path === "/connector-deliveries" && method === "GET")
          return send(res, 200, pendingDeliveries(store, connectorId));
        const delivery = /^\/connector-deliveries\/([^/]+)$/.exec(path);
        if (delivery && method === "POST") {
          const input = z
            .discriminatedUnion("status", [
              z
                .object({
                  status: z.literal("sent"),
                  receipt: z.string().max(1000),
                })
                .strict(),
              z.object({ status: z.literal("retry") }).strict(),
            ])
            .parse(body);
          if (input.status === "sent")
            settleDelivery(store, connectorId, delivery[1], input.receipt);
          else retryDelivery(store, connectorId, delivery[1]);
          return send(res, 200, { recorded: true });
        }
        throw new ControlError(
          "not_found",
          "Connector endpoint not found",
          404,
        );
      }
      if (principal.role === "connector")
        throw new ControlError(
          "connector_role",
          "Connector credentials cannot access operator or worker endpoints",
          403,
        );
      let automation: ReturnType<typeof automationPolicy> | undefined;
      if (principal.role === "automation") {
        let goalId = /^\/goals\/([^/]+)/.exec(path)?.[1];
        const taskId = /^\/tasks\/([^/]+)/.exec(path)?.[1];
        if (taskId) goalId = store.getTask(taskId).goalId;
        const artifactId = /^\/artifacts\/([^/]+)\/content$/.exec(path)?.[1];
        if (artifactId) {
          const record = store.db.one<{ goal_id: string }>(
            `SELECT goal_id FROM control_artifacts WHERE id=${sql(artifactId)}`,
          );
          if (!record)
            throw new ControlError("not_found", "Artifact not found", 404);
          goalId = record.goal_id;
        }
        if (path === "/events") {
          goalId = url.searchParams.get("goalId") ?? undefined;
          if (!goalId)
            throw new ControlError(
              "forbidden",
              "Automation event queries require a scoped goalId",
              403,
            );
        }
        automation = authorizeAutomation(
          store,
          principal,
          path,
          method,
          body,
          goalId,
        );
        if (
          method === "POST" &&
          !["/goal-drafts"].includes(path) &&
          typeof req.headers["idempotency-key"] !== "string"
        )
          throw new ControlError(
            "idempotency_required",
            "Automation mutations require Idempotency-Key",
            400,
          );
      }
      const scopedRead = () => {
        if (principal.role !== "automation") operator();
      };
      const operator = () => {
        if (principal.role !== "operator")
          throw new ControlError(
            "forbidden",
            "Operator authority required",
            403,
          );
      };
      const lease = (taskId: string) => {
        const l = leaseSchema.parse(body);
        if (principal.role === "worker" && l.workerId !== principal.workerId)
          throw new ControlError("forbidden", "Worker identity mismatch", 403);
        store.assertLease(taskId, l.workerId, l.generation);
        return l;
      };
      const visible = (taskId: string) => {
        if (principal.role === "operator" || principal.role === "automation")
          return;
        const t = store.getTask(taskId);
        if (t.workerId !== principal.workerId)
          throw new ControlError(
            "forbidden",
            "Task is outside worker scope",
            403,
          );
      };
      const artifact = /^\/artifacts\/([a-zA-Z0-9_-]+)\/content$/.exec(path);
      if ((path === "/source" || path === "/source-info") && method === "GET") {
        operator();
        const source = await releaseSource();
        if (path === "/source-info") return send(res, 200, source.info);
        res.writeHead(200, {
          "Content-Type": "application/gzip",
          "Content-Disposition":
            'attachment; filename="missioncontrol-source.tar.gz"',
          "Content-Length": String(source.bytes.length),
        });
        res.end(source.bytes);
        return;
      }
      if (artifact && method === "GET") {
        scopedRead();
        if (!options.stateRoot)
          throw new ControlError(
            "artifact_unavailable",
            "Artifact downloads require configured instance state",
            409,
          );
        const record = store.db.one<{ location: string }>(
          `SELECT location FROM control_artifacts WHERE id=${sql(artifact[1])}`,
        );
        if (!record)
          throw new ControlError("not_found", "Artifact not found", 404);
        const data = await readArtifact(options.stateRoot, record.location);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="evidence-${artifact[1]}.bin"`,
          "Content-Length": String(data.length),
        });
        res.end(data);
        return;
      }
      if (
        path === "/execution-maintenance" &&
        ["GET", "POST"].includes(method)
      ) {
        operator();
        if (!options.onExecutionMaintenance)
          throw new ControlError(
            "execution_mode",
            "Isolated execution maintenance is unavailable",
            409,
          );
        const apply =
          method === "POST" &&
          z
            .object({ apply: z.boolean().default(false) })
            .strict()
            .parse(body).apply;
        return send(res, 200, await options.onExecutionMaintenance(apply));
      }
      if (path === "/configuration" && method === "POST") {
        operator();
        if (!options.applyConfiguration)
          throw new ControlError(
            "configuration",
            "Configuration management is unavailable",
            409,
          );
        return send(
          res,
          200,
          await options.applyConfiguration(
            z.object({ hash: z.string() }).strict().parse(body).hash,
          ),
        );
      }
      if (path === "/backups" && method === "POST") {
        operator();
        if (!options.onBackup)
          throw new ControlError("backup", "Online backup is unavailable", 409);
        const input = z
          .object({
            destination: z.string().min(1),
            recipientFile: z.string().min(1),
            complete: z.boolean().default(false),
          })
          .strict()
          .parse(body);
        return send(
          res,
          200,
          await options.onBackup(
            input.destination,
            input.recipientFile,
            input.complete,
          ),
        );
      }
      if (path === "/connector-auth" && method === "POST") {
        operator();
        if (!options.provisionConnector)
          throw new ControlError(
            "connector_auth",
            "Connector provisioning unavailable",
            409,
          );
        return send(
          res,
          200,
          await options.provisionConnector(
            z.object({ id: z.string() }).strict().parse(body).id,
          ),
        );
      }
      if (path === "/usage/unresolved" && method === "GET") {
        operator();
        return send(res, 200, store.unresolvedUsage());
      }
      if (path === "/connectors" && method === "GET") {
        operator();
        return send(
          res,
          200,
          connectorHealth(store, options.connectors?.() ?? []),
        );
      }
      const reconciliation = /^\/attempts\/([^/]+)\/usage-reconciliation$/.exec(
        path,
      );
      if (reconciliation && method === "POST") {
        operator();
        const input = usageReconciliationSchema.parse(body);
        if (!options.stateRoot)
          throw new ControlError(
            "usage_evidence",
            "Reconciliation requires owned instance evidence",
            409,
          );
        const artifact = store.db.one<{ location: string }>(
          `SELECT location FROM control_artifacts WHERE id=${sql(input.evidenceArtifactId)}`,
        );
        if (!artifact)
          throw new ControlError(
            "usage_evidence",
            "Registered evidence artifact not found",
            409,
          );
        const bytes = await readArtifact(options.stateRoot, artifact.location);
        return send(
          res,
          200,
          store.reconcileUsage(
            decodeURIComponent(reconciliation[1]),
            input,
            createHash("sha256").update(bytes).digest("hex"),
            principal.actor,
          ),
        );
      }
      if (path === "/automation-identities") {
        operator();
        if (method === "GET") return send(res, 200, automationPolicies(store));
        if (method === "POST")
          return send(res, 200, provisionAutomation(store, body));
      }
      const identityRevoke =
        /^\/automation-identities\/([a-zA-Z0-9_-]+)\/revoke$/.exec(path);
      if (identityRevoke && method === "POST") {
        operator();
        return send(res, 200, revokeAutomation(store, identityRevoke[1]));
      }
      const mutation = () => {
        if (method === "POST" && store.setting("instance-maintenance"))
          throw new ControlError(
            "maintenance",
            "Mutations paused during complete backup",
            409,
          );
        if (path === "/dashboard" && method === "GET") {
          operator();
          return dashboardSnapshot(
            store,
            options.validateGoal
              ? (config) => {
                  options.validateGoal!(config);
                  return { admissible: true };
                }
              : undefined,
            url.searchParams.get("after") ?? "",
            options.connectors?.() ?? [],
            url.searchParams.get("activeAfter") ?? "",
          );
        }
        if (path === "/goal-drafts" && method === "POST") {
          scopedRead();
          if (!options.validateGoal)
            throw new ControlError(
              "configuration",
              "Project configuration is unavailable",
              409,
            );
          const config = options.validateGoal(
            body as import("./schema.js").GoalInput,
          );
          return { valid: true, config };
        }
        if (path === "/projects" && method === "GET") {
          scopedRead();
          return store
            .projects()
            .filter((p) => !automation || automation.projectIds.includes(p.id));
        }
        if (path === "/projects" && method === "POST") {
          operator();
          if (options.validateGoal)
            throw new ControlError(
              "configuration",
              "Edit external project configuration and apply it explicitly",
              409,
            );
          return store.setProject(body, principal.actor);
        }
        if (method === "GET" && path === "/goals") {
          scopedRead();
          return store.goals(
            number(url, "limit", 50),
            url.searchParams.get("after") ?? "",
            automation?.projectIds,
          );
        }
        if (method === "POST" && path === "/goals") {
          scopedRead();
          const input = options.validateGoal
            ? options.validateGoal(body as import("./schema.js").GoalInput)
            : goalSchema.parse(body);
          return store.createGoal(input, principal.actor);
        }
        if (path === "/storage" && method === "GET") {
          operator();
          return (
            store.setting("storage-maintenance-preview") ?? {
              previewOnly: true,
              status: "awaiting_maintenance",
            }
          );
        }
        if (path === "/storage-policy" && method === "GET") {
          operator();
          return {
            mode: store.setting("storage-maintenance-mode") ?? "preview",
          };
        }
        if (path === "/storage-policy" && method === "POST") {
          operator();
          const policy = z
            .object({ mode: z.enum(["preview", "workspaces", "branches"]) })
            .strict()
            .parse(body);
          store.setting("storage-maintenance-mode", policy.mode);
          store.event("STORAGE_POLICY", principal.actor, policy);
          return policy;
        }
        if (path === "/operations" && method === "GET") {
          operator();
          return store.operations();
        }
        const operationMatch = /^\/operations\/([^/]+)$/.exec(path);
        if (operationMatch && method === "POST") {
          operator();
          const response = z
            .object({
              status: z.enum(["executing", "completed", "rejected"]),
              explanation: z.string().min(1),
              resultArtifact: z.string().min(1).optional(),
            })
            .parse(body);
          return store.respondOperation(
            operationMatch[1],
            response,
            principal.actor,
          );
        }
        if (method === "GET" && path === "/questions") {
          operator();
          return store.questions();
        }
        if (method === "GET" && path === "/workers") {
          operator();
          return store.db.query(
            "SELECT id,last_seen,capabilities FROM control_workers",
          );
        }
        if (method === "GET" && path === "/memory") {
          operator();
          return store.memory(
            url.searchParams.get("q") ?? "",
            url.searchParams.get("goalId") ?? undefined,
          );
        }
        if (method === "POST" && path === "/schedules") {
          operator();
          if (options.validateGoal)
            throw new ControlError(
              "configuration",
              "Edit external schedules and apply them explicitly",
              409,
            );
          return store.createSchedule(
            scheduleSchema.parse(body),
            principal.actor,
          );
        }
        if (method === "GET" && path === "/schedules") {
          operator();
          return store.schedules();
        }
        if (method === "POST" && path === "/tokens") {
          operator();
          if (options.externalClaimsDisabled || options.claimTask)
            throw new ControlError(
              "execution_mode",
              "Worker credentials are provisioned by approved controller dispatch",
              409,
            );
          const v = z.object({ workerId: z.string().min(1) }).parse(body);
          return { token: store.createToken(v.workerId, "worker", v.workerId) };
        }
        if (method === "POST" && path === "/claims") {
          if (options.externalClaimsDisabled && !options.claimTask)
            throw new ControlError(
              "execution_mode",
              "This service dispatches isolated workers internally",
              409,
            );
          const v = claimSchema.parse(body);
          if (principal.role === "worker" && v.workerId !== principal.workerId)
            throw new ControlError(
              "forbidden",
              "Worker identity mismatch",
              403,
            );
          if (options.claimTask)
            throw new ControlError(
              "execution_mode",
              "Approved claims use the asynchronous dispatch path",
              409,
            );
          return store.claimNextTask(v.workerId, { goalId: v.goalId });
        }
        const gm =
          /^\/goals\/([^/]+)(?:\/(tasks|attempts|plan|state|policy|artifacts|findings|evidence|backend))?$/.exec(
            path,
          );
        if (gm) {
          const gid = gm[1];
          if (
            principal.role === "worker" &&
            !store.tasks(gid).some((t) => t.workerId === principal.workerId)
          )
            throw new ControlError(
              "forbidden",
              "Goal is outside worker scope",
              403,
            );
          if (method === "GET") {
            if (gm[2] === "attempts") {
              scopedRead();
              store.getGoal(gid);
              return store.attempts(
                gid,
                Number(url.searchParams.get("limit") ?? 100),
                url.searchParams.get("after") ?? "",
              );
            }
            if (gm[2] === "tasks")
              return store
                .tasks(gid)
                .map((t) =>
                  principal.role === "worker" &&
                  t.workerId !== principal.workerId
                    ? { ...t, checkpoint: undefined }
                    : t,
                );
            if (gm[2] === "policy") return store.getGoal(gid).config.policy;
            if (gm[2] === "evidence") {
              scopedRead();
              const after = url.searchParams.get("after") ?? "";
              return store.db.query(
                `SELECT e.* FROM control_evidence e JOIN control_tasks t ON t.id=e.task_id WHERE t.goal_id=${sql(gid)} AND e.id>${sql(after)} ORDER BY e.id LIMIT ${number(url, "limit", 100)}`,
              );
            }
            if (gm[2] === "artifacts" || gm[2] === "findings") {
              scopedRead();
              return store.db.query(
                `SELECT * FROM control_${gm[2]} WHERE goal_id=${sql(gid)} AND id>${sql(url.searchParams.get("after") ?? "")} ORDER BY id LIMIT ${number(url, "limit", 100)}`,
              );
            }
            return store.getGoal(gid);
          }
          if (principal.role !== "automation") operator();
          if (gm[2] === "backend") {
            const v = backendSwitchSchema.parse(body);
            if (options.validateGoal)
              options.validateGoal({
                ...store.getGoal(gid).config,
                backend: v.backend,
              });
            return store.switchBackend(
              gid,
              v.backend,
              v.revision,
              principal.actor,
            );
          }
          if (gm[2] === "plan") {
            const v = z
              .object({ revision: z.number().int(), plan: planSchema })
              .parse(body);
            return store.installPlan(gid, v.plan, v.revision, principal.actor);
          }
          if (gm[2] === "state") {
            const v = actionSchema.parse(body);
            return store.setGoalState(
              gid,
              v.status,
              v.revision,
              principal.actor,
            );
          }
        }
        const tm =
          /^\/tasks\/([^/]+)(?:\/(heartbeat|transition|checkpoint|question|release|finding|operation))?$/.exec(
            path,
          );
        if (tm) {
          const tid = tm[1];
          if (method === "GET") {
            visible(tid);
            const task = store.getTask(tid);
            return {
              ...task,
              operatorContext: store.memory("", task.goalId),
              projectContext: store.projectContext(task.goalId),
              dependencyArtifacts: store
                .tasks(task.goalId)
                .filter((t) => task.spec.dependencies.includes(t.key))
                .map((t) => ({
                  key: t.key,
                  status: t.status,
                  result: t.result,
                })),
            };
          }
          const l = lease(tid);
          const v = body as any;
          switch (tm[2]) {
            case "operation":
              return store.requestOperation(
                tid,
                l.workerId,
                l.generation,
                ownerOperationSchema.parse(v.request),
              );
            case "heartbeat":
              return store.heartbeat(tid, l.workerId, l.generation);
            case "transition": {
              const status = z.enum(["running", "verifying"]).parse(v.status);
              return store.transition(
                tid,
                l.workerId,
                l.generation,
                status,
                v.result,
              );
            }
            case "checkpoint":
              return store.checkpoint(
                tid,
                l.workerId,
                l.generation,
                v.checkpoint,
              );
            case "question":
              return store.requestHuman(
                tid,
                l.workerId,
                l.generation,
                questionSchema.parse(v.request),
              );
            case "release":
              return store.release(
                tid,
                l.workerId,
                l.generation,
                z
                  .enum(["retry_wait", "waiting_provider", "blocked", "failed"])
                  .parse(v.status),
                z.string().parse(v.reason),
                v.actualCost === undefined
                  ? undefined
                  : z.number().nonnegative().parse(v.actualCost),
                v.usage,
              );
            case "finding":
              return {
                id: store.finding(
                  store.getTask(tid).goalId,
                  tid,
                  v.finding,
                  principal.actor,
                ),
              };
          }
        }
        const qm = /^\/questions\/([^/]+)\/answer$/.exec(path);
        if (method === "POST" && qm) {
          operator();
          const v = z
            .object({
              option: z.string(),
              revision: z.number().int(),
              explanation: z.string().optional(),
            })
            .parse(body);
          return store.answer(
            qm[1],
            v.option,
            v.revision,
            principal.actor,
            v.explanation,
          );
        }
        throw new ControlError("not_found", "Route not found", 404);
      };
      if (method === "GET" && path === "/events") {
        if (principal.role === "worker")
          throw new ControlError(
            "forbidden",
            "Goal-wide events require operator or scoped automation authority",
            403,
          );
        const after = Number(
          req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0,
        );
        if (!Number.isSafeInteger(after) || after < 0)
          throw new ControlError("invalid_cursor", "Invalid event cursor");
        const gid = url.searchParams.get("goalId") ?? undefined;
        if (req.headers.accept === "text/event-stream") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
          });
          let cursor = after;
          const pump = () => {
            if (principal.role === "automation") {
              if (!store.authenticate(credential))
                throw new ControlError(
                  "unauthorized",
                  "Automation credential revoked",
                  401,
                );
              automationPolicy(store, principal);
            }
            for (const e of store.events(cursor, gid)) {
              res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
              cursor = Number(e.id);
            }
          };
          pump();
          const timer = setInterval(() => {
            try {
              pump();
              res.write(": heartbeat\n\n");
            } catch {
              res.end();
            }
          }, 1000);
          res.on("close", () => clearInterval(timer));
          return;
        }
        return send(
          res,
          200,
          store.events(after, gid, number(url, "limit", 100)),
        );
      }
      if (method === "POST" && path === "/claims" && options.claimTask) {
        const v = claimSchema.strict().parse(body);
        if (principal.role !== "worker" || v.workerId !== principal.workerId)
          throw new ControlError(
            "forbidden",
            "Approved claim requires its registered worker identity",
            403,
          );
        return send(res, 200, await options.claimTask(v.workerId, v.goalId));
      }
      const resultMatch = /^\/tasks\/([^/]+)\/result$/.exec(path);
      if (method === "POST" && resultMatch) {
        const identity = leaseSchema.strict().parse({
          workerId: (body as any)?.workerId,
          generation: (body as any)?.generation,
        });
        if (
          principal.role === "worker" &&
          identity.workerId !== principal.workerId
        )
          throw new ControlError("forbidden", "Worker identity mismatch", 403);
        const replay = options.replayResult?.(
          resultMatch[1],
          identity.workerId,
          identity.generation,
          (body as any).result,
        );
        if (replay !== undefined) return send(res, 200, replay);
        const l = lease(resultMatch[1]);
        if (!options.onResult)
          throw new ControlError(
            "unavailable",
            "Integration service unavailable",
            503,
          );
        return send(
          res,
          200,
          await options.onResult(
            resultMatch[1],
            l.workerId,
            l.generation,
            (body as any).result,
          ),
        );
      }
      const key = req.headers["idempotency-key"];
      if (
        key !== undefined &&
        (typeof key !== "string" || key.length < 1 || key.length > 200)
      )
        throw new ControlError(
          "idempotency_key",
          "Idempotency-Key must contain 1 to 200 characters",
          400,
        );
      const response =
        method === "POST" && typeof key === "string"
          ? store.idempotent(
              `${principal.role}:${principal.actor}:${key}`,
              { path, body },
              mutation,
            )
          : mutation();
      if (
        method === "POST" &&
        path === "/claims" &&
        response &&
        options.onClaim
      )
        return send(
          res,
          200,
          await options.onClaim(response as import("./schema.js").Claim),
        );
      send(res, 200, response);
    } catch (error) {
      if (error instanceof z.ZodError)
        return send(res, 400, {
          error: {
            code: "invalid_input",
            message: error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; "),
          },
        });
      if (error instanceof ControlError)
        return send(res, error.status, {
          error: { code: error.code, message: error.message },
        });
      send(res, 500, {
        error: {
          code: "internal_error",
          message: "Control-plane operation failed",
        },
      });
    }
  });
}
function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function send(res: ServerResponse, status: number, data: unknown) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function html(res: ServerResponse, data: string) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(data);
}
async function readBody(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new ControlError("content_type", "Expected application/json", 415);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024)
      throw new ControlError("body_limit", "Request exceeds 1 MB", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ControlError("invalid_json", "Invalid JSON");
  }
}
function number(url: URL, key: string, fallback: number) {
  const raw = url.searchParams.get(key);
  const n = raw === null ? fallback : Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > 500)
    throw new ControlError("invalid_parameter", `Invalid ${key}`);
  return n;
}
export function openApi() {
  const schemas = {
    GoalInput: z.toJSONSchema(goalSchema, { io: "input" }),
    Plan: z.toJSONSchema(planSchema, { io: "input" }),
    Schedule: z.toJSONSchema(scheduleSchema, { io: "input" }),
    BackendSwitch: z.toJSONSchema(backendSwitchSchema, { io: "input" }),
    Project: z.toJSONSchema(projectSchema, { io: "input" }),
    Question: z.toJSONSchema(questionSchema, { io: "input" }),
    HumanCommand: z.toJSONSchema(humanCommandSchema, { io: "input" }),
    UsageReconciliation: z.toJSONSchema(usageReconciliationSchema, {
      io: "input",
    }),
  };
  const paths: Record<string, any> = {};
  paths["/api/v1/source-info"] = {
    get: {
      summary: "Operator: exact installed release source fingerprint",
      responses: {
        200: {
          description: "Version, source revision, SHA-256 and archive bytes",
        },
        401: { description: "Authentication required" },
        409: { description: "Reviewed matching archive unavailable" },
      },
    },
  };
  paths["/api/v1/source"] = {
    get: {
      summary: "Operator: download verified installed source archive",
      responses: {
        200: {
          description: "Bounded matching source.tar.gz",
          content: {
            "application/gzip": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        401: { description: "Authentication required" },
        409: { description: "Reviewed matching archive unavailable" },
      },
    },
  };
  paths["/api/v1/automation-identities"] = {
    get: {
      summary: "Operator: list automation policy and expiration",
      responses: {
        200: { description: "Policies without credentials" },
        403: { description: "Operator required" },
      },
    },
    post: {
      summary:
        "Operator: provision or rotate a project-scoped automation credential",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: z.toJSONSchema(automationPolicySchema, { io: "input" }),
          },
        },
      },
      responses: {
        200: {
          description:
            "Credential and policy; persist credential to a private file and never log response",
        },
        403: { description: "Operator required" },
        409: { description: "Project disabled or unknown" },
      },
    },
  };
  paths["/api/v1/automation-identities/{id}/revoke"] = {
    post: {
      summary: "Operator: revoke all credentials for an automation identity",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", additionalProperties: false },
          },
        },
      },
      responses: {
        200: { description: "Revoked" },
        403: { description: "Operator required" },
        404: { description: "Identity missing" },
      },
    },
  };
  paths["/api/v1/goals/{id}/evidence"] = {
    get: {
      summary: "Read bounded evidence for an authorized goal",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "after", in: "query", schema: { type: "string" } },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        },
      ],
      responses: {
        200: {
          description: "Evidence ordered by ID; use final ID as next cursor",
        },
        403: { description: "Outside identity scope" },
      },
    },
  };
  paths["/api/v1/usage/unresolved"] = {
    get: {
      summary: "Operator: inspect unresolved attempt reservations",
      responses: {
        200: { description: "Closed and active unresolved reservations" },
        403: { description: "Operator authority required" },
      },
    },
  };
  paths["/api/v1/attempts/{id}/usage-reconciliation"] = {
    post: {
      summary:
        "Operator: reconcile closed metered usage from registered evidence",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/UsageReconciliation" },
          },
        },
      },
      responses: {
        200: {
          description:
            "Immutable reconciliation recorded; original attempt retained",
        },
        403: { description: "Operator authority required" },
        409: {
          description:
            "Active attempt, missing evidence, or conflicting reconciliation",
        },
      },
    },
  };
  for (const path of [
    "/goals",
    "/goals/{id}",
    "/goals/{id}/tasks",
    "/goals/{id}/attempts",
    "/goals/{id}/plan",
    "/goals/{id}/state",
    "/goals/{id}/backend",
    "/goals/{id}/policy",
    "/claims",
    "/tasks/{id}",
    "/tasks/{id}/heartbeat",
    "/tasks/{id}/transition",
    "/tasks/{id}/checkpoint",
    "/tasks/{id}/question",
    "/tasks/{id}/release",
    "/tasks/{id}/result",
    "/tasks/{id}/finding",
    "/questions",
    "/questions/{id}/answer",
    "/events",
    "/workers",
    "/memory",
    "/tokens",
    "/schedules",
  ]) {
    const reads = [
      "/goals",
      "/goals/{id}",
      "/goals/{id}/tasks",
      "/goals/{id}/attempts",
      "/goals/{id}/policy",
      "/tasks/{id}",
      "/questions",
      "/events",
      "/workers",
      "/memory",
    ];
    paths[`/api/v1${path}`] = {
      [reads.includes(path) ? "get" : "post"]: {
        responses: {
          200: { description: "Successful operation" },
          400: { description: "Invalid input" },
          409: { description: "Revision or lease conflict" },
        },
      },
    };
  }
  for (const [path, schema] of [["projects", "Project"]]) {
    paths[`/api/v1/${path}`] = {
      get: { responses: { 200: { description: "Operator configuration" } } },
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${schema}` },
            },
          },
        },
        responses: {
          200: { description: "Configuration saved" },
          403: { description: "Operator authority required" },
        },
      },
    };
  }
  paths["/api/v1/goals/{id}/backend"] = {
    post: {
      summary: "Switch a paused, drained goal backend",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/BackendSwitch" },
          },
        },
      },
      responses: {
        200: { description: "Backend changed; goal remains paused" },
        400: { description: "Invalid input or missing authorized budget" },
        403: { description: "Operator authority required" },
        409: {
          description:
            "Stale revision, active work, unpaused goal or unreconciled tool",
        },
      },
    },
  };
  paths["/api/v1/execution-maintenance"] = {
    get: {
      summary: "Operator: preview verified temporary execution cleanup",
      responses: {
        200: { description: "Cleanup eligibility and retention reasons" },
        403: { description: "Operator authority required" },
        409: {
          description: "Isolated runtime unavailable or maintenance leased",
        },
      },
    },
    post: {
      summary:
        "Operator: preview or apply verified temporary execution cleanup",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { apply: { type: "boolean", default: false } },
            },
          },
        },
      },
      responses: {
        200: { description: "Eligibility report and removed session IDs" },
        403: { description: "Operator authority required" },
        409: {
          description: "Runtime unavailable, active work or lease conflict",
        },
      },
    },
  };
  paths["/api/v1/storage-policy"] = {
    get: {
      summary: "Operator: inspect hourly storage maintenance mode",
      responses: { 200: { description: "Current mode" } },
    },
    post: {
      summary: "Operator: configure progressive hourly cleanup",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["mode"],
              properties: {
                mode: {
                  type: "string",
                  enum: ["preview", "workspaces", "branches"],
                },
              },
            },
          },
        },
      },
      responses: {
        200: { description: "Recorded maintenance policy" },
        403: { description: "Operator required" },
      },
    },
  };
  paths["/api/v1/operations"] = {
    get: {
      summary:
        "Operator: inspect requested and executing infrastructure operations",
      responses: {
        200: { description: "Durable operation requests" },
        403: { description: "Operator required" },
      },
    },
  };
  paths["/api/v1/operations/{id}"] = {
    post: {
      summary: "Record owner intent or reconciled result",
      responses: {
        200: { description: "Response recorded" },
        403: { description: "Operator required" },
        409: { description: "Already completed" },
      },
    },
  };
  paths["/api/v1/tasks/{id}/operation"] = {
    post: {
      summary: "Leased worker requests owner operation after checkpoint",
      responses: {
        200: {
          description: "Affected task checkpointed and resources released",
        },
        409: { description: "Stale lease or missing checkpoint" },
      },
    },
  };
  const operation = (summary: string, schema?: Record<string, unknown>) => ({
    summary,
    ...(schema
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema } },
          },
        }
      : {}),
    responses: {
      200: { description: "Successful durable operation" },
      400: { description: "Invalid input" },
      401: { description: "Authentication required" },
      403: { description: "Insufficient scope, trust or browser CSRF" },
      409: { description: "Revision, configuration or ownership conflict" },
    },
  });
  const objectSchema = (
    properties: Record<string, unknown>,
    required: string[],
  ) => ({ type: "object", additionalProperties: false, properties, required });
  paths["/api/v1/dashboard"] = {
    get: operation("Operator: goals, tasks, decisions and execution health"),
  };
  paths["/api/v1/artifacts/{id}/content"] = {
    get: operation(
      "Operator: bounded download of an instance-relative recorded artifact; rejects redirected paths",
    ),
  };
  paths["/api/v1/goal-drafts"] = {
    post: operation(
      "Validate a draft against applied project authority",
      objectSchema(
        {
          projectId: { type: "string" },
          description: { type: "string", minLength: 1, maxLength: 100000 },
        },
        ["projectId", "description"],
      ),
    ),
  };
  paths["/api/v1/configuration"] = {
    post: operation(
      "Explicitly apply a validated external configuration revision",
      objectSchema({ hash: { type: "string", pattern: "^[a-f0-9]{64}$" } }, [
        "hash",
      ]),
    ),
  };
  paths["/api/v1/backups"] = {
    post: operation(
      "Operator: encrypted online SQLite and identity backup",
      objectSchema(
        {
          destination: { type: "string" },
          recipientFile: { type: "string" },
          complete: { type: "boolean", default: false },
        },
        ["destination", "recipientFile"],
      ),
    ),
  };
  paths["/api/v1/session"] = {
    post: operation(
      "Exchange the private operator bearer for a browser session; returns csrf and expiry",
      objectSchema({}, []),
    ),
  };
  paths["/api/v1/session/logout"] = {
    post: operation("Revoke the current browser session", objectSchema({}, [])),
  };
  paths["/api/v1/storage"] = {
    get: operation("Operator: storage pressure and cleanup preview"),
  };
  paths["/api/v1/schedules"] = {
    get: operation("Operator: applied schedules"),
    post: operation(
      "External schedules are configured and explicitly applied; production rejects inline templates",
      { $ref: "#/components/schemas/Schedule" },
    ),
  };
  paths["/api/v1/human/commands"] = {
    post: operation(
      "Scoped connector: trusted event intake, atomic domain effect and destination acknowledgment",
      objectSchema(
        {
          principal: {
            type: "object",
            additionalProperties: false,
            required: ["externalIdentity", "destination", "trust"],
            properties: {
              externalIdentity: { type: "string" },
              destination: { type: "string" },
              trust: {
                type: "object",
                additionalProperties: false,
                required: ["encrypted", "verifiedDevice", "allowedMembership"],
                properties: {
                  encrypted: { type: "boolean" },
                  verifiedDevice: { type: "boolean" },
                  allowedMembership: { type: "boolean" },
                  deviceId: { type: "string" },
                },
              },
            },
          },
          command: { $ref: "#/components/schemas/HumanCommand" },
        },
        ["principal", "command"],
      ),
    ),
  };
  paths["/api/v1/human/transport-state"] = {
    get: operation("Scoped connector: durable polling cursor"),
    post: operation(
      "Scoped connector: advance cursor after staging intake",
      objectSchema({ offset: { type: "integer", minimum: 0 } }, ["offset"]),
    ),
  };
  paths["/api/v1/human/health"] = {
    post: operation(
      "Scoped connector: bounded redacted health observation; grants no trust or authority",
      objectSchema(
        {
          state: { enum: ["starting", "healthy", "degraded", "stopped"] },
          fault: {
            enum: [
              "transport",
              "controller",
              "auth",
              "trust",
              "replay",
              "undecryptable",
              "delivery",
            ],
          },
          lastSyncAt: { type: "integer", minimum: 0 },
          pendingInbox: { type: "integer", minimum: 0, maximum: 10000 },
          exhaustedInbox: { type: "integer", minimum: 0, maximum: 10000 },
          historyRecovery: { type: "boolean" },
        },
        ["state"],
      ),
    ),
  };
  paths["/api/v1/connectors"] = {
    get: operation(
      "Operator: applied connector health, stale observations and destination backlog",
    ),
  };
  paths["/api/v1/connector-auth"] = {
    post: operation(
      "Operator: write a scoped connector credential into its private file",
      objectSchema({ id: { type: "string" } }, ["id"]),
    ),
  };
  paths["/api/v1/connector-deliveries"] = {
    get: operation(
      "Scoped connector: only this connector's pending destination snapshots",
    ),
  };
  paths["/api/v1/connector-deliveries/{id}"] = {
    post: operation(
      "Scoped connector: record transport receipt or bounded retry",
      {
        oneOf: [
          objectSchema(
            {
              status: { const: "sent" },
              receipt: { type: "string", maxLength: 1000 },
            },
            ["status", "receipt"],
          ),
          objectSchema({ status: { const: "retry" } }, ["status"]),
        ],
      },
    ),
  };
  paths["/api/v1/goals"].post = {
    responses: {
      200: { description: "Goal durably created" },
      400: { description: "Invalid input or missing idempotency key" },
      403: { description: "Outside identity/project authority" },
      409: { description: "Idempotency conflict" },
    },
  };
  paths["/api/v1/goals"].post.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          oneOf: [
            {
              type: "object",
              required: ["projectId", "description"],
              properties: {
                projectId: { type: "string" },
                description: {
                  type: "string",
                  minLength: 1,
                  maxLength: 100000,
                },
              },
              additionalProperties: false,
            },
            { $ref: "#/components/schemas/GoalInput" },
          ],
        },
      },
    },
  };
  paths["/api/v1/goals"].post.parameters = [
    {
      name: "Idempotency-Key",
      in: "header",
      description:
        "Required for automation creation; reuse unchanged key after ambiguous response",
      schema: { type: "string", minLength: 1, maxLength: 200 },
    },
  ];
  paths["/api/v1/goals/{id}/state"].post.parameters = [
    ...(paths["/api/v1/goals/{id}/state"].post.parameters ?? []),
    {
      name: "Idempotency-Key",
      in: "header",
      description: "Required for automation state mutations",
      schema: { type: "string", minLength: 1, maxLength: 200 },
    },
  ];
  paths["/api/v1/claims"].post.summary =
    "Controller-approved registered dispatch only; arbitrary remote workers are unsupported";
  paths["/api/v1/claims"].post.responses[409] = {
    description: "No approved controller dispatch/environment",
  };
  return {
    openapi: "3.1.0",
    info: { title: "MissionControl control plane", version: "1.0.0" },
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas,
    },
  };
}
