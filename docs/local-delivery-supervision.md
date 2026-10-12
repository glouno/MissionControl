# Local compute and durable delivery supervision

GitHub-hosted Actions are not required for continuous integration. An owned local
verifier runs the repository's required `verification.json` against exact archived
source/dependency commits. GitHub may display the resulting commit status. Coding
workers never receive the status-writer credential or the host Docker socket.

Publication now requires verified head/base evidence for draft PRs as well as
automatic merging. Every configured required check must pass; missing, cancelled,
failed and stale results cannot complete publication. Existing strict branch
protection checks continue to apply to automatic merges. Durable publish jobs
resume after restart. The first changed failure is stored as a candidate/base-bound
incident, finding, event and supervisor notification; identical polls are quiet.
A failed external check remains blocked, rather than consuming coding attempts.

The operator can POST `/api/v1/goals/{id}/observations` with candidateSha, optional
taskId, summary, evidence and blocking. This appends context without impersonating
a worker lease or rewriting admitted scope. GET on the same path returns durable
observations. Workers and independent reviewers receive them. Unresolved blocking
observations prevent advancing source or completing local publication. A reviewer
may list `resolvedObservations`; closing requires passing tests and review on the
same source/generation and an explicit reviewer acknowledgment. The operator close
endpoint enforces that same evidence requirement.

This patch does not claim that an arbitrary Git push is intrinsically intercepted:
GitHub branch protection and the owned integration command must guard operator
integration. Never turn a worker-authored JSON document into trusted CI evidence.
Native Mac/device and selected personal-use gates remain distinct.

Local nonpublishing goals with required checks now require an installation-owned
`localDeliveryVerifier`. Its absolute executable and script, pinned script SHA256,
private catalog and receipt-state paths cannot be chosen by a task. The bridge
validates the same signed source/base/contract evidence as the owned PR lane;
missing evidence queues work with that supervisor and leaves completion pending.
Failed receipts report `checks_failed`. Source and target are rechecked after
verification. The bridge definition is part of the runtime hash, so changing it
requires stopped-instance activation. No remote Mac commands are involved.

Automatic Actions push/PR triggers are removed. The retained optional manual
workflow calls `python3 -B scripts/verify.py --lane linux --logs /private/path`
(the owned local command) with the complete former core/status/privacy/package,
dependency audit, history audit and locked Matrix Rust suites. The Mac lane uses
`--lane macos` and is run by the owner's Mac agent. Install locked dependencies
with `npm ci --ignore-scripts` first. Node 24.21.0 and Rust 1.96.0 are explicit.
A failing history audit is a real unresolved gate; it is not waived or hidden.
The script records source, lane, check failures and logs outside the checkout;
it is a check entry point, not a substitute for signed verifier/reviewer authority.
