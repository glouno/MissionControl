# State ownership and recovery

The controller owns `mission-control.db` in its private state directory. Goals,
tasks, decisions, budgets and lifecycle registries share this application file.
Use its authenticated API for application operations. A missing state path is an
error on inspection; only explicit initialization creates a database.

Each instance has a private identity file and exclusive controller lock. SQLite
uses WAL, foreign keys, bounded lock waits and FULL synchronous commits. Fresh v1
state has a migration ledger. Pre-v1 and unsupported newer schemas are refused.
Retain older installations and evidence privately rather than importing them.

Matrix crypto/session stores belong to the Matrix process. Subscription session
stores belong to dedicated authentication environments. Neither is part of the
application database. A complete restore must account for these separate owners.

`backup create --destination /private/backups/instance.age --recipient-file
/private/recipient.txt` creates an encrypted online SQLite snapshot through the
controller API. This snapshot includes the database and identity, and is marked
incomplete for filesystem recovery.

With the controller stopped, add `--offline` for a complete application-state
snapshot under exclusive ownership. Symlinks and non-regular entries cause a
failure. A complete snapshot includes recovery evidence but excludes the
controller lock. Configuration, secrets, Matrix/subscription stores and homeserver
data have separate backup procedures.

`restore --input /private/backups/instance.age --identity-file /private/age.key
--destination /private/restored-state` decrypts into a new destination, verifies
the encrypted manifest and each file hash, then checks database integrity and
instance identity. It refuses overwriting existing state. Run a fake workflow in
the isolated restored installation before using it. Never overwrite a live
database to roll back code. Online complete snapshots and local isolated restoration are core preview checks.
Off-host recovery and connector-specific recovery need separate acceptance before
claiming a complete deployment recovery procedure.

After restoring to another destination, explicitly apply configuration while
stopped (`config apply --offline`). Startup refuses a snapshot whose state,
configuration or secret root belongs to another destination. Operational workspace
and repository records still need reviewed relocation/recovery before resuming
real unfinished work; restore acceptance is not complete until that passes.

Inspection checks schema/migration consistency, SQLite integrity/foreign keys and
the database's instance identity against its private identity file. Explicit
`state recover-lock --nonce NONCE` permits a dead owner on the same host; it
refuses living owners, foreign hosts and mismatched nonces. Inspect the private
lock file locally for its nonce. Never remove a live controller's lock.

Add `--complete` to an online backup to pause admissions/mutations and quiesce the
scheduler before the filesystem snapshot. Work still changing files after the
bounded drain timeout refuses the backup; pause/drain it and retry. The previous
admission policy resumes after success or failure. The manifest identifies all
separate stores that need their own consistent backups. This is not yet proof of
off-host restoration or safe relocation of unfinished operational workspaces.

Schema revision 4 stores owned repository, workspace, execution and recovery-intent
paths relative to their instance/registry root. Earlier private alpha databases
with absolute workspace records are refused rather than silently migrated into
another owner. Retain those alphas privately and initialize fresh candidate state.
Local projects use an application-owned bare object cache: worktrees never depend
on the user's checkout `.git`, and all required Git objects enter complete backups.

Complete restore verifies hashes before repairing only registered worktree
backlinks within the new destination. Worktree pointers themselves are relative;
Git 2.43 still requires absolute registry backlinks, so repair is explicit during
isolated restore. The repair validates the pointer, common object store and both
canonical paths before changing metadata. External project paths in admitted goals
remain explicit: relocation does not grant access to a substitute repository or
change goal authority. Restoring unfinished source, preparing an integration
candidate and completing a synthetic goal with the old state/checkout unavailable
is covered by a deterministic acceptance test. Live off-host restoration, crypto
stores, active crash-container reconciliation and full cross-machine qualification
remain separate gates.

Schema revision 5 adds authoritative attempts for task leases and controller
operations. Admission snapshots and their hashes are immutable; checkpoints,
usage, sessions, outcomes and evidence remain linked to each attempt. Task
counters and audit events do not replace these records. Active earlier-alpha work
without attempt admission is refused; retain it privately and initialize fresh
state. Empty/inactive alpha databases can migrate transactionally.

Before dispatch, startup expires prior task leases and revokes worker credentials
and inference capabilities. It stops only inspected registered resources, retains
source, and creates durable recovery decisions. Missing containers confirmed by
the Docker daemon are recoverable; daemon errors and ownership mismatches stop
startup with authority fenced. Interrupted task work requires inspection before a
fresh attempt. Deferring that recovery decision leaves it pending. Interrupted
controller operations pause their goals for explicit inspection/resume.
Dedicated authentication recovery requires a confirmed dead local writer and a
matching configured identity. It stops only label-matched registered resources
before releasing the writer. Live/foreign writers, unavailable Docker, missing
configuration and ownership mismatches keep admission closed. Startup never logs in.

Metered usage distinguishes reported, estimated and unknown billing. Unknown
billing leaves its reservation unresolved and counted against available spending;
it is never recorded as measured zero or settled at the reserved estimate.
Subscription usage has no dollar amount. Subscription coding remains disabled
until its isolated runtime and live authentication qualification are complete.

Schema revision 6 adds immutable usage reconciliation receipts. Inspect unresolved
reservations with `state usage`. Use `state reconcile-usage ATTEMPT_ID --input FILE`
only after matching provider evidence to that closed attempt. The reviewed JSON
contains `costUsd`, `status` (`reported` or `estimated`), `evidenceArtifactId` and
`explanation`. Evidence must be registered to the same goal and readable through
the bounded state artifact policy. The API hashes its bytes, then records the
receipt, accounting settlement and audit event in one transaction. Conflicting
retries, active attempts and missing/foreign evidence are refused.

The original unknown usage stays in the attempt. Dashboard/API projections expose
the later reconciliation separately. Reservations are estimates; actual evidence
may exceed them and is never clamped to the authorized allowance. A reconciliation
does not increase admitted spending authority or resume paused work. No provider
invoice is automatically inferred from successful execution or an operator claim
without registered supporting evidence.

`backup coordinated --destination FILE --recipient-file FILE` requires the
candidate controller/connectors to be stopped and acquires exclusive application
ownership. It holds all configured authentication writers and all configured
Matrix stores with prepared companion paths until the entire encrypted recovery
set is sealed. A running writer, unreconciled execution, unavailable store or
changed applied configuration refuses the operation. It never silently omits a
configured authentication store. A disabled Matrix connector without prepared
paths has no provisioned store in this recovery set.

`restore coordinated --input FILE --identity-file FILE --destination PATH` uses
the original reviewed configuration to validate session policy and permanent
Matrix identity, checks every nested encrypted bundle hash, then restores into
separate application/authentication/Matrix locations beneath a fresh canonical
destination. It starts no services and performs no login/sync. Partial restoration
is retained with a failure status for inspection. Original state is preserved.
Review relocated paths, provision new scoped controller tokens and apply config
offline before the synthetic workflow. The encrypted catalog records outstanding
external configuration/secrets and homeserver recovery requirements. This set
alone does not establish full deployment, off-host or device recovery acceptance.

Schema 7 adds durable project backlog (`control_backlog`) with indexed project,
status and priority, revision concurrency control, immutable entry identity and a
unique foreign-key goal link. Fresh initialization and schema-6 upgrades apply
migration 7 and its ledger entry with `PRAGMA user_version` in one transaction.
Instance inspection accepts supported schemas 1 through 7 and checks their exact
ledger. Recovery retains pending, archived and launched entries and the original
launch revision. Backlog changes do not start execution; explicit launch commits
admission, accounting, planning job, status and goal link atomically. See
[backlog workflow](agents.md#durable-project-backlog) for dependency and replay rules.
