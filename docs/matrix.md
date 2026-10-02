# Matrix companion qualification

The optional Rust companion pins Matrix SDK 0.19.1 with encrypted persistent
SQLite crypto storage. It is under implementation and is not enabled by the core.
Core installation does not require Rust. Qualified binary releases are pending.

Identity-store tests use an invented account without network access. They verify
reopening the same SDK device keys and exclusive local writer ownership. These
tests do not establish real homeserver login, cross-signing, trusted encrypted
commands, sync replay or iPhone behavior.

The SDK processes and persists sync state inside `sync_once` before it returns.
Application intake therefore needs its own committed cursor and replayable inbox.
SDK sync state alone is insufficient acknowledgment of a durable human command.
The companion must persist event intake before advancing that application cursor,
deduplicate by connector instance and event ID, and send acknowledgments with
stable transaction IDs after domain effects commit.

Do not enable a command connector until exact room/account allowlists, verified
sender-device evidence, encryption and membership checks, a scoped controller
token, and restart/outage acceptance all pass. Never auto-join rooms, auto-trust
devices or send sensitive fallback content over Telegram.

The companion now implements explicit commands, scoped controller API calls,
encrypted outgoing SDK sends with stable transaction IDs and a durable application
inbox. Tests use actual SDK event serialization to prove atomic cursor staging,
duplicate replay, failed-write refusal and persistent membership fault detection.
These deterministic checks do not qualify live encryption/trust behavior.

The private companion configuration binds `homeserver`, `own_user`, `own_device`,
`room_id`, `allowed_users`, `state_dir`, `session_file`, `passphrase_file`,
`controller_url`, and `controller_token_file`. Its first start records the server,
account, device and room identity permanently; changing them requires separate
state. Private files must have restrictive permissions.

A limited timeline stops before cursor advancement, requiring history recovery.
Unexpected membership records a persistent trust fault. Do not clear it until
room/device history is reviewed. Undecryptable events remain retained after ten
attempts; unrelated events can proceed. API delivery failures do not consume the
undecryptable retry allowance. Bounded messages and replay recovery still need
live outage and device acceptance before enabling an installation.

## Offline encrypted recovery

Stop the companion and select its reviewed binary. `connector backup
--companion-config /private/matrix.json --binary /installed/missioncontrol-matrix
--destination /private/backups/matrix.age --recipient-file /private/recipient`
asks the Rust companion to acquire the SDK store's exclusive writer lock and copy
its stopped SQLite crypto/state files, inbox/cursor, permanent identity, native
session and store passphrase. The core then encrypts a private hash inventory with
age and removes staging. No controller token is bundled. An active connector,
redirected files, missing SDK databases or changed identity refuses recovery.

`connector restore --companion-config /private/matrix.json --binary
/installed/missioncontrol-matrix --input /private/backups/matrix.age
--identity-file /private/age.key --destination /private/new-matrix-recovery`
requires a new private destination and the same homeserver/account/device/room.
It verifies encrypted hashes, opens the existing encrypted SDK databases offline,
and writes a private connector recovery config. It preserves pending inbox data
and persistent trust faults. Provision a scoped controller credential separately;
restoration never clears trust faults, changes devices or joins rooms.

Only one instance of the recovered Matrix identity may run. Stop the original
before activating recovery. Revoked sessions may require supported login and
explicit device verification. Do not restore only one SQLite file or mix crypto
state with another device/session. SDK reopen is an offline consistency check;
real sync, encrypted delivery, cross-signing, outage and iPhone acceptance remain
required. `node scripts/qualify-matrix-recovery.mjs` uses an invented SDK identity
and proves encrypted copy/reopen, retained trust fault, and overwrite refusal.

## Private native setup

Use the reviewed companion in a private terminal. Configuration is an external
600 file with canonical private references. Provision an existing dedicated
account and choose its permanent device ID before setup; accounts and room joins
are never created automatically. Password setup supports homeservers offering
native password login; hosted SSO/OIDC-only setup remains unqualified.

```
missioncontrol-matrix login /private/matrix.json /private/password-file
missioncontrol-matrix refresh /private/matrix.json
missioncontrol-matrix inspect-trust /private/matrix.json
missioncontrol-matrix verify /private/matrix.json EXISTING_VERIFIED_DEVICE
missioncontrol-matrix verify-user /private/matrix.json @operator:example.invalid OPERATOR_DEVICE
missioncontrol-matrix recover-trust /private/matrix.json REVIEWED-ROOM-HISTORY
```

The password argument is a file path, never the password. Login requires a fresh
session/crypto identity. Remove the temporary password file after setup. The SDK
requests refresh support and saves refreshed sessions synchronously into private
atomic files; persistence failure stops application traffic. Session expiry
requires reauthentication through a reviewed recovery workflow.

Verification sends an SDK SAS request to an explicitly selected same-account
operator device signed by its own cross-signing identity. That signature alone
does not authorize traffic. Compare the emoji symbols and
descriptions on both devices; type MATCH only after checking them. A completed
SAS flow must yield trusted cross-signing evidence before intake. Use `verify-user`
for each allowed operator account's explicitly selected device after verifying
the connector's own identity. Verification waits at most three minutes, including
terminal confirmation. The procedure does not
implement automatic trust or cross-signing bootstrap. Real account/device
verification remains an acceptance gate.

`inspect-trust` acquires exclusive store ownership, performs a bounded SDK sync
and retrieves current identity signatures. It reports only boolean trust states
and counts of trusted operator devices. It grants no trust, accepts no commands,
sends no application messages and does not establish live qualification. Use it
after a peer finishes verification; offline `inspect-store` can retain an earlier
view before the peer's signature upload. An expired session can require the
explicit `refresh` workflow before inspection. Never manually mark an identity
trusted to make inspection pass.

Trust remediation checks current room encryption, invitation policy, membership
and own-device cross-signing before clearing a reviewed historical fault. It
preserves the cursor and every staged command. It requires the operator to review
room history; a current safe membership list alone cannot prove past safety.

Limited timelines now stage a durable backward-pagination recovery cursor. Pages
are committed without advancing application sync until a retained event overlap
or the visible history boundary is reached. Recovery is bounded to 20 pages per
invocation and resumes from its persisted page cursor on restart. An unchanging
pagination cursor refuses advancement. Controller event deduplication still
protects replay after SDK progress or application acknowledgment crashes.

For core launch, Matrix settings declare `binary` and `companionConfig` paths,
resolved against their declaring file. `connector run ID` checks exact room,
sender bindings, loopback controller endpoint and the scoped connector token file
before launching. Companion output is suppressed. `connector prepare ID
--destination /private/prepared-service` writes a disabled Linux user-service or
macOS launch-agent definition in a new directory. Review and install it explicitly
after foreground acceptance. This is preparation, not installed service/device/live
encryption qualification. The same preparation command supports Telegram.
# Connector health

`connector health` reads the controller's authenticated `/api/v1/connectors`
projection. The dashboard Agents view and MCP `connector_health` use the same
projection. Matrix and Telegram report bounded counts and fixed fault codes,
without message content, identity lists, session values or raw diagnostics.
Reports include last completed sync time, locally pending/exhausted inbox counts,
history recovery status and destination delivery backlog. Trust faults require
private device/membership inspection and explicit remediation. Health observations
never establish device trust, admission authority or live qualification.

A report older than 90 seconds is unavailable; its previous fault and last sync
remain visible. A stopped or crashed connector does not discard pending commands,
questions or delivery transaction IDs. Controller outages may prevent fresh
observations, so inspect both the service and the retained private connector store.

`connector install ID` installs a disabled service definition without starting it.
`connector status|stop|restart|uninstall ID` manages only that connector's v1 unit,
after checking the installed definition matches the exact configuration and CLI
executable. A changed definition or redirected path refuses service changes.
Stop/unload before uninstalling. On macOS, install then explicitly load the reviewed
launch-agent definition before using restart. Installing services or restarting a
real transport requires the operator's deployment authorization. Preparation and
status inspection remain independent of live acceptance.
