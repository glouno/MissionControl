# Native Vertex Gemini (review candidate)

Vertex uses the existing controller-owned portable tool loop and isolated worker
image. It does not invoke a vendor CLI. This implementation is locally tested;
live MissionControl qualification and credit attribution remain separate gates.
No credentials, configuration activation, cloud provisioning or live calls are
part of installation or the fixture checks. The initial exact model is
`gemini-4-argon`, location `global`, REST `v1beta1`. Verify those settings and
thinking levels against the test project's current model access before qualification.
Regional models and alternate model names are rejected in this initial provider.

## Operator setup (private configuration only)

Use a dedicated test project and controller identity. Independently enable Vertex
and billing, review IAM and restricted credit eligibility through your normal
cloud change process. This code never enables services, creates keys, changes IAM
or discovers credentials. Do not migrate a personal Mac credential store to WSL.
Prepare a dedicated Google authorized-user ADC file in the controller's
`secretsDir`, mode 0600, with `type`, `client_id`, `client_secret`, `refresh_token`
and an explicit matching `quota_project_id`. General home ADC, metadata servers,
service account JSON private keys and ambient environment discovery are unsupported.
Refresh occurs automatically through the fixed OAuth endpoint when the cached
access token has less than 60 seconds remaining. No authentication runs during
configuration validation. Revoked/expired refresh grants require the operator to
reauthenticate this dedicated ADC; failures give sanitized reauth/IAM guidance.

Direct ADC needs only permission to invoke the admitted model (normally
`aiplatform.endpoints.predict`, via a narrowly scoped custom role or reviewed
Vertex AI User role), and `serviceusage.services.use` on the quota project.
Optional `impersonateServiceAccount` uses this same dedicated ADC as its source;
the source needs `iam.serviceAccounts.getAccessToken` on only that approved
service account. The target needs inference and quota permissions. Token Creator
is broader than the single permission and should be evaluated accordingly. Do not
assign Owner/Editor. IAM/API changes require separate operator authorization.

A private provider entry selects `backend.kind: "vertex"` and an
`executionContract` with `provider: "vertex"`, `harness: "tool-loop"`,
`execution: "isolated"`, `authentication: {"kind":"controller",
"reference":"vertex-test"}` and a positive metered usage policy. Its ID must be
`vertex-test`; use any private ID consistently. The host's
`isolatedRuntime.providers["vertex-test"]` contains:

```json
{
  "protocol": "tool-loop",
  "backend": {
    "kind": "vertex",
    "project": "operator-test-project",
    "quotaProject": "operator-quota-project",
    "location": "global",
    "model": "gemini-4-argon",
    "thinkingLevel": "low",
    "stream": true,
    "maxInputTokens": 8192,
    "maxOutputTokens": 1024,
    "maxRequestCostUsd": 0.05,
    "pricing": []
  },
  "authentication": {
    "kind": "google-adc",
    "reference": { "kind": "file", "path": "dedicated-vertex-adc.json" },
    "egressHosts": ["oauth2.googleapis.com", "aiplatform.googleapis.com"]
  }
}
```

The empty pricing array deliberately cannot validate. Populate it privately with
reviewed current prices before using this example. Each entry requires `version`,
`currency: "USD"`, ISO UTC `effectiveFrom` and exclusive `effectiveUntil`,
`inputUsdPerMillion`, `cachedInputUsdPerMillion`, `outputUsdPerMillion`,
`thinkingUsdPerMillion` and `evidenceUrl`. No default/free/promotional prices are
supplied. Versions must be unique and effective intervals cannot overlap. Set
finite review/expiry dates; a missing effective price refuses dispatch. Keep the
exact same backend in the provider and runtime definitions. Pricing changes
require a new admitted runtime binding; retained usage pins its pricing version.
With impersonation add `iamcredentials.googleapis.com` to `egressHosts`.
These are the only permitted fixed controller HTTPS endpoints; redirects are
rejected. Workers receive no cloud environment or credential mount and have no
inference network. Apply additional controller firewall policy separately.

Configure explicit positive `authority.maxTotalAdmittedCostUsd`,
`authority.maxGoalCostUsd`, `authority.maxConcurrentMeteredRuns`, allowed provider
ID and isolated execution mode. Vertex requires the spending and concurrency caps;
existing installations/providers retain their previous defaults. Pin a reviewed
worker digest and required verification commands as for Azure. `config validate`
stages configuration without activation. Offline apply/restart and enabling a
project are separate deliberate operator actions after qualification; this change
does not perform them. See [configuration](configuration.md).

## Bounds, state and accounting

Every request reserves the worst cost of the full configured input limit and
combined output/thinking limit across the admitted price schedule, inside its
already atomic run reservation. This can be intentionally conservative. Request
JSON (including tool schemas and native state) is bounded in UTF-8 bytes by the
input token allowance; only text/JSON is supported. Set a run estimate large
enough for the tiny planned cycle while respecting the approved total budget.
Output has a 32 MiB stream bound, 1 MiB event/part bound, 4096 parts and 64 function
calls per response. The existing loop allows at most 40 turns. Vertex preserves
model parts and thought signatures in private continuation state; it does not
summarize away signature-bearing turns. Context exhaustion refuses further calls.
Native reasoning text is not included in the visible answer. Stream and single
JSON response modes share validation. Function responses carry the admitted
function name and provider call ID when present.
Human handoffs retain the entire signed assistant turn and a function response
for each call. Tools after the handoff receive an explicit deferred response and
are not executed; the resumed model must reconsider them using the controller's
recorded answer in the continuation prompt. Measured handoff cost is checkpointed.

Prompt counts include cached input; bill uncached prompt as `prompt - cached`.
Bill cache once at its rate, visible candidate output once and thinking once.
`outputTokens` is candidates plus thinking; `thinkingTokens` and
`cachedInputTokens` are subsets, never extra totals. Stream usage snapshots are
cumulative and replace earlier snapshots. A STOP response with only an earlier
usage snapshot retains unknown billing. Final usage must arrive with STOP or
afterwards; nonempty output or thinking cannot have a zero count in its
corresponding final token category. Inconsistent/missing usage, malformed
responses, non-STOP completion or truncation leave the whole run reservation
unresolved. A provider request may have been billed even on a network/5xx failure.
Inference POST retry count is **zero**, including throttling and 5xx; recovery must
reconcile uncertain usage and reserve a new attempt explicitly. OAuth refresh is
one bounded request and optional impersonation one more; neither retries.

The same deadline/cancellation signal covers auth, HTTP reading and isolated
shell execution. Cancellation closes readers and stops worker execution; checks
at invocation entry, before OAuth, impersonation, inference and each tool, and
before accepting tokens, results or successful completion revalidate controller
authority and the absolute deadline. Already-expired invocations abort
synchronously, independent of timer delivery. Authentication receives the
invocation-specific controller fence, including cached-token acceptance and the
OAuth-to-impersonation boundary; fence failures retain their original reason.
The isolated loop also checks controller authority every 25 ms to abort active
auth, HTTP and tools without waiting for a scheduler tick. Event-loop delays can
delay that active-operation abort; synchronous authority checks still fence every
new inference/tool dispatch. A completed response is revalidated before the loop
accepts it or starts the next tool. Invocation deadlines use the same signal.
Cancellation does
not undo billing or side effects. Installation cumulative admission never refunds
old goals, and the atomic run capacity cap covers planners, workers and reviewers.
Stopped coding with a final measured result no longer occupies a concurrency
slot while awaiting review, but its spending reservation remains held until
acceptance or release. Recorded live execution/gateway resources, interim
checkpoints and unknown final usage continue to block that capacity handoff.
Coding inference is refused after verification starts; review uses its own active
controller operation reservation and deadline.
Unknown reservations remain held until evidence-backed reconciliation; replaying
settlement cannot make an unknown request free or double-charge reconciled usage.

Inspect `reliability diagnostics --goal-id <id>` (CLI) or
`GET /api/v1/inference-diagnostics?goalId=<id>` for model/version, project/location,
quota project, thinking level, request IDs, pricing version, token categories,
provider cost and sanitized auth errors. Dashboard state includes these diagnostics;
goal detail/attempts show estimated cost, reserved and unresolved dollars. No token,
ADC material, arbitrary provider error body or thought text enters diagnostics.
Thought signatures remain only in private continuation state. Ledger cost is a
provider estimate; later invoice and promotional-credit attribution are separate.
Cloud billing export delays and restricted credits never justify releasing holds
or admitting free work. GCP budget alerts are notifications, not a hard cap.

## Separate real-provider qualification gate

Do not run live calls as part of repository verification. Obtain explicit operator
approval for a dedicated test runtime/project and a maximum **USD5 qualification
budget**, with request and run ceilings that fit inside it. Implementation
admission remains separate, capped at USD45; preserve previous unresolved holds.
If current reviewed prices make this procedure exceed the tiny budget, stop and
request a revised bounded gate. Do not widen budgets automatically.

1. Record candidate commit, pinned image, sanitized project/model/location,
   auth mode, pricing version/effective dates and approved budget privately.
   Validate disabled configuration and least privilege; never record tokens.
2. Enable only the dedicated test runtime via a separately authorized operator
   action. Admit a tiny reviewed task that calls `read_file` on a harmless fixture,
   returns its function result and completes in the next turn. Use low thinking,
   small output/input bounds, one worker and explicit required checks.
3. Read back both request diagnostics and attempt ledger: modelVersion/request
   IDs, prompt/cache/candidate/thinking counts, combined output, cost and holds.
   Check cumulative stream snapshots did not double-charge. Stop on unknown usage.
4. Under the remaining approved budget admit a second tiny invocation; cancel
   during streaming. Verify HTTP/tool termination, no subsequent dispatch and
   an unresolved conservative hold for any possibly billed request. Retain
   evidence and reconcile only with supported operator evidence, never a guess.
5. Disable the test project after observation using normal operator control.
   Retain receipts privately. Report local fixtures, real-provider tool/cancel
   qualification and later credit/invoice attribution as three separate outcomes.

The previously reported direct authenticated inference success establishes only
model reachability. It does not qualify MissionControl, establish the pricing
schedule or prove any restricted promotional credits applied. Production readiness
and independent exact-candidate review remain pending until their separate gates
pass. No automatic merge, publish, deploy or production enablement is authorized.
