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
