# Native runtime validation and remaining acceptance

The native route passed Linux live lifecycle acceptance with the selected existing
Codex subscription on 2026-10-23 after quota became available. It remains a preview
pending broader operational qualification and an operator-reviewed activation.
Source review and the candidate follow-up below are complete. No production activation, publication, merging, credential
copying or automatic login was performed.

## Evidence and limits

The baseline source was `3786cbf`; the baseline suite passed 466 tests. Installed
Codex 0.163.0 supports JSONL execution, output schemas, explicit session resumption
and selected profiles. The implementation preserves its normal configuration and
hook-trust behavior. [Official noninteractive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
describes the CLI integration; installed help was checked for actual flags.

A preceding prototype run reached implementation, trusted checks and fresh review
in a real repository worktree. Those two successful agent invocations reported
765,249 and 99,357 input tokens, and 4,361 and 1,083 output tokens. Their cached
input subsets were 722,176 and 78,080. No completed goal followed: integration and
later quota failures prevented full delivery. These are historical observations,
not acceptance receipts for the final source or evidence for a new usage cutoff.

The first resumed full-controller run used Docker unavailable to the test controller.
Preflight and declared setup succeeded; the selected subscription rejected the
first implementation invocation before tool activity. One agent invocation was
recorded with quota failure and unknown usage. The goal paused without automatic
replay. That historical quota receipt is retained.

After quota reset, five workflows completed: one real repository task, two ordinary
fixtures, a failed-check repair and a failed-review repair. The two repairs each
used one task, two attempts and the explicitly resumed implementation session;
each review used a fresh session. Two direct Codex comparisons passed their checks.
The controller's inspection results for a completed native goal matched through
CLI, HTTP and MCP. Normal-delivery sample size is three; repair sample size is two.

The initial restart harness incorrectly attempted startup over a stale same-boot
controller lock. The harness now verifies its crashed owner's PID and uses
`state recover-lock --nonce` before restarting. The corrected cancellation and
restart cases wait for a running sleep command, verified by JSONL and owned Linux
process identities. Both stopped all owned processes and settled the invocation
as interrupted with unavailable usage retained. After crash recovery the harness
pauses the goal for inspection before another attempt is admitted. This explicit
inspection step is part of the receipt.

The real repository workflow completed its admitted checks and review, but an
additional probe found that its private candidate still rewrites quoted sibling
paths such as `/repos/app:backup/file`. The feature branch now contains a separate
reviewed correction: literal path matching with quote-aware boundaries and one
translation pass. Regressions cover quoted punctuation, spaces, escaped quotes,
JSON context, overlapping admitted roots and replacement prefixes. The private
candidate remains retained as evidence; it was not merged. The original checkout
was not changed.

Source review also found two ownership gaps. Cleanup inspection errors occurred
before the bounded-cleanup wrapper and could mark an ambiguous writer as failed
or interrupted. All cleanup inspection failures now retain `cleanup_blocked`
ownership; a cancellation regression verifies that startup keeps the claim fenced.
Complete filesystem backup now refuses active or cleanup-blocked native
invocations alongside existing container writers. Backup/restore regressions
exercise both refusals and successful restoration after native ownership settles.

Automated native tests cover full candidate delivery, check/review repair within
one task, explicit session reuse, fresh review workspaces, malformed/duplicate
events, quota handling, prerequisite/scope failures, tracked/untracked mutations,
detached child cleanup, reused PIDs, retained startup/operation ownership, the
launch crash window, cleanup allowances, private output rotation and historical
binding compatibility. The synthetic installed workflow exercises equivalent
CLI/API/MCP inspection. Component tests do not replace the outstanding live cases.

The implementation suite before this source review passed 486 tests, including 20 native behavioral tests.
Typecheck, Python status, privacy and package checks passed. The required audit
identified GHSA-rxp7-6hxx-x8q5 in transitive `ip-address` 10.7.2; the lockfile now
selects 10.7.4 and the production dependency audit reports zero vulnerabilities.
Linux history and Rust Matrix checks also passed. These deterministic results
remain separate from the live provider receipts and their source follow-up.

Migration rehearsal copied the installed v1 database through a read-only SQLite
backup connection. Schema 8 advanced to schema 9. All 856 rows inspected across
historical goals, tasks, attempts, evidence, budgets and execution registries had
identical before/after hashes. The legacy dashboard database was separately
identified as pre-v1 and refused by the new controller; it was not migrated.

Current-source Docker portable-execution acceptance passed with synthetic inference:
isolated tools, traversal/private-network denial, stopped scoped import and
independent checks. Gateway and active-container crash recovery acceptance also
passed using the reviewed immutable worker image. Browser acceptance passed 19
checks at a 390 by 844 viewport, including six views, authenticated evidence,
decision flows, pause/resume/cancel and mobile layout. These browser checks use a
synthetic controller. Live container providers, macOS and optional
connector/provider coverage require their own existing valid identities and
qualification; unavailable coverage must remain a documented gap.

## Reproduce live acceptance

From the reviewed built checkout, use a new private output root and the selected
existing subscription. Replace paths/model with the already tested profile:

```sh
node scripts/native-acceptance.mjs \
  --output-root /private/new-native-acceptance \
  --codex /usr/local/bin/codex \
  --codex-home /home/worker/.codex \
  --model your-selected-model
```

The script creates disposable repositories and a controller with its own state,
configuration, token and unused port. Docker is unavailable to that controller.
It records ordinary delivery, failed check/repair, review finding/repair, explicit
session continuation, cancellation, restart and a prerequisite failure. The
ordinary fixture includes a direct Codex comparison with the same base/model and
checks; it explicitly reports the additional MissionControl prompts and review
work. Quota stops the sequential campaign with an acceptance gap, preserving
unknown measurements and the selected login.

Use `--cases ordinary,cancellation,restart` to rerun selected scenarios in a fresh
output root. Available names are `ordinary`, `check-repair`, `review-repair`,
`cancellation` and `restart`; `real` additionally requires the real repository
flags below. Lifecycle checks establish an actual owned running command before
interruption, use the supported stale-lock recovery command and verify all owned
processes are absent afterward.

To include ordinary work in a real repository worktree, also supply
`--real-repo`, `--real-branch`, `--real-check`, `--real-envelope` and optionally
`--real-setup`. The envelope uses project ID `real` and the reviewed-goal shape
documented in [native execution](native-execution.md). The repository/target branch
is explicit; publication and auto-merge stay disabled. The script refuses to reuse
an existing output root and never edits the input checkout.

The resulting private `summary.json`, per-case experiment JSON, prerequisite
result, direct comparison and raw invocation files establish sample sizes,
outcomes, usages, durations, findings and interventions. Report unavailable
measurements as null. Do not infer hidden model-request counts from invocations,
add cached tokens to input, or assign subscription dollar costs. Collect several
successful ordinary runs before proposing evidence-based performance limits.
