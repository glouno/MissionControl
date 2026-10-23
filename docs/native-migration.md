# Native runtime migration and rollback

This procedure is prepared for a future operator-reviewed activation. Source
implementation and copied-state rehearsal do not activate a running installation.
Review the completed Linux [live acceptance](native-runtime-validation.md), the
source review corrections and installation-specific recovery evidence first.

## Prepare and rehearse

1. Preserve the installed release, external configuration, existing admissions,
credentials and service definitions. Record their revisions and paths. Keep
   dashboard routes and unrelated services intact; use separate unused ports for
   rehearsal. Never reuse a reserved dashboard port or replace its Serve route.
2. Build/test the reviewed source in a separate worktree. Run
   `python3 scripts/verify.py --logs /private/new-verification`. Run applicable
   container qualification against the existing reviewed immutable image.
3. Create a consistent database copy using a read-only SQLite backup connection.
   Use the existing [complete encrypted application backup](backups.md) when
   rehearsing workspace restoration. External configuration and the selected
   devbox Codex home have separate owners and must remain separately recoverable.
   Do not copy a login into a new Codex home as part of native setup.
4. Open only the copied database with the new controller schema. Migration 9 adds
   `agent_invocations`; it does not rewrite historical goal configuration,
   admissions, attempts, ownership or evidence. Compare row counts and hashes for
   historical tables before and after. The original database stays read-only.
5. Prepare a new isolated test installation with explicit state, secrets and
   configuration roots. Point selected native profiles at the tested executable,
   existing login and tool PATH. Run the live acceptance script with Docker
   unavailable to that test controller. Preserve JSON records and private traces.

## Activate after review

Drain/checkpoint old active work through its installed controller. Retained or
ambiguous workers must remain fenced. Use the installed controller's supported
service lifecycle to stop that controller; do not stop unrelated dashboard
services. Take and verify the final consistent recovery snapshot while preserving
unknown usage and incomplete candidates.

Install the reviewed executable separately, without enabling it. Prepare native
host profiles and selected idle projects in external configuration, then run
`config validate` and `config apply --offline` with the new executable and the
intended configuration directory. Confirm explicit repository/target branches,
checks, prerequisites, model, permissions and service tool PATH. Existing container
projects keep `executionMode: "isolated"`, their images, dedicated authentication,
gateway/network policies and qualification requirements.

Use the new executable's supported service installation/lifecycle commands to
prepare and start only its controller. Native startup inspection stops surviving
owned execution and keeps ambiguous outcomes blocked. Docker-specific readiness
faults do not authorize host fallback or discard retained container ownership.
Inspect `doctor`, project preflight, goal invocation history, metrics and recovery
records before admitting a new task. Run several ordinary tasks through trusted
checks and fresh review before promoting native execution as a default.

## Roll back

Pause/drain the new controller and prove its owned native processes and containers
have stopped. Preserve new candidate artifacts and measurements before stopping
its service. Schema 9 is additive but the older executable may reject it: never
point the old executable at a migrated database, edit `user_version`, or delete
new tables to simulate a downgrade. A live read-only SQLite copy proves database
restoration and migration only; it cannot replace the final quiescent complete
application snapshot, including workspaces, Git caches and candidate evidence.

Restore the verified pre-upgrade application snapshot into a new isolated path,
retain the newer state privately, and restore the matching old external
configuration/release/service definitions through supported operations. Keep the
newer instance stopped when activating the restored identity. Re-run inspection
and a synthetic workflow before admitting real work. Work completed after the
snapshot remains in retained candidates for explicit reconciliation; it is not
silently replayed or refunded.
