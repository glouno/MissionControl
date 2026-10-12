# Execution reliability

Attempt runtime deadlines are durable. Task implementation starts at claim admission;
heartbeats cannot renew its deadline. Result processing shares one envelope of
`max(30 seconds, 3 × timeoutMs)` for checks, review, integration and repair.
Owned cleanup has a separate shared 60-second allowance. Failure to prove that
resources stopped retains ownership and unknown usage. Shutdown is bounded to
90 seconds; the next start reconciles the same fenced ownership.
Cleanup start and deadline are persisted before teardown. Restart uses the original
remaining allowance; expiry blocks cleanup without invoking resource mutations.
Stopped controller inference resources can be reconciled without restarting;
ambiguous effects still require an explicit inspection before resume.

Provider diagnostics record request boundaries, serving provider/model, sanitized
endpoint, HTTP status, provider code, request IDs, elapsed time and execution IDs.
Arbitrary provider prose, prompts and response bodies are excluded. Policy refusals,
authentication, quota and invalid deployments/requests block unchanged inference.
Only explicit rejected transient HTTP outcomes receive at most three internal
retries, with persisted exponential backoff; uncertain streams and result
submissions are inspected before recovery.

Heartbeat and meaningful progress are separate. Model output, completed tools,
validated checkpoints and phase transitions advance progress. Project defaults
warn after ten minutes and fence stalled work after fifteen minutes, capped by
its phase deadline. Explicit project policy can adjust these thresholds.

The authenticated API exposes `/api/v1/readiness`, `/api/v1/incidents` and
`/api/v1/inference-diagnostics`. Diagnostic reads use bounded cursor pagination.
`/healthz` remains liveness. Recovery preview and revision-checked actions are
available at `/api/v1/goals/{id}/recovery`, the recovery CLI and MCP tools.
Deterministic task/configuration blockers require a new admitted replacement.
Replacement lineage retains its original family ceiling and unresolved holds;
installation cumulative admission does not refund predecessor authority.

Generated checks must belong to configured required commands or the explicit
`trustedAdditionalVerificationCommands` allowlist. Mandatory repository checks
always run. Mutating verification commands and traversal scopes are rejected.
Plans cannot widen admitted repository paths or require resources beyond configured
host capacity. Workers return candidates after implementation and checks; the
controller owns separate independent review and integration.

`mission-control support preview GOAL --attempt-id ATTEMPT` previews metadata.
Export requires --attempt-id, --destination, --manifest-sha256 from the reviewed
preview, and --reviewed true. Preview expiry is ten minutes; export returns exactly
that sanitized snapshot. The
bundle excludes checkpoints, prompt/model output and raw error responses. Reviewed
excerpts are optional, bounded and redacted. Saving uses a new file with mode 0600
in a canonical private directory outside Git. Uploading is a separate operation.
Private metadata logs rotate at 10 MiB with five retained files; database evidence
follows existing retention policy.

Schema 8 adds reliability records without rewriting historical admitted source or
usage. Schema 7 code refuses schema 8 state. Rollback uses a retained schema 8-compatible
release or an isolated encrypted restore; never downgrade a live database.
Changed release support requires ordinary installed acceptance and the private
24-hour failure-injection soak. Unit tests do not establish Azure, subscription,
macOS or device qualification.
