# Encrypted backup operation

Application backup and native authentication backup have independent owners. A
complete application snapshot includes owned workspaces, Git object caches,
evidence and SQLite; it excludes external configuration/secrets and Matrix,
subscription and homeserver stores. Review each separate procedure before relying
on any recovery bundle. Store age identities separately from backup destinations.

## Daily application backup

The installation `config.json` contains an optional strict `backup` object:

```json
{ "enabled": false, "hourUtc": 3 }
```

Set `destinationDir` and `recipientFile` relative to `config.json`, or use explicit
absolute paths. The destination must be a private canonical directory outside
configuration, application state and secrets. It can be a mounted private off-host
destination. `recipientFile` contains one public age recipient. Secret age identity
values never belong in configuration.

`backup prepare --destination /private/prepared-backup-services` generates user
service definitions in a new private directory. It does not install, enable or
start them. Configure a recipient/destination, validate/apply configuration, and
explicitly enable the backup policy before installing those definitions.

Linux's timer runs at the configured UTC hour with a short randomized delay and
missed-run catch-up. The macOS launch agent checks UTC hourly and runs at the
configured hour; it has no missed-day catch-up. Actual launchd acceptance remains
pending. User services and WSL sleep/shutdown affect backup availability.

`backup run` requests an authenticated complete online snapshot, which pauses
admissions and quiesces filesystem-changing work. A bounded drain failure leaves
work intact and refuses the snapshot. Each run uses a unique destination and
writes an unverified, pinned recovery receipt. It does not delete older copies or
claim off-host restore success. Inspect service exit status and receipts locally;
encrypted files alone are not evidence of recoverability.

## Restore and retention

`restore` requires a new destination and checks the encrypted inventory, file
hashes, instance identity, schema ledger and SQLite integrity. Registered Git
backlinks are repaired after validation. Executable source files retain private
execute permissions. Apply new external configuration offline before startup.
Never overwrite a running database or use state restore as a code downgrade.

Restore a backup into a separate private destination, run doctor and a fake goal,
and inspect unfinished evidence before granting it real projects/providers. Keep
the old instance stopped when activating its restored identity. Preserve at least
one verified recovery copy and all unfinished/pinned/sole recovery material.
Automatic backup pruning is not enabled. Real off-host restoration still requires the
installation's actual recipient and destination.

Native subscription stores use `auth backup` and `auth restore`, described in
`subscriptions.md`. Matrix and Synapse backup/restore require their separate
single-writer/consistent PostgreSQL, media and signing-key procedures; application
backup cannot recover those identities by itself.

## Verified application backup retention

Scheduled writes remain pinned and unverified. `backup verify --receipt PATH
--identity-file PATH` decrypts and restores the registered complete application
bundle into an isolated temporary destination, checks hashes/schema/instance
integrity, then records a matching verification receipt. This proves structural application
restoration; an installed synthetic workflow is a separate acceptance check.
Matrix, subscription and homeserver stores still need their own
recovery evidence. `backup unpin --receipt PATH` refuses unverified copies.

`backup prune` previews only. Add `--apply` explicitly to remove registered,
verified, unpinned backups superseded by a newer verified copy of the same
instance and schema, retaining identical recovery files, database recovery records,
and separate-store requirements. Changed recovery material protects the older copy.
Backups containing unfinished or uninspected goals cannot be unpinned.
It retains the newest verified copy, pinned copies, unverified copies,
and unregistered files. It rechecks hashes and recovery availability before each
removal. A private single-writer retention lock excludes competing pin/verify/prune
operations. An interrupted owner refuses further retention until its lock is
inspected and recovered privately; never remove a living owner's lock.
Each applied deletion writes and syncs a private deletion intent before removing
registered files. An interrupted intent blocks further pruning until the recorded
replacement and remaining files have been inspected. Retention never deletes a
separate Matrix, subscription, configuration, or homeserver backup.

Schema 7 backups include the durable project backlog in the authoritative SQLite
snapshot, including revisions, dependency IDs, statuses and linked goal IDs.
Backup manifests and recovery inspection support database schemas 1 through 7;
ledger and foreign-key checks still apply. Restoring a launched entry preserves
its original launch revision: matching replay returns its original goal without
creating another admission. Pending backlog remains inert after recovery and
requires explicit launch against the current trusted project configuration.
