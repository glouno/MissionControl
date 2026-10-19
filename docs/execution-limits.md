# Context, output and runtime preparation

`contextMaxCharacters` is a configurable instruction/contract injection safeguard,
not the model's context window. Its default is 256,000 characters, bounded to one
MiB. Authority documents are never silently truncated. Goal draft validation uses
the same instruction assembly as execution and returns `contextBudget`, including
per-file characters and injected status. Final prompt tools, goal descriptions and
private context also occupy model context; this report is not an exact tokenizer.

Sibling contract `files` define the pinned read-only snapshot. Optional
`injectedFiles` selects which of those files enter the prompt; omitted means all.
Full snapshots stay available under `/contracts`. Keep a concise authority/integration
summary injected and read detailed schemas and fixtures on demand. The snapshot
transport one-MiB byte limit remains separate from the injection budget.

Codex `backend.maxOutputTokens` can specify a request allowance. Default session
allowance is 65,536; the trusted isolated Responses deployment defaults to the legacy
32,768 until the operator selects a supported larger value. The effective allowance
is the smaller of session and deployment limits. Configuration accepts up to 131,072;
operators must stay within the exact model/deployment maximum (GPT-6.1 Sol's published
maximum is 128,000). Azure portable backend allows larger configured outputs too.
The output allowance includes reasoning and visible output. It is not a promise
of concise planning; planner instructions also limit investigation and task output.

`runtimeInstructions` records operator-admitted tool mapping, package resources and
scratch guidance. Every isolated phase sees required commands and this mapping.
Prebuilt offline images must not be instructed to reinstall dependencies or assume
sibling checkouts. Disposable fixture databases may use stable pytest basetemp;
controller evidence and application data must remain intact.

The native gateway preserves usage on incomplete responses when present. Trusted
Responses deployments may pin `pricing` with input, cached-input and output rates
per million tokens and an evidence URL. Session cost is estimated from provider
request counters, never native narrative or invoice claims. Missing requests/counters
retain unknown billing. Aggregate estimates settle reservation holds only when all
session requests have usage and prices. Actual invoice reconciliation remains an
explicit evidence-backed operation.

Dollar ceilings are emergency authority. Request counts/retries, phase timeout and
progress tracking still bound loops. Increasing money alone cannot repair source
correctness. Old failed admissions and unknown usage are preserved.

`budgetAlertUsd` raises a dashboard warning and one durable BUDGET_ALERT event
when settled reported/estimated charges reach the threshold. Holds do not trigger
that charge alert; they remain visible separately. The alert does not stop execution.
Backlog snapshots expose `currentGoalId`/`currentGoalStatus` across replacements while
preserving the original launch link.
