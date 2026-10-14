import { boundedCleanup } from "./reliability.js";
import type { ControlStore } from "./store.js";
import type {
  ExecutionEnvironment,
  EnvironmentRegistry,
} from "./environments.js";
import type { GatewayNetworkManager } from "./gatewayNetwork.js";

/** Caller holds the exclusive instance lock; scheduling has not started. */
export async function reconcileRuntime(
  store: ControlStore,
  registry: EnvironmentRegistry,
  environment: ExecutionEnvironment,
  networks: Pick<GatewayNetworkManager, "records" | "reconcile"> &
    Partial<Pick<GatewayNetworkManager, "inspectAbsent">>,
  revoke: (sessionId: string) => void,
) {
  store.fenceStartup();
  const prior = store.setting("startup-cleanup");
  const attempts = store.db
    .query<{ record: string }>(
      "SELECT r.record FROM attempt_runtime r JOIN control_attempts a ON a.id=r.attempt_id WHERE a.outcome='recovering'",
    )
    .map((r) => JSON.parse(r.record));
  const intent = prior ?? {
    version: 1,
    startedAt: store.clock(),
    deadlineAt: Math.min(
      store.clock() + 60000,
      ...attempts.map((r) => r.cleanupDeadlineAt ?? Infinity),
    ),
  };
  store.setting("startup-cleanup", intent);
  const remaining = intent.deadlineAt - store.clock();
  const cleanup =
    remaining > 0
      ? AbortSignal.timeout(remaining)
      : AbortSignal.abort(
          new Error("Original startup cleanup deadline expired"),
        );
  try {
    if (remaining <= 0) {
      // Never replenish destructive cleanup authority. A later startup may
      // inspect absence under its exclusive lock after an operator/daemon repair.
      await boundedCleanup(async (signal) => {
        for (const record of networks.records()) revoke(record.sessionId);
        for (const session of registry.all()) {
          revoke(session.id);
          const inspected = await environment.inspect(session.id, signal);
          if (inspected.container)
            throw Error(
              "Retained execution resource requires operator cleanup",
            );
        }
        if (networks.records().length && !networks.inspectAbsent)
          throw Error("Gateway absence inspection unavailable");
        await networks.inspectAbsent?.(signal);
      }, 30000);
      store.setting("startup-cleanup-inspection", {
        originalIntent: intent,
        inspectedAt: store.now(),
        outcome: "owned-resources-absent",
      });
      store.finishStartupRecovery();
      store.setting("startup-cleanup", null);
      return;
    }
    await boundedCleanup(
      async (signal) => {
        for (const record of networks.records()) revoke(record.sessionId);
        for (const session of registry.all()) {
          revoke(session.id);
          if (session.status === "destroyed" && session.container)
            throw Error(
              "Destroyed execution still records a resource; explicit ownership inspection required",
            );
          if (
            session.container ||
            !["destroyed", "destroying"].includes(session.status)
          )
            await environment.reset(session.id, signal);
        }
        await networks.reconcile(signal);
      },
      60000,
      cleanup,
    );
    store.finishStartupRecovery();
    store.setting("startup-cleanup", null);
  } catch (error) {
    // Raw Docker/path diagnostics stay out of application evidence.
    store.setting("startup-recovery-fault", {
      status: "blocked",
      reason:
        "Resource reconciliation failed; inspect owned resources before restarting",
      recordedAt: store.now(),
    });
    throw error;
  }
}
