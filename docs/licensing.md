# Licensing and corresponding source

Original MissionControl code is **AGPL-3.0-only**. Distributors retain that license
and the required notices and provide applicable Corresponding Source. A modified
covered network application must offer its interacting users the applicable
Corresponding Source. Operational configuration, goal descriptions and runtime
evidence are data; running the application does not automatically publish them.
Private covered-code changes have a separate licensing analysis from private data.

## Initial preview distribution

The preview distributes reviewed original source, compiled Node application files,
lockfiles, documentation, generic recipes and synthetic built-ins. It does not ship
`node_modules`, Rust crate sources, Matrix binaries, vendor Codex/Claude executables,
worker images or homeserver images. Users install locked dependencies themselves.
Source availability does not certify optional binaries or platform integrations.

`THIRD_PARTY_NOTICES.md` retains reviewed notice/license texts for the exact locked
npm production inventory. Its dependencies use MIT, ISC, BSD, 0BSD or Apache-2.0;
they retain their individual licenses. Three AWS packages omit license text from
the npm payload; the same published upstream release's Apache-2.0 text and exact
package versions were checked and retained. No dependency source was modified.
`docs/dependencies.json` records declared npm/Rust licenses and lockfile hashes.

Optional Rust dependencies include MPL-2.0 packages. The source-only companion and
its lockfile do not redistribute those dependency sources or linked binaries.
Before distributing a Matrix binary, review the actual target, native libraries,
license choices and required notices, and make applicable MPL source available.
The existing collector supports that review but is not a binary release approval.

Build-time vendor installation is an operator action subject to vendor terms.
Do not redistribute vendor executables or images until their complete contents,
notices, applicable source and redistribution permissions have been reviewed.
No generic dependency inventory establishes image licensing.

## Exact original-source delivery

`npm run build` creates `assets/source.tar.gz` and `assets/source-manifest.json`
from the explicit source inventory. It excludes generated assets, dependencies,
Git history, installation configuration, secrets and state. The installed/npm
payload includes these assets; source archives remain independently buildable.
The bundle records every original source path/content hash, version and clean
commit when available. It verifies bounded regular TAR members and normalized
metadata; an edited or dirty checkout is identified by content without inventing
a clean revision.

The authenticated dashboard/API offers `/api/v1/source` and `/api/v1/source-info`.
Missing or mismatched assets must be reported as unavailable. A reviewed release
requires matching source archives and manifest hashes; private history is never
substituted. Deployers modifying covered code must rebuild and deliver their
modified Corresponding Source rather than continue advertising an older bundle.

## Review tooling

`node scripts/dependency-inventory.mjs` regenerates declared inventories after
locked npm/Rust installation. `node scripts/license-audit.mjs /private/new-review`
collects actual packaged notices, target graphs and checksum-verified Rust source
archives outside source. Pinned supplements must match package provenance. These
receipts support review and never automatically declare legal qualification.

## Preview qualification receipts

`node scripts/release.mjs /private/new-release /private/qualification.json` prepares
reviewed source, installed and npm payloads. Omitting the receipt keeps the package
unqualified. A receipt declares `scope: "linux-wsl-preview"`, exact source commit,
source-inventory and npm/Rust lock hashes, config/application schema versions,
and every required gate listed by `scripts/qualification.mjs`. Each passing gate
references canonical private evidence with content hashes, configuration and Linux
platform fingerprints; execution proofs also name the immutable worker image.
Missing, changed or contradictory receipts refuse the claim. Receipt review must
establish that the evidence actually covers its gate; hashes prove identity, not
semantic success.

The release manifest contains a sanitized gate/hash summary, never private evidence
paths, endpoints or diagnostics. `node scripts/verify-release.mjs /private/release
/private/qualification.json` rechecks evidence and exact payloads. Verification
without the private receipt can establish package integrity but does not assert
qualification. Optional macOS, subscriptions, Bedrock, chat device/failure behavior
and off-host recovery are explicitly outside this preview's qualified scope.

`node scripts/public-export.mjs /private/new-public-tree` exports only reviewed
source into a new one-commit neutral history with no remote. It does not publish,
contact GitHub or import implementation history. Run the private-marker audit and
history review before packaging this new tree. The provenance receipt remains
beside it privately; original copyright notices are preserved in source.
