# Context, output and runtime preparation

`contextMaxCharacters` is a configurable instruction/contract injection safeguard,
not the model's context window. Its default is 256,000 characters, bounded to one
MiB. Authority documents are never silently truncated. Goal draft, direct goal and backlog launch validation use
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

## Admit a reviewed plan atomically

For an operator-defined task, `POST /api/v1/reviewed-goals` accepts
`{"goal": <ordinary goal admission input>, "plan": {"tasks": [...]}}`.
Use an `Idempotency-Key` for safe response-loss replay. The endpoint requires
operator authority, runs the ordinary configuration and instruction preflight,
and validates task paths, verification commands, resources and dependencies.
Goal creation, budget admission and plan installation commit together. An invalid
plan leaves no goal, task, job, event or admission charge behind. The scheduler
observes the installed plan and skips native planning; independent worker
verification, review and integration remain unchanged.

This removes the scheduling-delay race of creating a goal and installing its plan
in a second request. It also avoids spending a native planner invocation on a
fully specified task. It does not recover a refused or output-exhausted existing
goal, refund previous admissions, change output limits or certify free-form native
planning. Retained failures still require their normal inspected recovery path.

## Planning limits and slow inference

Planning and replanning inherit the goal's admitted `timeoutMs` by default. There
is no additional two-minute deadline and no separate 8,192-token native planning
cap. The provider/session output limit still applies, including reasoning where
the provider counts it. Reaching that limit can truncate output; it does not
reserve tokens for a final JSON plan. Structured output and validation prevent
partial plans from being installed, but cannot guarantee successful generation.

An operator may configure `planning: { timeoutMs: 600000, maxRequests: 12 }` on a
project. The optional timeout only shortens the admitted execution allowance.
Planning defaults to 40 native gateway attempts or portable model turns. Native
gateway attempts include retries and locally refused attempts, and their counter
persists across restart. Portable provider retries remain separately bounded.
Native subscriptions enforce the deadline and their invocation policy, but do
not expose the paid gateway request fence. Ordinary coding/review, cancellation,
no-progress policy, dollar reservations and installation admission remain active.

Inspect retained source, diagnostics and unresolved usage after exhaustion.
Use `goal reviewed` with an operator-reviewed fixed plan, or explicitly authorize
a revised admission. Never replay uncertain requests or refund historical holds
merely because a limit changed. Removing all deadlines would leave stalled HTTP,
tools and cleanup without a final bound; tokens alone cannot detect those stalls.

## Inspect effective limits before launch

`POST /api/v1/goal-drafts` returns `executionLimits` alongside the validated
configuration and context budget. The dashboard shows these limits on project,
backlog launch, validated draft and goal detail views. They include harness,
output cap (when established), planning allowance, execution/no-progress timeouts,
workers, attempts, replans, run reservations and publication permissions. Global
admission and paid-concurrency limits are shown separately from actual usage.
Task details show CPU, memory, paths and verification commands. Readiness and the
limit projection do not grant execution; the server rechecks admission on launch.

## Conversations and caching

Native paid Codex starts a new ephemeral app-server thread per invocation (plan,
coding attempt, review), rather than one durable thread per mission. Claude uses
no session persistence. The portable loop keeps messages within an invocation and
can resume controller checkpoints; its simple summary truncation is not native
Codex compaction. Independent review deliberately starts with separate state.

Provider prompt caching is distinct from conversation history. Fresh threads can
reuse identical prompt prefixes where the provider supports it; a thread ID is
not proof of a cache hit. The native Responses gateway accounts for reported cached
input using configured prices. Vertex accounts for reported cached input as well.
MissionControl does not currently create explicit Vertex cache resources or
optimize cache breakpoints/keys. Portable Azure/Bedrock pricing does not yet fully
model provider cache read/write charges. Do not present those paths as precise
invoice accounting. Stable reusable instructions, measured cache counters and
native coding-session continuation need evaluation before widening session reuse.

Native Codex planning accepts a complete, validated JSON plan from the final
agent-message stream before a provider terminal event. Some Responses deployments
continue emitting whitespace after the closing JSON until the output allowance
is exhausted. The controller stops that native invocation and revokes its gateway
stream once the plan validates; independent source-mutation checks and plan
admission still run. Partial JSON, invalid dependencies and commentary cannot
complete planning. Missing terminal provider usage retains unknown accounting
and reservation holds. This behavior applies to planning only, not coding or review.
Planner descriptions and acceptance criteria are bounded implementation briefs;
workers still have their admitted execution/context allowances.
