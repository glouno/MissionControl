import type { Usage } from "./usage.js";
import type { ModelMessage, ToolCall } from "./providers.js";
import type { Claim, QuestionInput, OwnerOperationInput } from "./schema.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
export interface NativeExecution {
  workspace: string;
  spawn(command: string, args: string[]): ChildProcessWithoutNullStreams;
}
export interface RunContext {
  claim: Claim;
  workspace: string;
  mode: "implement" | "review" | "plan";
  prompt: string;
  signal: AbortSignal;
  // Supplied only by the trusted execution controller, never by a goal payload.
  execution?: NativeExecution;
  operationReservationId?: string;
  outputSchema?: Record<string, unknown>;
  // Controller-reserved repair can edit source but cannot issue task handoffs.
  disableTaskHandoffs?: boolean;
  // Persist tool-loop intent without touching source while a container can write.
  onContinuation?: (
    summary: string,
    messages?: ModelMessage[],
    pendingTool?: ToolCall,
    costUsd?: number,
  ) => Promise<void>;
  onCheckpoint: (
    summary: string,
    messages?: ModelMessage[],
    pendingTool?: ToolCall,
    costUsd?: number,
  ) => Promise<void>;
}
export interface BackendResult {
  text: string;
  usage?: Usage;
  costUsd?: number;
  inputTokens: number;
  outputTokens: number;
  sessionId?: string;
  executionSessionId?: string;
  environmentDigest?: string;
  costStatus?: "reported" | "estimated_unknown";
}
export interface AgentBackend {
  run(context: RunContext): Promise<BackendResult>;
}
export class HumanWait extends Error {
  constructor(readonly request: QuestionInput) {
    super("Human input required");
  }
}
export class OwnerWait extends Error {
  constructor(readonly request: OwnerOperationInput) {
    super("Owner operation required");
  }
}
