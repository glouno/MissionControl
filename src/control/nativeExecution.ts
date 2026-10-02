import { spawn } from "node:child_process";
import type { NativeExecution } from "./backend.js";
import type { ExecutionSession } from "./environments.js";
import { ControlError } from "./schema.js";
// This controller-side transport gives native harnesses only container stdio.
// No host environment, cwd, provider credentials or control tokens are forwarded.
export function dockerNativeExecution(
  session: ExecutionSession,
  assertLease: (taskId: string, generation: number) => void,
  launch: typeof spawn = spawn,
): NativeExecution {
  if (session.status !== "active" || !session.container)
    throw new ControlError(
      "environment_state",
      "Native harness requires active isolated execution",
      409,
    );
  return {
    workspace: "/workspace",
    spawn(command, args) {
      assertLease(session.taskId, session.generation);
      if (!["codex", "claude"].includes(command))
        throw new ControlError(
          "harness_command",
          "Sandbox harness must use its pinned image executable",
          409,
        );
      return launch(
        "docker",
        ["exec", "-i", session.container!, command, ...args],
        {
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          env: { PATH: process.env.PATH },
        },
      );
    },
  };
}
