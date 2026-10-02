import { z } from "zod";
import type { ControlStore } from "./store.js";
import { ControlError } from "./schema.js";
import { sql } from "../sqlite.js";

/** Reports are transport observations, never authority or device-trust proof. */
export const connectorHealthSchema = z
  .object({
    state: z.enum(["starting", "healthy", "degraded", "stopped"]),
    fault: z
      .enum([
        "transport",
        "controller",
        "auth",
        "trust",
        "replay",
        "undecryptable",
        "delivery",
      ])
      .optional(),
    lastSyncAt: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    pendingInbox: z.number().int().min(0).max(10000).optional(),
    exhaustedInbox: z.number().int().min(0).max(10000).optional(),
    historyRecovery: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === "healthy" && value.fault)
      ctx.addIssue({
        code: "custom",
        message: "Healthy reports cannot include a fault",
      });
  });
export type ConnectorHealthReport = z.input<typeof connectorHealthSchema>;
export interface ConnectorDescriptor {
  id: string;
  kind: "matrix" | "telegram";
  enabled: boolean;
}

export function recordConnectorHealth(
  store: ControlStore,
  id: string,
  input: unknown,
) {
  const value = connectorHealthSchema.parse(input),
    now = store.clock();
  if (value.lastSyncAt !== undefined && value.lastSyncAt > now + 300000)
    throw new ControlError(
      "connector_time",
      "Sync observation is in the future",
    );
  const old = store.setting(`connector-health:${id}`);
  if (
    value.lastSyncAt !== undefined &&
    old?.lastSyncAt !== undefined &&
    value.lastSyncAt < old.lastSyncAt
  )
    throw new ControlError(
      "connector_time",
      "Sync observation cannot move backwards",
      409,
    );
  store.setting(`connector-health:${id}`, {
    ...value,
    lastSyncAt: value.lastSyncAt ?? old?.lastSyncAt,
    reportedAt: now,
  });
  return { recorded: true };
}

export function connectorHealth(
  store: ControlStore,
  descriptors: ConnectorDescriptor[],
) {
  const now = store.clock();
  return descriptors.map((connector) => {
    const report = store.setting(`connector-health:${connector.id}`);
    const ageMs = report ? Math.max(0, now - report.reportedAt) : null;
    const stale = ageMs === null || ageMs > 90000;
    const deliveries = store.db.query<{
      status: string;
      count: number;
      oldest_due_at: number | null;
    }>(
      `SELECT status,count(*) AS count,MIN(due_at) AS oldest_due_at FROM connector_deliveries WHERE connector_id=${sql(connector.id)} GROUP BY status`,
    );
    return {
      ...connector,
      state: !connector.enabled
        ? "disabled"
        : stale
          ? "unavailable"
          : report.state,
      reported: report ?? null,
      reportAgeMs: ageMs,
      stale,
      syncAgeMs:
        report?.lastSyncAt === undefined
          ? null
          : Math.max(0, now - report.lastSyncAt),
      deliveries,
      liveQualified: false,
      action: !connector.enabled
        ? "Enable explicitly after private setup and qualification"
        : stale
          ? "Inspect connector service and scoped controller connection"
          : report.fault
            ? {
                transport:
                  "Inspect homeserver or Telegram reachability; pending work is retained",
                controller:
                  "Inspect scoped controller connection; commands may remain locally pending",
                auth: "Use private connector login or credential setup",
                trust:
                  "Inspect private membership/device verification and explicitly remediate trust",
                replay:
                  "Inspect retained history recovery cursor and restart bounded recovery",
                undecryptable:
                  "Inspect exhausted encrypted inbox entries; verify device keys before retry",
                delivery:
                  "Inspect pending destination deliveries; transport retries retain transaction IDs",
              }[report.fault as NonNullable<ConnectorHealthReport["fault"]>]
            : null,
    };
  });
}
