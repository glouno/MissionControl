# Direct live Vertex review and repair

On 2026-10-21 the operator authenticated a dedicated WSL authorized-user ADC for
the existing test project. OAuth refresh, project access, inference and quota
permissions, and enabled Vertex service were verified. Billing-account inspection
was unavailable to this identity; live authenticated inference returned HTTP 200.
No API key, IAM change or service enablement was required.

Live streaming revealed an incompatibility absent from the synthetic fixtures:
an interim `usageMetadata` object contained only `trafficType`. The provider now
accepts metadata-only chunks, while any token-bearing snapshot must validate in
full and final token evidence remains mandatory. The current Argon guide also
rejects `candidate_count`; the request now omits `candidateCount`. Regression
coverage uses the observed signed-call/metadata-only/STOP shape and refuses
metadata-only or partial final usage.

The repaired actual VertexProvider and IsolatedPortableTools passed a direct
live Docker qualification: one harmless `read_file` call, signed native history
and matching function response, then the expected final file contents. The
worker had network `none` and no Google credential mount. Two requests reported
460 prompt and 37 candidate tokens total, with zero cached/thinking tokens;
the estimate at full global input/output rates was USD0.00258. A separate live
stream was cancelled after its first output event: the request signal aborted,
no later inference or tool ran, and its USD0.073728 conservative request hold
remains unresolved. All test containers were reset and removed.

Five inference POSTs in total include two pre-repair diagnostic failures. The
private test journal retains those two holds and the cancelled-request hold;
settled estimates plus unresolved upper bounds total USD0.223764, below the
approved USD5 cap. No POST was automatically retried. This journal is separate
from the installed mission ledger, whose earlier holds were preserved.
The dependency worker image was rebuilt locally with SDK 1.32.1; its image ID is
`sha256:fa7023a47a1362e070affa10bce7a1bb58e6f24b0ff988330c67e70e2fc70c03`.
The direct harness used the actual provider and Docker tool adapter, not the
installed scheduler, full IsolatedBackend import path or an automated mission.
Production runtime activation and invoice/credit attribution remain untested.

Post-repair typecheck, all 453 Node tests (89 focused Vertex/adapter tests), status,
privacy, package, dependency and history checks passed. Earlier deterministic
controller-ledger and outer-cleanup coverage remains part of this suite.

# Direct cleanup repair after MissionControl review

The preserved candidate `088822e02c260c997357b463d72378b2ed80805f` was rejected
by independent review: failing final teardown could discard measured Vertex usage
and mask controller revocation. The direct repair on
`fix/vertex-cleanup-accounting-20261021` retains measured cost, token counters and
session identity on cleanup errors whether or not cancellation has fired. It
checks invocation authority synchronously on the cleanup-failure path; revocation,
cancellation or deadline expiry stays the primary error, with cleanup failure
attached separately. Failed cleanup retains the session for inspected recovery.

Full direct verification also found new high-severity advisories in the unchanged
MCP SDK 1.31.0 pin (the same audit fails on main). This candidate updates only
`@modelcontextprotocol/sdk` to 1.32.1; the production dependency audit then reports
zero vulnerabilities. Its lockfile now differs from the historical worker image,
so deployment or renewed MissionControl execution requires rebuilding and
qualifying that image. Existing installed services are unchanged.

The exact real Vertex provider and existing isolated tool fixture reproduce two
inference calls plus a tool response. Additional cases cover failing reset alone,
reset plus lease revocation, original authority revocation, deadline expiry and
cancellation. The failures reproduced against the preserved candidate; all eleven
completion-boundary cases pass with the repair. No live GCP calls, credentials,
installed-runtime changes or new MissionControl job were used for this repair.
Final direct Linux verification passed all eight required gates: typecheck,
452 Node tests, eight Python status tests, privacy, package, zero-vulnerability
dependency audit, history audit and eleven Rust Matrix tests. No tests failed
or were skipped. These are deterministic source checks; live Vertex qualification
and independent acceptance remain separate. Historical worker evidence follows; its pending-review wording
is historical and does not imply this direct repair has independent acceptance.

# GCP-VERTEX-01 candidate evidence

Review branch: `review/gcp-vertex-01-boundary-repair`, admitted base
`cdec977b85c489262907ad6c2c1766916c5b592d`. The supplied exact private source is
authoritative in this workspace; no Git remote is configured and controller host
directories are not mounted. The installed `mc-check-vertex` contract compares the
pinned lockfile, runs typecheck, builds and runs all Node tests, runs the eight
Python status tests and checks whitespace. The repaired Node 24 PATH was used.
Baseline passed 379 Node tests plus the status tests and typecheck.
The continuation baseline at `f90a3aedc5ee4685bc36cfd6e08f1b5f3f49de4d`
passed 407 Node tests, eight status tests and typecheck before repair.

This continuation repairs the controller review's three blocking findings:
completed coding no longer blocks review at concurrency one after a final measured
result and stopped resources, while its dollar reservation stays retained;
human handoff checkpoints preserve signed native calls and completed/deferred
function responses; and streamed settlement requires final cumulative usage at
or after STOP. Nonempty output/thinking with zero corresponding final tokens and
decreasing cached counters also fail conservatively. Runtime authority refuses
further coding inference after verification starts and requires an active review
operation reservation. Regression fixtures cover parallel review admission,
retained coding dollars, live/unknown resource fences, signature-bearing handoff
resume, and stale/missing final counters. These are local synthetic evidence.
The repaired candidate passed the authoritative `mc-check-vertex`: typecheck,
414 Node tests, eight Python status tests, pinned lockfile comparison and whitespace
checks. No tests were skipped. Exact-candidate controller review remains pending.

The next continuation starts at `2a7c99912a7c11f4acaf008178501fe13218dd15`
and repairs the blocking controller cancellation finding: the trusted isolated
authority callback now reaches Vertex inference, is revalidated immediately before
POST after authentication, and fences acceptance of a completed response. The
isolated invocation watches authority every 25 ms and aborts the shared auth,
HTTP/reader and tool signal on revocation, independently of scheduler ticks.
Fixtures use ControlStore and IsolatedPortableTools with a still-live parent
signal to cover cancellation during returning/pending auth, active HTTP, a partial
stream and isolated tool execution, plus pause, stale generation and deadline.
They assert zero subsequent dispatch, terminated active operations, accurate
dispatch diagnostics and retained spending reservations. These remain synthetic
local evidence. This continuation passed the authoritative `mc-check-vertex`:
typecheck, 423 Node tests, eight Python status tests, pinned lockfile comparison
and whitespace checks, with no skipped tests. The initial baseline invocation
was invalidated by an overlapping local build removing `dist` test files; the
final full check ran sequentially and passed. Controller independent review of
the returned exact commit is still pending.

Boundary recovery starts from admitted integration source
`cdec977b85c489262907ad6c2c1766916c5b592d` and recovers the allowed-path
implementation from retained checkpoint `264f8c629c4d8caa0e1a62d9e45ce3ae72720bcf`.
That checkpoint descends directly from the admitted base. Its earlier checkpoints
and evidence remain retained. Worker-reported `dc0f5560a8b3e9619683084ec7aa7b43e2ed3bab`
is unavailable and was not used. Recovery excludes the checkpoint's out-of-scope
README and OpenAPI additions; admitted integration content is preserved.

This repair addresses `finding_39505f35daec4f09889969d3ed4b2eb9` and
`finding_5e276375b62c4b2a9fabc50268a6069b`. Absolute deadlines are checked
synchronously at invocation entry, each authentication/inference/tool dispatch
and acceptance, and successful completion. The per-invocation authority callback
reaches OAuth, impersonation and cached/refreshed token acceptance. Failed fences
abort the invocation signal and preserve the original authority/cancellation or
deadline failure. Timers and the authority watcher terminate pending operations;
they do not replace dispatch checks. Synthetic fixtures explicitly change the
clock and authority between stages, and deliver watcher ticks for pending auth,
HTTP and tool termination without sleep races. Possibly billed interrupted
requests retain unknown usage and their prior conservative reservations.
The admitted baseline passed 379 Node tests, typecheck and eight status tests.
The final authoritative `mc-check-vertex` passed typecheck, all 442 Node tests,
eight Python status tests, pinned lockfile comparison and whitespace checks,
with no failed, cancelled or skipped tests. The focused Vertex suite passed
62 tests before the final full run. These worker checks are synthetic implementation
evidence; independent exact-candidate review and integration remain controller phases.

Outer completion continuation retains `7bcab2138060847b79dee2e4345f581c233d7dc6`
and the earlier recovery evidence. Its pre-edit authoritative baseline passed all
442 Node tests, eight Python tests and typecheck. The outer isolated adapter now
uses the invocation fence at entry, backend result acceptance, source authority
checks and final completion after awaited reset/network cleanup. Synthetic real
VertexProvider/FakeEnvironment fixtures expire the clock or revoke either
controller authority callback immediately after reset, and confirm that no `done`
result escapes. Entry expiry dispatches no auth, inference, tools or environment
preparation. Cancellation during reset preserves its original reason and cleanup
failure evidence; interrupted success cleanup switches once to the existing
terminal allowance without renewing an exhausted terminal allowance. Known Vertex
usage remains attached to rejected completion, and uncertain cleanup retains its
session record for reconciliation. Focused Vertex/isolated adapter checks passed
83 tests. The final authoritative `mc-check-vertex` passed typecheck, all 447
Node tests, eight Python tests, pinned lockfile comparison and whitespace checks,
with no failed, cancelled or skipped tests. Independent controller review of this
exact continuation remains pending.

The candidate adds direct Vertex streaming/JSON inference to the existing isolated
controller portable loop, explicit ADC/impersonation refresh and egress, versioned
USD pricing, conservative request reservations, installation run capacity, native
signature state and sanitized usage diagnostics. No dependencies were added;
`package-lock.json` remains byte-identical to the admitted dependency artifact.
No dependency-driven image rebuild is required. All credentials and project
settings in fixtures are synthetic; actual operator setup belongs in private files.

Candidate deterministic checks are the authoritative command below. The final
implementation result records its outcome and candidate commit. Fixture checks
cover native text, cumulative streaming usage, function responses and signatures,
malformed/truncated responses, permission/throttling/5xx errors without POST
retries, automatic ADC refresh and reauth rejection, optional impersonation,
pricing date transitions, bounds, cancellation, existing isolated tool execution,
private diagnostics and atomic budget/capacity/reconciliation invariants. Existing
provider, API, dashboard, verification, recovery and status tests remain required.

```sh
export PATH=/usr/local/bin:/opt/project-venv/bin:/opt/node/bin:/usr/bin:/bin
mkdir -p .git/mc-check-tmp
python3 -c 'from pathlib import Path; Path(".git/mc-check-tmp/package.json").write_text("{}")'
TMPDIR="$PWD/.git/mc-check-tmp" mc-check-vertex
mc_check_result=$?
python3 -c 'import shutil; shutil.rmtree(".git/mc-check-tmp")'
exit "$mc_check_result"
```

These are local fixtures, including a fake isolation adapter; they do not certify
live Google protocol behavior, real Docker/model compatibility or billing. No live
GCP calls were made. The prior operator-reported direct inference success is only
reachability evidence. MissionControl tool-loop/cancellation qualification under
an explicitly approved USD5 test budget remains pending, as does later restricted
credit attribution. The USD45 implementation admission is separate; the prior
unresolved reservation must remain in the controller ledger. See
[operator procedure](vertex.md#separate-real-provider-qualification-gate).

Exact-candidate independent review is performed by MissionControl after this
committed candidate is returned. It has not been performed by the implementation
worker. Main, installed services, active jobs and private runtime configuration
remain unchanged. No push, merge, deployment or production readiness claim is made.
