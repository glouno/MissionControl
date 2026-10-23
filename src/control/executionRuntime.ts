import type { AgentBackend } from "./backend.js";
import type { Goal, Claim } from "./schema.js";
import type { VerificationResult } from "./isolatedVerifier.js";
/** The scheduler owns lifecycle; the selected runtime owns execution mechanics. */
export interface ExecutionRuntime {
  backend(goal: Goal): AgentBackend;
  verify(claim: Claim, source: string): Promise<VerificationResult>;
  recoverAttempt?(
    taskId: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void>;
  recoverOperation?(attemptId: string, signal: AbortSignal): Promise<void>;
}
