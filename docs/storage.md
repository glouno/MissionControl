# Storage admission and lifecycle

Managed workspace admission defaults to a 50 GiB Linux free-space reserve.
Trusted installations can supply a narrower or larger explicit storage policy.
On WSL, admission also requires a fresh Windows host measurement from the
operator-installed `/usr/local/bin/devbox-storage pressure` helper. The helper
owns local host reserve/peak policy; candidate source cannot select the executable
or substitute cached metrics. Missing, incomplete, wrong-host or stale results
deny admission rather than treating Linux free space as physical host capacity.
Non-WSL hosts retain Linux/native filesystem admission behavior.

Environment image builds check reserves plus a 10 GiB estimated peak. The default
WSL Docker build and Buildx build invocations run through the shared host-owned heavy-job gate, which
serializes cooperating builds and measures again under its lock. The build
timeout runs inside that lock, so the lock owner waits until Docker exits.
Inspection does
not take a heavy-build slot. Trusted custom Docker adapters must preserve these
admission/coordination guarantees. Do not wrap an already gated image builder in
another instance of the same gate. Workspace pressure is an observation, not a
multi-job storage reservation; unrelated processes can still consume space.

Worker registrations are created for actual task claims, explicit registrations
or lease heartbeats, not every idle controller dispatch. Historical registrations
remain until separately authorized reference-aware maintenance; upgrading does
not bulk-delete existing history.

Source recovery excludes disposable dependency and build directories, including
the Matrix connector's generated Rust target. Explicitly requesting retention of
these generated files is rejected. Tracked source, required artifacts and verified
recovery remain governed by existing archive/cleanup checks. Maintenance stays
preview-first; this change does not enable blanket deletion of images, volumes,
backups, failed scratch or exported caches.

Host admission complements, rather than replaces, per-owner byte/age budgets.
Each CI scratch/exported-cache owner needs terminal evidence, reference-aware
retention, inactive-process checks and crash reconciliation. Confirm storage
plateaus across repeated revisions and preserve exact-source signed verification.
WSL file deletion/trim does not prove the host VHDX shrank; physical recovery
requires separate host measurement and an approved maintenance window.
