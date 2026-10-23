# Exact project evidence qualification and operator handoff

This read-only tool compares explicitly supplied evidence with explicitly reviewed
expectations for **CLI, API, Dashboard and Service**. It does not qualify a
MissionControl release, admit work, authenticate a provider or change installation
configuration. It has no repository discovery, sibling access, network client or
command execution. Paths in exports, artifact names and commands are inert strings.
Unavailable private context stays unresolved. A worker-authored receipt is never
owned verifier authority merely because its fields match.

Build with the repository's approved local setup, then run:

```sh
node scripts/qualify-projects.mjs \
  --expectations /private/evidence/expectations.json \
  --configuration /private/evidence/configuration.json \
  --repositories /private/evidence/repositories.json \
  --artifacts /private/evidence/artifacts.json \
  --checks /private/evidence/checks.json
```

All five flags are required exactly once. There are no default inputs, environment
fallbacks or optional repository scans. Output is JSON on stdout: exit 0 means
supplied evidence matches, exit 1 means evidence blocks qualification, and exit 2
means CLI/file/JSON input failure. Schema failures produce exit 1. File errors may
mention private paths; keep reports in private evidence storage. No output file is
written. Output ordering is CLI, API, Dashboard, Service with stable issue order;
there is no clock, randomness or implicit expiry. Freshness is exact candidate,
base, configuration and operator-selected evidence revision, never wall-clock age.

Each input must be a canonical regular UTF-8 JSON file with no symlinks, at most
1 MiB. The reader caps bytes even if the file grows. Each document has at most
20,000 tokens and depth 32. Duplicate JSON keys (including escaped aliases),
unknown schema fields and duplicate profiles/project IDs block success. Limits
also apply to direct validator callers. Export files must remain stable during
collection; this tool is a bounded comparator, not a cryptographic provenance
service or a replacement for controller authentication.

## Input contract

Every envelope has `schemaVersion: 1`. The complete executable examples are in
the deterministic fixture bundle at the end of this document.
These are qualification-specific **resolved, secret-free projections**, not a
replacement format for the external configuration loader. Follow
[configuration conventions](configuration.md): resolve applied project/profile,
host and runtime settings with authorized installation tooling before exporting.
Never export credentials, secrets, auth sessions, mutable databases or private
source. The validator deliberately does not follow configuration references.

- `expectations.json`: `scope` is `fixture` or `operator`; `projects` contains
  exactly one of each named profile and a unique `projectId`. Each expectation
  supplies all binding fields below, nonempty unique `requiredCommands`, nonempty
  unique `localVerificationDocumentation`, `authorities` and `evidenceRevision`.
  Expectations must come from the operator's reviewed catalog, independent of
  candidate-authored evidence. Never change expectations simply to match a failure.
- `configuration.json`: exactly four `projects`, each with `profile`, `id`,
  `enabled`, `executionMode: "isolated"`, and resolved `config`. `config` contains
  `repoPath` (inert), `repository: {identity, baseCommit, candidateCommit}`,
  `verificationCommands`, `executionImage`, `containerImage` (verification image),
  `dependencyLocks`, `pins` and `platform`. This projection preserves the existing
  project/goal command and image naming conventions. An intentionally disabled
  project remains disabled and blocks operator qualification. It is not enabled
  by running the validator.
- `repositories.json`: `receipts` (zero to four) include all binding fields,
  `profile`, `projectId`, `evidenceRevision`, and `clean: true` for success.
- `artifacts.json`: receipts contain the same bindings plus `artifacts`, each
  `{name, sha256, bytes}`. Names are unique, hashes are lowercase SHA256 and sizes
  are 1 byte to 16 MiB. Require `verification.json` and every expected local
  verification document by exact name. The receipt inventories actual retained
  bytes; the validator compares metadata and does not open or hash artifact paths.
- `checks.json`: receipts contain the same bindings plus `commands`, `authorities`
  and `hostStatus`. Each command is `{command, status, exitCode}`. All required
  commands must be present exactly, nonempty and unique; every supplied command
  must be `passed` with exit code 0. Failed, cancelled, pending, missing or empty
  checks block success. `hostStatus` is `ready`, `blocked` or `unknown`; only ready
  succeeds. Authorities have `protectedIntegration` and `statusWriter`, each
  `{principal, policySha256}` or null in check receipts. Missing/mismatched owned
  authority is an explicit gap. No credential is included or created.

All receipt binding fields are mandatory: `repository` (exact opaque identity,
without URL normalization), `baseCommit`, `candidateCommit`,
`configurationSha256`, `dependencyLocks`, `executionImage`, `verificationImage`,
`pins` and `platform`. Commits are exact lowercase 40- or 64-digit hex. Locks are a
nonempty map of explicit lock name to lowercase SHA256 (maximum 32). No lock is
installed or changed. Images require `sha256:<64 hex>` or an image reference
ending in `@sha256:<64 hex>`; tags alone cannot succeed. `platform` binds `os`
(`linux`, `macos`, `windows`) and `hostFingerprintSha256`. Commands/doc lists have
1–32 entries, string fields are at most 2048 characters with no control characters,
artifact lists have 1–40 entries. A receipt cannot substitute another profile's
repository, image, locks, host, revision or command result.

`configurationSha256` is SHA256 of canonical JSON for the complete resolved
configuration project entry. `configurationFingerprint` in
[src/projectQualification.ts](../src/projectQualification.ts) implements this:
recursively sort object keys lexically, preserve array order, use compact JSON
with no final newline, then hash UTF-8 bytes. The export is compared directly to
expectations as well as hashed; commands must match the exact ordered expected
list. Host/runtime identities are projected explicitly rather than inferred from
an installation-wide hash.

`pins` must contain exactly `DependencyA` and `DependencyB`. Each has `repository`,
`commit`, `configurationSha256` and `imageDigest`. The operator supplies exact
expected pins independently for each project. Every configuration and receipt
must match these pins. Stale commits, configuration or images block success;
unknown/null pins are malformed and block success. There is no sibling checkout
inspection or assumption about current private branches.

## Deterministic fixture profiles

All four profiles use invented `fixture:` repository identities and inert
`/fixture-only/` paths. They represent distinct CLI, API, Dashboard and Service
bindings, not those actual private applications. Their host/image/lock/artifact
hashes are invented, and principals explicitly say fixture. Even exit 0 reports
actual private application acceptance, native Mac acceptance and live subscription
execution as unresolved. `scope: operator` likewise only validates supplied
metadata; it does not authenticate provenance or establish those acceptance gates.

The repository publication inventory allows top-level documentation and rejects
nested fixture files. The checked-in fixture bundle below therefore contains the
seven JSON documents; regression tests materialize them only in temporary storage.
To collect these local fixtures, copy each named member to a same-named `.json`
file in your explicit private fixture directory, or extract the bundle offline:

````sh
node --input-type=module - /private/fixture-directory <<'JS'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const doc = readFileSync('docs/project-qualification.md', 'utf8');
const bundle = JSON.parse(doc.split('<!-- qualification-fixtures-v1 -->\n\n```json\n')[1].split('\n```')[0]);
const target = resolve(process.argv[2]);
mkdirSync(target, { recursive: true });
for (const [name, value] of Object.entries(bundle)) {
  writeFileSync(join(target, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
JS
````

The extraction command displays an operator action and does not run in the
qualification CLI. It refuses to overwrite existing fixture files. After building,
run the CLI with the five explicitly extracted files:

```sh
node scripts/qualify-projects.mjs \
  --expectations /private/fixture-directory/expectations.json \
  --configuration /private/fixture-directory/configuration.json \
  --repositories /private/fixture-directory/repositories.json \
  --artifacts /private/fixture-directory/artifacts.json \
  --checks /private/fixture-directory/checks.json
```

This gives deterministic fixture success only. Replace the artifacts input with
`missing-artifacts.json` for missing evidence in all profiles, or the checks input
with `stale-checks.json` for old candidate/revision and stale DependencyA/DependencyB pins.
Both exit 1. Repeated runs produce identical JSON. The local regression suite
also mutates every binding across every profile and receipt family, malformed and
duplicate JSON, failed/empty checks, authority gaps and unknown hosts.

## Evidence collection and bounded handoff

1. The operator selects one exact base/candidate per project and reviews expected
   repository identities, applied resolved configuration, all dependency locks,
   immutable execution/verification images, DependencyA/DependencyB pins and host identity.
   Select a new evidence revision when replacing a receipt set. Missing private
   access is a blocker; do not fabricate an identity or discover adjacent repos.
2. The authorized repository owner independently inspects that named repository,
   confirms clean exact source/base and exports its receipt. Retain archived source
   and locks in private evidence storage. This CLI does not perform that inspection.
3. The owned verifier runs the project's reviewed nonempty required commands in
   the approved host/image lane and retains exact-bound outputs, artifact bytes
   and receipts. Keep each project's **verification.json** and applicable
   **local-verification documentation**, including any repository-specific
   `docs/local-verification.md` or equivalent identified in expectations. Missing
   documentation blocks the handoff rather than silently dropping the requirement.
   Retain logs and artifact hashes; do not turn candidate-authored JSON into a
   signed/verifier-owned receipt. Follow
   [local delivery supervision](local-delivery-supervision.md) for source/base,
   contract and owned-verifier authority. MissionControl's own `verification.json`
   and `scripts/verify.py` remain unchanged; the admitted task check is `mc-check`.
4. The host owner resolves blocked/unknown platform readiness and an authorized
   integrator verifies protected-branch policy and scoped status-writer authority.
   Workers do not receive status credentials or Docker socket authority. Missing
   auth, billing approval or a policy exception requires a human decision in the
   existing controller flow; the report grants none of them.
5. Run the comparator with the five explicit stable files and retain its report.
   For blockers, `nextCommands` contains at most 32 reviewed required commands
   per project, **for display only**. The host/authority handoff describes the
   preconditions before an owner chooses to execute those commands. Collect one
   corrected exact-bound receipt set and rerun; do not launch automated retries,
   publish, merge, deploy, modify host policy, resume paused goals or clear
   unknown-usage holds. Disabled project configuration remains unchanged.

Tooling delivery requires `mc-check` and controller independent review of the
committed candidate. Supplied evidence qualification and fixture outcomes are
separate report fields. Actual private application acceptance requires independent
owner acceptance of real retained evidence; native Mac/device acceptance requires
that platform's owner-run lane; live subscription execution requires the existing
private exact implementation/image/model/authentication acceptance process in
[subscriptions](subscriptions.md). Unavailable gates remain unresolved. Nothing
in this tool changes release qualification semantics or enables optional features.

## Embedded local fixture bundle

These are invented deterministic metadata, never real application receipts.

<!-- qualification-fixtures-v1 -->

```json
{
  "artifacts": {
    "schemaVersion": 1,
    "receipts": [
      {
        "profile": "CLI",
        "projectId": "local",
        "repository": "fixture:CLI",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "fd921b1a12051df955738a0c2e14c5291dd3b9e32ae0a9a605b2a77701b1294e",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-1",
        "artifacts": [
          {
            "name": "verification.json",
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bytes": 123
          },
          {
            "name": "docs/local-verification.md",
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bytes": 123
          }
        ]
      },
      {
        "profile": "API",
        "projectId": "task",
        "repository": "fixture:API",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "b3bdae07ebe5a87c17aa8b30ebb34a5e81e814ef87f4b666bbf1c348e73a76a0",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-1",
        "artifacts": [
          {
            "name": "verification.json",
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bytes": 123
          },
          {
            "name": "docs/local-verification.md",
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bytes": 123
          }
        ]
      },
      {
        "profile": "Dashboard",
        "projectId": "reviewer",
        "repository": "fixture:Dashboard",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "55ff6a3872ac7d6b84ab8a1a554be3f54f16e13f0b7be4e1e201679ee4522257",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-1",
        "artifacts": [
          {
            "name": "verification.json",
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bytes": 123
          },
          {
            "name": "docs/local-verification.md",
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bytes": 123
          }
        ]
      },
      {
        "profile": "Service",
        "projectId": "contacts",
        "repository": "fixture:Service",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "b2772cfcbf3ab31f6180735bd9dee2b360ced5719e06cad2678348561871d4ab",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-1",
        "artifacts": [
          {
            "name": "verification.json",
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bytes": 123
          },
          {
            "name": "docs/local-verification.md",
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bytes": 123
          }
        ]
      }
    ]
  },
  "checks": {
    "schemaVersion": 1,
    "receipts": [
      {
        "profile": "CLI",
        "projectId": "local",
        "repository": "fixture:CLI",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "fd921b1a12051df955738a0c2e14c5291dd3b9e32ae0a9a605b2a77701b1294e",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-1",
        "commands": [
          {
            "command": "node --version",
            "status": "passed",
            "exitCode": 0
          },
          {
            "command": "test -f verification.json",
            "status": "passed",
            "exitCode": 0
          }
        ],
        "authorities": {
          "protectedIntegration": {
            "principal": "fixture-owned-integrator",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "statusWriter": {
            "principal": "fixture-owned-verifier",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "hostStatus": "ready"
      },
      {
        "profile": "API",
        "projectId": "task",
        "repository": "fixture:API",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "b3bdae07ebe5a87c17aa8b30ebb34a5e81e814ef87f4b666bbf1c348e73a76a0",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-1",
        "commands": [
          {
            "command": "node --version",
            "status": "passed",
            "exitCode": 0
          },
          {
            "command": "test -f verification.json",
            "status": "passed",
            "exitCode": 0
          }
        ],
        "authorities": {
          "protectedIntegration": {
            "principal": "fixture-owned-integrator",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "statusWriter": {
            "principal": "fixture-owned-verifier",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "hostStatus": "ready"
      },
      {
        "profile": "Dashboard",
        "projectId": "reviewer",
        "repository": "fixture:Dashboard",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "55ff6a3872ac7d6b84ab8a1a554be3f54f16e13f0b7be4e1e201679ee4522257",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-1",
        "commands": [
          {
            "command": "node --version",
            "status": "passed",
            "exitCode": 0
          },
          {
            "command": "test -f verification.json",
            "status": "passed",
            "exitCode": 0
          }
        ],
        "authorities": {
          "protectedIntegration": {
            "principal": "fixture-owned-integrator",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "statusWriter": {
            "principal": "fixture-owned-verifier",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "hostStatus": "ready"
      },
      {
        "profile": "Service",
        "projectId": "contacts",
        "repository": "fixture:Service",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "b2772cfcbf3ab31f6180735bd9dee2b360ced5719e06cad2678348561871d4ab",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-1",
        "commands": [
          {
            "command": "node --version",
            "status": "passed",
            "exitCode": 0
          },
          {
            "command": "test -f verification.json",
            "status": "passed",
            "exitCode": 0
          }
        ],
        "authorities": {
          "protectedIntegration": {
            "principal": "fixture-owned-integrator",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "statusWriter": {
            "principal": "fixture-owned-verifier",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "hostStatus": "ready"
      }
    ]
  },
  "configuration": {
    "schemaVersion": 1,
    "projects": [
      {
        "profile": "CLI",
        "id": "local",
        "enabled": true,
        "executionMode": "isolated",
        "config": {
          "repoPath": "/fixture-only/CLI",
          "repository": {
            "identity": "fixture:CLI",
            "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc"
          },
          "verificationCommands": [
            "node --version",
            "test -f verification.json"
          ],
          "containerImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "dependencyLocks": {
            "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "pins": {
            "DependencyA": {
              "repository": "fixture:DependencyA",
              "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            "DependencyB": {
              "repository": "fixture:DependencyB",
              "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          },
          "platform": {
            "os": "linux",
            "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        }
      },
      {
        "profile": "API",
        "id": "task",
        "enabled": true,
        "executionMode": "isolated",
        "config": {
          "repoPath": "/fixture-only/API",
          "repository": {
            "identity": "fixture:API",
            "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc"
          },
          "verificationCommands": [
            "node --version",
            "test -f verification.json"
          ],
          "containerImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "dependencyLocks": {
            "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "pins": {
            "DependencyA": {
              "repository": "fixture:DependencyA",
              "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            "DependencyB": {
              "repository": "fixture:DependencyB",
              "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          },
          "platform": {
            "os": "linux",
            "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        }
      },
      {
        "profile": "Dashboard",
        "id": "reviewer",
        "enabled": true,
        "executionMode": "isolated",
        "config": {
          "repoPath": "/fixture-only/Dashboard",
          "repository": {
            "identity": "fixture:Dashboard",
            "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc"
          },
          "verificationCommands": [
            "node --version",
            "test -f verification.json"
          ],
          "containerImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "dependencyLocks": {
            "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "pins": {
            "DependencyA": {
              "repository": "fixture:DependencyA",
              "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            "DependencyB": {
              "repository": "fixture:DependencyB",
              "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          },
          "platform": {
            "os": "linux",
            "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        }
      },
      {
        "profile": "Service",
        "id": "contacts",
        "enabled": true,
        "executionMode": "isolated",
        "config": {
          "repoPath": "/fixture-only/Service",
          "repository": {
            "identity": "fixture:Service",
            "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc"
          },
          "verificationCommands": [
            "node --version",
            "test -f verification.json"
          ],
          "containerImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "dependencyLocks": {
            "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "pins": {
            "DependencyA": {
              "repository": "fixture:DependencyA",
              "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            "DependencyB": {
              "repository": "fixture:DependencyB",
              "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          },
          "platform": {
            "os": "linux",
            "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        }
      }
    ]
  },
  "expectations": {
    "schemaVersion": 1,
    "scope": "fixture",
    "projects": [
      {
        "profile": "CLI",
        "projectId": "local",
        "repository": "fixture:CLI",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "fd921b1a12051df955738a0c2e14c5291dd3b9e32ae0a9a605b2a77701b1294e",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "authorities": {
          "protectedIntegration": {
            "principal": "fixture-owned-integrator",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "statusWriter": {
            "principal": "fixture-owned-verifier",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "requiredCommands": [
          "node --version",
          "test -f verification.json"
        ],
        "localVerificationDocumentation": [
          "docs/local-verification.md"
        ],
        "evidenceRevision": "fixture-generation-1"
      },
      {
        "profile": "API",
        "projectId": "task",
        "repository": "fixture:API",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "b3bdae07ebe5a87c17aa8b30ebb34a5e81e814ef87f4b666bbf1c348e73a76a0",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "authorities": {
          "protectedIntegration": {
            "principal": "fixture-owned-integrator",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "statusWriter": {
            "principal": "fixture-owned-verifier",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "requiredCommands": [
          "node --version",
          "test -f verification.json"
        ],
        "localVerificationDocumentation": [
          "docs/local-verification.md"
        ],
        "evidenceRevision": "fixture-generation-1"
      },
      {
        "profile": "Dashboard",
        "projectId": "reviewer",
        "repository": "fixture:Dashboard",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "55ff6a3872ac7d6b84ab8a1a554be3f54f16e13f0b7be4e1e201679ee4522257",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "authorities": {
          "protectedIntegration": {
            "principal": "fixture-owned-integrator",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "statusWriter": {
            "principal": "fixture-owned-verifier",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "requiredCommands": [
          "node --version",
          "test -f verification.json"
        ],
        "localVerificationDocumentation": [
          "docs/local-verification.md"
        ],
        "evidenceRevision": "fixture-generation-1"
      },
      {
        "profile": "Service",
        "projectId": "contacts",
        "repository": "fixture:Service",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "b2772cfcbf3ab31f6180735bd9dee2b360ced5719e06cad2678348561871d4ab",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "authorities": {
          "protectedIntegration": {
            "principal": "fixture-owned-integrator",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "statusWriter": {
            "principal": "fixture-owned-verifier",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "requiredCommands": [
          "node --version",
          "test -f verification.json"
        ],
        "localVerificationDocumentation": [
          "docs/local-verification.md"
        ],
        "evidenceRevision": "fixture-generation-1"
      }
    ]
  },
  "missing-artifacts": {
    "schemaVersion": 1,
    "receipts": []
  },
  "repositories": {
    "schemaVersion": 1,
    "receipts": [
      {
        "profile": "CLI",
        "projectId": "local",
        "repository": "fixture:CLI",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "fd921b1a12051df955738a0c2e14c5291dd3b9e32ae0a9a605b2a77701b1294e",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-1",
        "clean": true
      },
      {
        "profile": "API",
        "projectId": "task",
        "repository": "fixture:API",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "b3bdae07ebe5a87c17aa8b30ebb34a5e81e814ef87f4b666bbf1c348e73a76a0",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-1",
        "clean": true
      },
      {
        "profile": "Dashboard",
        "projectId": "reviewer",
        "repository": "fixture:Dashboard",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "55ff6a3872ac7d6b84ab8a1a554be3f54f16e13f0b7be4e1e201679ee4522257",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-1",
        "clean": true
      },
      {
        "profile": "Service",
        "projectId": "contacts",
        "repository": "fixture:Service",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "cccccccccccccccccccccccccccccccccccccccc",
        "configurationSha256": "b2772cfcbf3ab31f6180735bd9dee2b360ced5719e06cad2678348561871d4ab",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-1",
        "clean": true
      }
    ]
  },
  "stale-checks": {
    "schemaVersion": 1,
    "receipts": [
      {
        "profile": "CLI",
        "projectId": "local",
        "repository": "fixture:CLI",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "configurationSha256": "fd921b1a12051df955738a0c2e14c5291dd3b9e32ae0a9a605b2a77701b1294e",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "dddddddddddddddddddddddddddddddddddddddd",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-0",
        "commands": [
          {
            "command": "node --version",
            "status": "passed",
            "exitCode": 0
          },
          {
            "command": "test -f verification.json",
            "status": "passed",
            "exitCode": 0
          }
        ],
        "authorities": {
          "protectedIntegration": {
            "principal": "fixture-owned-integrator",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "statusWriter": {
            "principal": "fixture-owned-verifier",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "hostStatus": "ready"
      },
      {
        "profile": "API",
        "projectId": "task",
        "repository": "fixture:API",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "configurationSha256": "b3bdae07ebe5a87c17aa8b30ebb34a5e81e814ef87f4b666bbf1c348e73a76a0",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "dddddddddddddddddddddddddddddddddddddddd",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-0",
        "commands": [
          {
            "command": "node --version",
            "status": "passed",
            "exitCode": 0
          },
          {
            "command": "test -f verification.json",
            "status": "passed",
            "exitCode": 0
          }
        ],
        "authorities": {
          "protectedIntegration": {
            "principal": "fixture-owned-integrator",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "statusWriter": {
            "principal": "fixture-owned-verifier",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "hostStatus": "ready"
      },
      {
        "profile": "Dashboard",
        "projectId": "reviewer",
        "repository": "fixture:Dashboard",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "configurationSha256": "55ff6a3872ac7d6b84ab8a1a554be3f54f16e13f0b7be4e1e201679ee4522257",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "dddddddddddddddddddddddddddddddddddddddd",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-0",
        "commands": [
          {
            "command": "node --version",
            "status": "passed",
            "exitCode": 0
          },
          {
            "command": "test -f verification.json",
            "status": "passed",
            "exitCode": 0
          }
        ],
        "authorities": {
          "protectedIntegration": {
            "principal": "fixture-owned-integrator",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "statusWriter": {
            "principal": "fixture-owned-verifier",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "hostStatus": "ready"
      },
      {
        "profile": "Service",
        "projectId": "contacts",
        "repository": "fixture:Service",
        "baseCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "candidateCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "configurationSha256": "b2772cfcbf3ab31f6180735bd9dee2b360ced5719e06cad2678348561871d4ab",
        "dependencyLocks": {
          "package-lock.json": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "executionImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "verificationImage": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pins": {
          "DependencyA": {
            "repository": "fixture:DependencyA",
            "commit": "dddddddddddddddddddddddddddddddddddddddd",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "DependencyB": {
            "repository": "fixture:DependencyB",
            "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "imageDigest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
          }
        },
        "platform": {
          "os": "linux",
          "hostFingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "evidenceRevision": "fixture-generation-0",
        "commands": [
          {
            "command": "node --version",
            "status": "passed",
            "exitCode": 0
          },
          {
            "command": "test -f verification.json",
            "status": "passed",
            "exitCode": 0
          }
        ],
        "authorities": {
          "protectedIntegration": {
            "principal": "fixture-owned-integrator",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "statusWriter": {
            "principal": "fixture-owned-verifier",
            "policySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "hostStatus": "ready"
      }
    ]
  }
}
```
