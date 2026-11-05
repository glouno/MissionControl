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
WSL Docker builds use host-owned concurrent admission with explicit
isolated context and mutable image-tag resources. Storage measurements are fresh;
independent jobs overlap when declared storage requirements fit; CPU and memory
estimates are advisory.
The Docker daemon request is registered inside its task scope with an image-ID
receipt. Interrupted transport retains the admission intent for native completion
inspection. The host helper enforces the timeout; retained diagnostic tails remain
bounded. Buildx is refused on WSL because its daemon tracking is not supported
by the installed host gate; native non-WSL adapters remain unchanged. Read-only
inspection does not reserve build capacity. Trusted custom Docker adapters must
preserve the same admission and ownership guarantees.

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

Dependency-image builds now use the daemon's bounded native BuildKit cache;
new records do not export a full local cache per revision. Exact resolved
manifest/toolchain/base/recipe identities still select immutable image reuse,
and the database transaction rejects duplicate active builds of that identity.
Historical exported caches remain owned by their existing records and verified
maintenance; this source change does not delete them or switch a live runtime.
On Paris, the host wrapper declares the isolated context and mutable image tag
as resources so independent image builds do not serialize on a checkout path.
