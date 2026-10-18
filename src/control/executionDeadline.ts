import { AsyncLocalStorage } from "node:async_hooks";
import { deadlineSignal } from "./reliability.js";
const scope = new AsyncLocalStorage<{
  signal: AbortSignal;
  deadlineAt: number;
}>();
export function executionSignal() {
  return scope.getStore()?.signal;
}
/** Controller-owned operation envelope; nested Git operations share the same deadline. */
export function withExecutionDeadline<T>(
  deadlineAt: number,
  parent: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const signal = deadlineSignal(deadlineAt, parent);
  signal.throwIfAborted();
  return scope.run({ signal, deadlineAt }, run);
}

export function executionDeadline() {
  return scope.getStore()?.deadlineAt;
}
