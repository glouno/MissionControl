import { z } from "zod";
import { HumanWait, OwnerWait } from "./backend.js";
import { ownerOperationSchema, questionSchema } from "./schema.js";
export const reviewOutputSchema = z.toJSONSchema(
  z
    .object({
      commit: z.string(),
      verdict: z.enum(["pass", "fail"]),
      findings: z.array(
        z
          .object({
            summary: z.string(),
            blocking: z.boolean(),
            evidence: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
  { target: "draft-7" },
);

// This describes requests only. No caller-supplied lease, endpoint or credentials
// can select a control-plane action; the trusted worker owns persistence.
export const workerResponseSchema = z
  .object({
    text: z.string(),
    question: questionSchema.nullable(),
    ownerOperation: ownerOperationSchema.nullable().optional(),
  })
  .strict();
export const handoffTools = [
  {
    type: "function" as const,
    name: "missioncontrol_question",
    description:
      "Pause this task for a durable human decision. Execution stops and validated source is checkpointed before the question is delivered. Do not continue working after this request.",
    inputSchema: z.toJSONSchema(questionSchema, {
      io: "input",
      target: "draft-7",
    }),
  },
  {
    type: "function" as const,
    name: "missioncontrol_owner_operation",
    description:
      "Pause this coding task to request a host or infrastructure action from the trusted owner. Supply a stable idempotencyKey. This does not execute the action or approve production changes. Resume only after an owner result.",
    inputSchema: z.toJSONSchema(ownerOperationSchema, { target: "draft-7" }),
  },
];
export function parseHandoff(tool: string, input: unknown) {
  if (tool === "missioncontrol_question")
    return new HumanWait(questionSchema.parse(input));
  if (tool === "missioncontrol_owner_operation")
    return new OwnerWait(ownerOperationSchema.parse(input));
  throw new Error("Unknown worker handoff tool");
}
export function responseHandoff(input: unknown, allowOwner: boolean) {
  const response = workerResponseSchema.parse(input);
  if (response.question && response.ownerOperation)
    throw new Error("Choose one worker handoff per invocation");
  if (response.ownerOperation && !allowOwner)
    throw new Error("Owner operations are available only during coding tasks");
  return {
    response,
    wait: response.ownerOperation
      ? new OwnerWait(response.ownerOperation)
      : response.question
        ? new HumanWait(response.question)
        : undefined,
  };
}
