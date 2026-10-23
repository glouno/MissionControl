# Native-agent comparison kit v1

This dependency-free checkout tool prepares two disposable Node/Git repositories,
checks exact results independently, executes only explicitly requested external
adapters, and writes private JSON reports. No live comparison has been performed.
All four delivered live matrix entries remain **pending**. Synthetic evidence tests
the kit and cannot establish agent performance. Linear can serve as a coordination
frontend for prompts, assignments, links and human decisions; execution authority,
qualification, repository acceptance and measurement belong to the controller.
No supplied documentation establishes a Linear integration or vendor capability.

## Exact commands

Run from this checkout with Node 24 and Git. No install is necessary for the CLI;
Node strips the supporting TypeScript. `mc-check` builds and discovers
`src/evaluation.test.ts` through the existing test glob.

```sh
node scripts/evaluate-agents.mjs self-verify
node scripts/evaluate-agents.mjs prepare inventory /private/evaluation/inventory-001
node scripts/evaluate-agents.mjs prepare csv /private/evaluation/csv-001
node scripts/evaluate-agents.mjs validate-config /private/evaluation/codex-adapter.json
node scripts/evaluate-agents.mjs run /private/evaluation/codex-adapter.json /private/evaluation/inventory-001 --operator-requested
node scripts/evaluate-agents.mjs report /private/evaluation/comparison-001.json /private/evaluation/inventory-001 /private/evaluation/csv-001
node scripts/evaluate-agents.mjs report /private/evaluation/pending-001.json
mc-check
```

Create the private parent directory yourself before preparation. Each preparation
requires a **new** directory; it never overwrites a run. Use distinct directories
for each fixture/adapter/repetition and alternate execution order for eventual
live comparisons. Compare the same fixture across adapters, not inventory against
CSV. Run reporting again with a new report filename after failures or cancellation.
Reset means prepare a fresh directory, retaining the prior manifest and repository;
there is no destructive reset or automatic retry command. A second explicitly
requested attempt is possible only if the originally configured maxAttempts permits
it and accounting admission passes. It continues the existing candidate, records
history and is not a fresh sample. Do not edit manifests to replenish budgets.
SIGINT/SIGTERM cancels the active process group and retains partial evidence.
A controller crash leaves an interrupted attempt and active.lock: retain that run,
verify external resources are stopped privately, and prepare a new run. Do not clear
locks or overwrite evidence to reuse admission. Retained run directories are trusted
controller state and must never be mounted writable into an agent.

## Fixtures and trusted acceptance

Fixture definitions, prompts, expected values and synthetic reference solutions are
repository-owned constants in `src/evaluation.ts`. Embedding these avoids changing
the publication inventory, which excludes nested fixture assets. Only the starting
module, TASK.md and package.json enter each task repository. Preparation disables
ambient Git config/templates, uses a fixed commit identity/date and clears index
stat cache fields. The pinned trees are:

| Fixture      | Starting Git tree                          | Permitted change |
| ------------ | ------------------------------------------ | ---------------- |
| inventory v1 | `37ba7dd1f9433af0491103b82342a6be067f1355` | reservation.mjs  |
| csv v1       | `dfede0bef930b99e3ae83d80708fda3ebb3ac704` | normalize.mjs    |

Inventory fixes equal-to-availability reservations and invalid-input rejection,
including exhaustive small boundaries and safe-integer cases. CSV implements a
pure parser with quoting, CRLF, trimming, sorted keys, preserved row order,
string values and explicit invalid-input errors. TASK.md gives the full contract.
Fixture hashes bind the prompt, files, version and independent exact-result cases.

Acceptance snapshots the whole repository including Git metadata, directory/file
modes and file hashes. It rejects added/deleted files, symlinks, hardlinks, altered
Git/checker/instruction/package files and changes outside the single permitted module.
Reading Git metadata avoids invoking agent-controlled hooks/config. A bounded source
copy is parsed, linked and evaluated as its original ES module in fresh VM contexts
in a session-free Node permission process. Imports are forbidden and the actual
named export is required; source declarations are never rewritten into scripts.
Node 24 uses the explicit `--experimental-vm-modules` flag for this checker.
Expected results stay in the parent. Host objects never enter the VM and dynamic
code generation is disabled. A serializer in the trusted checker process encodes
only own JSON data properties, rejects accessors and checks every object with
`node:util` `types.isProxy` before reflection, including nested and revoked proxies.
It never invokes candidate `toJSON` hooks, including hooks on Object.prototype.
The checker has 25 ms per VM evaluation, a 10 second process deadline,
64 KiB output, 32 KiB source, 512 repository entries, depth 12 and 4 MiB inventory
with 64 KiB per file. Changes during checking are rejected. This verifies the finite
fixture suite, not all possible implementations; independent review still matters.
VM/Node permissions are defense in depth, **not an OS security boundary**. External
live adapters must own reviewed OS isolation that mounts only repo writable, denies
controller/kit/evidence access and unrelated secrets, disables ambient integrations,
controls network and kills/reaps escaped descendants. The local runner cannot enforce
container teardown or prevent a deliberately escaping executable. Such unverified
isolation is not admissible for a live performance claim.

## Executable contract v1

Operators supply a reviewed absolute executable path, version identifiers and
external dedicated authentication. This kit installs no vendor code, probes no
login/version commands, copies no auth, and offers no default executable or provider.
The process receives no arguments and one JSON request line on stdin. Its cwd is
repo. Environment contains only PATH and LANG; environment **values** are never
recorded. PATH must reference reviewed tools. Wrappers provision external auth and
isolation without passing secrets in arguments, protocol events or output. Executable
bytes are SHA-256 recorded (bounded at 16 MiB); declared wrapper/native versions and
wrapper revision are operator assertions checked against the hello event, not vendor
attestations. Symlink executables are refused; select the canonical reviewed file.

Example **contract requirements**, not runnable vendor CLI flag examples:

```json
{
  "schemaVersion": 1,
  "identity": "codex-native",
  "executable": "/private/reviewed-adapters/codex-wrapper",
  "executableVersion": "operator-pinned-wrapper-version",
  "nativeVersion": "operator-pinned-codex-version",
  "wrapperRevision": "operator-reviewed-source-revision",
  "evidence": "live",
  "settings": {
    "model": "operator-admitted-model",
    "reasoning": "medium",
    "authentication": "subscription",
    "billing": "subscription",
    "permissions": "repo-write-no-controller-access",
    "isolation": "reviewed-image-sha256-identifier",
    "environment": "reviewed-policy-and-platform-identifier"
  },
  "budget": {
    "timeoutMs": 300000,
    "maxAttempts": 1,
    "maxRestarts": 0,
    "maxOutputBytes": 1048576,
    "maxReportedTokens": 100000,
    "maxReportedCostUsd": 5
  }
}
```

Authentication/billing pairs are subscription/subscription, api/metered or none/none
(synthetic). Labels must be bounded non-secret identifiers, never account identifiers,
URLs with credentials or private configuration dumps. The request contains
schemaVersion, type=request, attempt, identity, repository, prompt, permittedChanges,
fixture{id,hash,startTree,startCommit}, settings and budget. It contains no checker
source, acceptance values or controller state path. The adapter must honor all budgets,
stop/reap its isolation on EOF/cancellation and emit NDJSON on stdout. Stderr counts
against the same output cap and is discarded. No raw output is retained: bounded
byte count/hash, validated numeric fields and fixed error categories survive. Arbitrary
logs or unknown protocol fields are rejected, not copied into evidence.

Every event has schemaVersion=1, seq (integer, starting at 0 without gaps), and type.
Exactly one hello is first and one result is last. At most 128 events are accepted;
wrappers must coalesce cumulative measurements to fit this limit. Supported event payloads are:

| Type         | Additional fields                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| hello        | identity, effectiveSettings (all requested setting keys), supportedSettings (array of recognized keys), executableVersion, nativeVersion |
| measurement  | metrics (any subset of metric keys), costBasis                                                                                           |
| intervention | none; one event per human intervention                                                                                                   |
| restart      | none; one event per internal native restart                                                                                              |
| result       | outcome: completed, failed or cancelled                                                                                                  |

Identity meanings are fixed. `codex-native` invokes the native Codex executable.
`missioncontrol-codex-native` preserves that native session through MissionControl's
isolated lifecycle. `openhands-acp-codex` requires the operator to prove ACP transport
preserves the native Codex execution/session/settings. `openhands-sdk-model-loop`
identifies OpenHands' separate built-in SDK/model loop; it is a different execution
family and is never pooled with native results. No supplied OpenHands docs establish
actual ACP availability, flags, version support, billing or native fidelity: those
vendor details remain **unverified**. Switching identity to conceal another loop is
invalid. Wrappers must emit effective settings and mark unsupported requests honestly.
Any mismatch or unsupported capability excludes the attempt from conclusions.

Metrics are agentMs, controllerMs, checkMs, reviewMs, inputTokens, outputTokens,
cacheReadTokens, cacheWriteTokens, totalTokens and costUsd. Each quantity is
`{"value":12,"provenance":"measured"}` or estimated/synthetic; unknown is exactly
`{"value":null,"provenance":"unknown"}`. Measurements are cumulative per attempt,
nondecreasing with stable provenance; absent counters stay unknown. Cache counters
may overlap input usage: never sum them into tokens. Do not infer totalTokens from
incomplete counters. Each measurement includes costBasis: provider-receipt,
published-rate-estimate, subscription-included, unknown or synthetic. Measured cost
requires a provider receipt; estimated cost requires published-rate-estimate.
Subscription dollars are always unknown, never zero. Rate/receipt references must be
retained externally for review; this contract records provenance, not receipt secrets.

## Budgets, recovery and comparisons

Defaults are **300 seconds, one attempt, zero automatic/internal restarts and 1 MiB
combined output**. Config may reduce these or explicitly admit at most three attempts,
two internal restarts, 1,000,000 reported tokens and $100 reported metered cost; time
and output cannot exceed defaults. Restarts are reported events and consume one
run-wide allowance across all attempts. Each request's budget.maxRestarts is the
remaining allowance; the manifest retains the original run budget. Exceeding that
remainder kills the wrapper and excludes the attempt. Reports independently reject
over-budget histories even if attempt flags omit the violation. The kit never
starts an automatic restart.
The deadline kills the local process group; external wrappers must enforce equivalent
provider/container cancellation and report their actual cancellation outcome.

Default reported limits are 100,000 total tokens and $5 metered cost for the run.
They inspect cumulative receipts after execution and block future admission at the
limit or when usage/cost is missing (estimated cost is insufficient for metered
readmission). Checkpoint receipts after timeout, forced cancellation, malformed output,
nonzero process exit or controller interruption remain partial lower bounds, even
when numeric totals are present. They block readmission. A valid terminal result and
clean process exit are required for final accounting; a clean terminal task failure
may permit a requested continuation. There is no reconciliation command in v1:
retain unresolved evidence, reconcile provider usage externally and obtain separate
operator admission before preparing further work. Fresh preparation does not resolve
uncertain usage or authorize additional spending.
They **cannot enforce provider billing ceilings**, stop already billed
inference or bound an external subscription's total spend. Provider limits require
separate external policy. No permission or billing exception is inferred here.

Manifests retain source revision and kit content hash, fixture hash/tree/commit,
requested settings and budgets, executable hash and declared versions, Node/Git/
platform/architecture, attempts, restarts, interventions, cancellation/failure status,
partial cumulative measurements and independent candidate acceptance. Durable start
records consume admission before launch; each valid event checkpoints partial usage.
A hard controller crash may lose elapsed/output counters since the last event; they
remain unknown/partial rather than invented totals. Protect controller evidence from
agents and do not hand-edit it. Reports consume only bounded trusted manifests.

Observed wallMs covers adapter launch through closure. checkWallMs is separately
measured by the kit; adapter controller/check/review overhead stays in its own metrics
and is not subtracted unless supplied. Summaries aggregate attempt histories without
turning missing quantities into zero and mark incomplete usage. Failed, rejected,
synthetic, unsupported or mismatched runs are excluded. Comparable observations require
matching fixture, source, budgets, model/reasoning/auth/billing/permissions/isolation/
environment and measured total tokens/agent time. SDK/native families cannot compare.
Unknown cost cannot establish a cost advantage. No ranking is generated; repeated,
matched live samples and independent receipt/isolation review are required.

## Pending live matrix and MissionControl gate

| Path                                       | Delivered live state | Blocking evidence                                         |
| ------------------------------------------ | -------------------- | --------------------------------------------------------- |
| Native Codex                               | pending              | No authorized live adapter run or reviewed receipts       |
| MissionControl native Codex                | pending              | Exact-runtime private admission qualification             |
| OpenHands ACP Codex                        | pending              | Vendor capability/native fidelity unverified; no live run |
| OpenHands SDK/model loop (separate family) | pending              | Vendor details unverified; no live run                    |

[Subscription qualification](subscriptions.md) is the supplied authority. Admission
requires private operator-reviewed receipts bound to implementation, immutable image,
auth policy, provider/model, platform and architecture, with expiry no more than 30
days. Gates cover login/restart, refresh/expiry, network denial, native policy, bounded
coding, independent check/review and controller lifecycle. A config qualified=true,
synthetic proof, unlocked store or unrelated live result cannot qualify execution.
This standalone kit refuses MissionControl live subscription execution outright; it
cannot validate private state or replace that gate. A future qualified controller
integration requires separate admission work. Unavailable paths remain pending;
never substitute paid API execution or host fallback to manufacture a comparison.

## Evidence-based OpenHands adoption rubric

Score each criterion 0 (unverified), 1 (documented only), 2 (independently reproduced
on the pinned runtime). Require 2 on fidelity, isolation and recovery, no unresolved
licensing restrictions, and repeated matched fixture results before adopting a path.
These are evaluation requirements, not assertions about OpenHands features.

| Criterion           | Required evidence                                                                                                            | Supplied evidence/state                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| ACP/native fidelity | Pinned ACP/native versions, session ownership, tool/settings traces, honest unsupported flags and identical native semantics | OpenHands details unverified                                                           |
| Isolation           | Repo-only writable mount, separate trusted checks, credential/network denial and teardown proof                              | MissionControl constraints documented in subscriptions.md; OpenHands unverified        |
| Recovery            | Timeout, cancellation, crash, session restart and unknown-usage retention without duplicate billing                          | Kit synthetic cases; live OpenHands unverified                                         |
| Observability       | Receipts, available cache counters, attempt lineage, separate controller/check/review overhead                               | Contract implemented; vendor counters unverified                                       |
| Integration effort  | Reviewed adapter source, ACP mapping, authentication ownership, measured implementation/operator effort                      | No external adapter delivered; unverified                                              |
| Maintenance         | Upgrade tests, pinned dependency/native releases, requalification policy and named owner                                     | Required; OpenHands release policy unverified                                          |
| Licensing           | Exact OpenHands/SDK/ACP/native components and redistribution/service obligations reviewed                                    | OpenHands licenses unverified; MissionControl AGPL-3.0-only documented in licensing.md |

No public network lookup or vendor installation informed this kit. Supplied docs do
not establish OpenHands or Linear release-specific features or licensing. Review
those missing materials externally before changing scores. The kit adds no dependencies,
changes no lockfile or worker image, and needs no image rebuild for offline checks.
Live isolated wrappers/images remain external operator prerequisites, not qualified
or distributed artifacts of this candidate.
