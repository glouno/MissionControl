# Offline project readiness audit and operator handoff

From a built source checkout, run one command against two explicitly selected,
operator-reviewed JSON exports. Node 24 is required:

```sh
node scripts/audit-project-readiness.mjs \
  --config-export docs/fixtures/project-readiness/config.json \
  --status-export docs/fixtures/project-readiness/status.json \
  --as-of 2026-10-22T12:00:00Z --format json
```

Use `--format text` (the default) for a concise handoff. The public fixture exits
with code 1. Both formats carry the same decision; fixed inputs and `--as-of`
produce the same report, independent of project enumeration order and host
environment. Output goes only to stdout. Exit 0 means all supplied projects have
matching exported qualification evidence and no exported blockers; exit 1 means
valid export envelopes contain unqualified, disabled, unknown or blocked projects;
exit 2 means missing/unreadable/malformed exports, invalid arguments/version or
conflicting project IDs. Invalid exports produce fixed error codes, never raw
input, file paths or exception messages. A schema-invalid project has its own
`schemaValid: false` and exits 1; envelope validity remains separate.

The command reads at most 1 MiB from each of two regular, non-symlink files.
It rejects FIFOs, missing files, duplicate/unknown flags and oversize inputs.
JSON must be valid UTF-8, with no duplicate object keys (including escaped
equivalents) or `__proto__` keys, at most 32 nesting levels and 20,000 tokens.
These parser bounds reuse the offline project qualification parser.
It does not discover installations, follow references in JSON, read stdin,
contact networks, run subprocesses, access private state, inspect host tools,
load configuration directories, inspect images, or mutate configuration/state.
It imports existing schema modules and the subscription gate constants without
calling their host/private inspection functions. Building and tests are separate
repository development operations. The command is a source-checkout script;
the current installed-package inventory does not ship it or these fixtures.

## Version 1 input contract

The normative schemas and bounds are in `src/projectReadiness.ts`. The fixture
pair is a complete minimal example. Objects are strict: unknown fields fail the
export envelope; required nullable fields must be present, using JSON `null`
for unavailable private values. Never substitute a guessed digest or a readiness
boolean for unavailable facts. No credentials, sessions, private prompt/context
contents, raw doctor outputs, private receipts or log contents belong in exports.
Operator preparation must select only safe labels and hashes. Labels allow a
bounded ASCII vocabulary without control characters, query strings or shell
metacharacters. The tool cannot detect a credential disguised as an ordinary
label: review exports privately before sharing a report.

`project-readiness-config` has `schemaVersion: 1`, UTC `exportedAt`, and 1–100
unique projects. Each entry has `id`, `project`, `providerEnabled` (boolean/null)
and `requirements`. `project` is the project-file shape from `src/config.ts`,
with its effective, resolved config defaults copied into `config` by the
operator. It is validated with `projectFileSchema` independently of enablement.
Do not include provider credential objects or private configuration contents.
Config validation alone does not supply this effective project snapshot.

Requirements contain:

- Sanitized repository identity, target branch, exact 40/64-digit base commit;
  these must match the configured repository contract and target branch.
- Required checks (1–30 for qualification), selected context IDs and SHA-256
  hashes (1–40 for qualification). Check names match project policy;
  verification commands must be configured. No commands are executed here.
- Project snapshot, config, runtime and installed implementation SHA-256 fingerprints; provider
  ID, exact model, execution contract, runtime protocol/model/auth reference,
  authentication-policy SHA-256, immutable execution and verification
  `sha256:` image IDs, platform (`linux`/`darwin`) and architecture (`x64`/`arm64`).

`projectHash` is the canonical SHA-256 of the supplied `project` object excluding the
`enabled` admission switch (`projectSnapshotHash`); it must
match and binds verification commands and effective limits as well as policy.
Include all five effective execution limits; missing or widened limits block
qualification using existing `validateExecutionLimits`.

Use existing effective project/execution semantics; validation of the backend
against the execution contract reuses `validateBackendContract`. Runtime auth
reference/model must agree with the contract/model. Image tags such as `latest`
are not acceptable image IDs. A verification environment name is insufficient
without its actual immutable image. Keep selected context array order stable;
IDs must be unique and missing hashes block qualification.

`project-readiness-status` has `schemaVersion: 1`, UTC `exportedAt`, and up to
100 unique entries drawn from the config project IDs. An omitted entry is
unknown, not success. Each entry contains `requirementsHash`, `reportedReady`,
`paused`, `unknownUsageHold`, `hostPolicyAllowsExecution`, `dockerAvailable`,
`executionImage`, `verificationImage`, `authPrepared`, `authWriterActive`, and
`qualification`. Every field is required and nullable. Boolean observations
must come from explicitly reviewed status/doctor evidence. `reportedReady` is
shown for context and never used to qualify execution. Preserve unknown-usage
holds and paused goals even if another interface says ready. An unknown blocker
blocks execution.

Both exports and inline evidence must be no more than 24 hours old relative to
`--as-of`; future observations fail closed. This is a deliberately conservative
offline freshness window, not a new controller admission policy. The explicit
clock permits reproducible historical audit; a historical report must never
be used as a current admission grant.

## Qualification evidence

Version 1 can verify sanitized subscription acceptance evidence only. Synthetic,
metered Azure, Bedrock, Vertex, unknown runtimes and unsupported platforms cannot
become qualified through this format; they receive explicit unsupported/unknown
gaps until a reviewed future contract supports their acceptance. This does not
change their existing controller implementation or installation policies.

`requirementsHash` is SHA-256 over the complete canonical requirements object:
sort object keys by ASCII order, preserve array order, encode JSON without
whitespace in UTF-8. `evidenceHash` is exported for operator adapters. This binds
implementation, config/runtime, repository/base, checks/context, execution and
verification images, provider/model/auth policy, platform and architecture in
one exact fingerprint. Any changed or unavailable binding prevents qualification.

A qualification object contains `schemaVersion: 1`, matching `requirementsHash`,
UTC `expiresAt`, and exactly one record for each `SUBSCRIPTION_GATES` ID from
`src/control/subscriptionQualification.ts`. Expiry must be after `--as-of` and
within 30 days, matching the existing private subscription acceptance window.
Each gate has `id`, `sha256` and inline `evidence` (or null). Its SHA-256 must
match the canonical inline object, which contains `schemaVersion: 1`, matching
`gate`, literal `passed: true`, matching `requirementsHash`, `observedAt`, and
exactly the required `assertions` for that gate:

| Gate                     | Required assertions                                      |
| ------------------------ | -------------------------------------------------------- |
| login-restart            | dedicated-login, restart-retains-login                   |
| refresh-expiry           | refresh-success, expired-auth-denied                     |
| network-denial           | unapproved-egress-denied                                 |
| native-policy            | native-policy-enforced                                   |
| bounded-coding           | bounded-candidate-produced                               |
| independent-check-review | exact-candidate-checks-passed, independent-review-passed |
| controller-lifecycle     | controller-restart-recovery, unknown-usage-fenced        |

The operator must produce these sanitized evidence summaries only after reviewing
the actual private gate artifacts and exact receipt bindings. This format does
not replace the private receipt (`receipt.json` with evidence-file hashes), does
not read its referenced files, and does not sign or independently authenticate
operator assertions. Hash agreement proves consistency of the supplied export,
not the truth of the operator's statements. Unsupported, missing, stale,
duplicated, mismatched or unavailable inline evidence cannot qualify. The private
controller must still run its own admission/receipt checks. `executionQualified`
means evidence-backed qualification _within the supplied export_, never an
execution authorization or independent native/live acceptance result.

Schema validity, project/provider enablement, `executionQualified`, and
`executionBlockers` are independent fields. A valid disabled project can have
matching exported qualification but remain blocked. An active auth writer can
block a still-qualified receipt, consistent with `doctor`. Qualification gaps
are exact sorted codes; blockers include those gaps plus disabled states,
paused work, unknown usage, host policy, Docker and authentication conditions.
All required facts, including null values, appear in machine-readable reports.

## Obtaining compatible exports

Export creation is an explicit private operator activity. Existing interfaces
have different shapes and privileges; none directly emits this versioned pair.
Capture their results privately, then manually select/map facts into the strict
contract (or use an operator-maintained private adapter). Do not pass raw output
directly to the audit or assume an automatic collector exists.

```sh
node /installed/MissionControl/dist/cli.js --config-dir /private/config config validate
node /installed/MissionControl/dist/cli.js --config-dir /private/config doctor
node /installed/MissionControl/dist/cli.js --config-dir /private/config project readiness
missioncontrol status --host local --config-dir /private/config --state-dir /private/state --json
```

`config validate` returns `{valid, hash, projects, connectors}`; it validates
references even for disabled projects but supplies no qualification proof.
Copy reviewed effective project facts from the private configuration/profile and
provider contract, host runtime, selected prompt/context fingerprints and exact
repository evidence. `doctor` returns JSON with config hash, host platform/arch,
tool/image/auth observations and per-project faults; it explicitly inspects the
host and private auth/state and may run tool subprocesses. Run it only as an
operator-owned collection step. `project readiness` uses the authenticated
`GET /projects` interface; applied project config and informational readiness are
not exact acceptance evidence. Status uses its own explicit collector and may
perform configured discovery; review scope and normalize only paused/hold facts.
Do not run remote collection implicitly from this audit. See
[configuration](configuration.md), [status](status-cli.md) and
[subscription acceptance](subscriptions.md) for the existing interfaces.

For subscription evidence, the operator reviews dedicated private acceptance
against the exact installed `subscriptionImplementationHash`, auth-policy hash,
image, provider/model, platform/architecture and all gate artifacts. Collect
these hashes explicitly using the existing private qualification workflow;
the audit never computes installed implementation/auth hashes from the host.
Map actual private results to the bound gate summaries above. If a binding or
private artifact cannot be verified, use null and retain the gap.

## Bounded operator handoff

The public fixtures use invented repositories and requirements. They contain no
installation snapshot or real project identities. Fixture results cannot qualify
actual projects; operators supply fresh, reviewed exports privately.

1. Review per-project gaps privately. Obtain fresh compatible exports only from
   the explicitly selected installation. Keep dependency lock, host authority,
   publication restrictions, disabled projects, paused goals and unknown-usage
   recovery holds intact. Preserve existing paused work and disabled projects when
   installing this tool or running its tests.
2. The operator owns any private configuration editing and `config apply` after
   validation/review. This audit applies nothing and requests no policy widening.
   Confirm effective/applied hashes before taking any further action.
3. Subscription enablement belongs to the operator after private dedicated
   authentication and live subscription acceptance. Auth/billing/policy exceptions
   require a human decision; retain holds until bounded recovery is reviewed.
4. Native Mac acceptance belongs to the operator on the exact installed Mac
   release/platform/architecture. Linux tests, image installation and fixture
   success cannot substitute for it. Live subscription acceptance also remains
   separate from tooling delivery; perform no paid calls just to run this audit.
5. Rerun with fresh reviewed exports. A successful export audit still requires
   the private controller's current admission checks before explicitly launching
   new work. Independent review of this tooling candidate is controller-owned;
   no merge, publication or deployment is performed by this task.

Regression coverage runs through the existing `npm test` glob and `mc-check`.
It exercises exact evidence, disabled-valid projects, stale/conflicting/missing
exports, deterministic fixture reports, command bounds and preserved files.
