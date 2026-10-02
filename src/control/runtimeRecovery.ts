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
  networks: Pick<GatewayNetworkManager, "records" | "reconcile">,
  revoke: (sessionId: string) => void,
) {
  store.fenceStartup();
  try {
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
        await environment.reset(session.id);
    }
    await networks.reconcile();
    store.finishStartupRecovery();
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
