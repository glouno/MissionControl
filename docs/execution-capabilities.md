# Execution capabilities and harness restrictions

This is a bounded current-code assessment of the implementation in this source
checkout.
It uses repository source and protocol fixtures, without external calls, vendor
binaries, live comparisons or claims of Codex app feature parity. Source support
is separate from runtime readiness, private qualification and numeric limits.

The three isolated paths are paid Codex app-server through Azure Responses,
subscription Codex `exec` through a dedicated authentication runtime, and the
portable six-tool loop through Azure, Bedrock or Vertex. Controller API/MCP and
human connectors coordinate work outside these worker harnesses; their presence
does not make them worker tools. Claude native and synthetic configurations also
receive conservative status projections, but are not additional comparison targets.

## Native local execution

The `native_codex_exec` projection describes the separate local Codex runtime in
[`NativeRuntime`](../src/control/nativeRuntime.ts) and
[`codexArguments`](../src/control/nativeCodex.ts). Existing home/profile settings,
repository instructions and integrations remain enabled. Eligible coding sessions
can resume only with matching candidate and native configuration bindings.
The adapter requests noninteractive approval policy and the admitted devbox or
workspace-write sandbox; review uses a read-only sandbox.

Native worktrees coordinate writers. MissionControl adds no separate user,
credential isolation, container network or per-host egress fence. Process identity
and exposed invocation/turn/token measurements are recorded; hidden model requests
and subscription dollar charges remain unavailable. The projection requires a
matching admitted native profile and does not enable a project or prove live
qualification. Reasons contain no configured paths, identities or secrets.

## Source-linked matrix

In this table **native** means behavior requested or consumed by the adapter;
it does not establish a complete vendor feature inventory. **Policy** identifies
controller or adapter enforcement. **Gap** identifies evidence missing here.

| Capability                     | Paid Codex app-server                                                                                                                                                                                                                                                                                                                                                                                                                 | Subscription Codex exec                                                                                                                                                                                                                                                                                                                                                                                                                           | Portable execution                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools                          | Native tool loop via stdio RPC; scoped dynamic question/owner tools during coding. Complete vendor inventory is a gap. [CodexBackend](../src/control/backends.ts), [handoff tools](../src/control/workerHandoff.ts).                                                                                                                                                                                                                  | Native tools from pinned executable; complete inventory is a gap. Multi-agent, apps, plugins and skill discovery explicitly disabled. [SubscriptionNativeBackend](../src/control/subscriptionNative.ts).                                                                                                                                                                                                                                          | Six coding tools: `read_file`, `write_file`, `list_files`, `shell`, `request_human_input`, `checkpoint`; plan/review expose read/list/shell, handoffs withheld for controller operations. [PortableBackend](../src/control/backends.ts), [isolated tools](../src/control/isolatedTools.ts).                                                                                                                                            |
| Instructions and customization | Controller prompt plus native workspace translation. Provider/model/reasoning settings at CLI precedence protect runtime authority. No comprehensive disable/qualification of repository-native customization loaders; support is unverified. [nativePrompt](../src/control/nativePrompt.ts), [CodexBackend](../src/control/backends.ts).                                                                                             | Controller prompt plus schema instructions. `--ignore-user-config`, `--ignore-rules`, `project_doc_max_bytes=0`; hooks, memories, snapshots and discovery disabled. These are adapter restrictions, not proof that the vendor lacks customization. [native adapter](../src/control/subscriptionNative.ts), [clean environment](../src/control/authRuntime.ts).                                                                                    | Only controller prompts and injected manifest; no native loader. [loop](../src/control/backends.ts). All paths receive bounded explicit repository instructions, runtime instructions, admitted prompts and pinned sibling contracts; defaults are AGENTS.md/README.md. [instructionManifest](../src/control/projectContext.ts), [worker prompt](../src/control/worker.ts), [contract snapshots](../src/control/contractSnapshots.ts). |
| Integrations                   | Worker MCP/apps/plugins are not qualified or exposed through a controller integration contract. Native loading is not comprehensively established. Server tools are separately refused by gateway. [adapter](../src/control/backends.ts), [gateway](../src/control/inferenceGateway.ts).                                                                                                                                              | `mcp_servers={}`, apps/plugins disabled; web search disabled. Writable dedicated auth session makes loosening discovery particularly consequential. [native adapter](../src/control/subscriptionNative.ts), [AuthRuntime](../src/control/authRuntime.ts).                                                                                                                                                                                         | Fixed function-tool definitions, no worker MCP/app/plugin adapter. Provider credentials stay controller-side. [tools](../src/control/backends.ts), [runtime routing](../src/control/isolatedRuntime.ts).                                                                                                                                                                                                                               |
| Human and owner handoffs       | Coding dynamic tools produce validated HumanWait/OwnerWait; native requestUserInput also maps to a question. Controller repair handoffs are fenced. Questions do not grant host authority. [RPC handling](../src/control/backends.ts), [worker handoff](../src/control/workerHandoff.ts).                                                                                                                                             | Structured question/ownerOperation in final coding response; no native interactive question channel. Controller operations refuse task handoffs. [normalization and handoff](../src/control/subscriptionNative.ts).                                                                                                                                                                                                                               | Durable question tool during coding; no owner-operation tool. [loop](../src/control/backends.ts). All paths retain stopped-resource/source validation before controller handoff persistence. [paid/portable lifecycle](../src/control/isolatedBackend.ts), [subscription lifecycle](../src/control/subscriptionBackend.ts).                                                                                                            |
| Approvals and authority        | `approvalPolicy: never`; unsolicited native requests receive `decline`. Native sandbox bypass is inside controller container isolation. [CodexBackend](../src/control/backends.ts).                                                                                                                                                                                                                                                   | `--dangerously-bypass-approvals-and-sandbox` relies on outer isolation; no permission to act on controller host or override policy. [native adapter](../src/control/subscriptionNative.ts), [auth authority checks](../src/control/authRuntime.ts).                                                                                                                                                                                               | No native approval engine; controller decides durable policy/spending exceptions. [loop](../src/control/backends.ts). All paths retain admitted policy, lease/deadline checks and controller check/review/import authority. [contract](../src/control/executionContract.ts), [runtime](../src/control/isolatedRuntime.ts), [import](../src/control/environments.ts).                                                                   |
| Network                        | Internal per-invocation network reaches inference relay only. Gateway pins provider/model/protocol, rejects server tools, background/store/previous response references and unsupported routes; forces Responses store=false. General egress unavailable as a configurable alternative here. [network](../src/control/gatewayNetwork.ts), [gateway](../src/control/inferenceGateway.ts), [container](../src/control/environments.ts). | General egress denied; controller-configured exact HTTPS host allowlist, public IPv4/DNS pinning, SNI and connection/byte/time bounds through authenticated proxy. Configurable hosts are a policy alternative, not arbitrary network access. IPv6 remains denied. [AuthRuntime](../src/control/authRuntime.ts), [egress policy](../src/control/egressPolicy.ts), [proxy](../src/control/subscriptionEgress.ts), [TLS](../src/control/tlsSni.ts). | Worker network is none; inference is controller-side. Goal `containerNetwork: bridge` belongs to the older helper and does not override isolated production routing. [IsolatedBackend](../src/control/isolatedBackend.ts), [DockerEnvironment](../src/control/environments.ts), [runtime routing](../src/control/isolatedRuntime.ts).                                                                                                  |
| Sessions                       | Fresh ephemeral thread, identifier returned; no native resume. Gateway refuses previous_response_id/store/background. [CodexBackend](../src/control/backends.ts), [gateway](../src/control/inferenceGateway.ts).                                                                                                                                                                                                                      | `--ephemeral`; native thread identifier consumed. Auth store persists privately with one writer for login/refresh, not coding continuation. No exec resume. [native](../src/control/subscriptionNative.ts), [auth](../src/control/authRuntime.ts), [auth ownership](../src/control/authEnvironment.ts).                                                                                                                                           | Controller checkpoint messages can seed a fresh invocation, including pending-tool intent. Interrupted shell cannot automatically replay. This existing behavior is not new native session continuation. [PortableBackend](../src/control/backends.ts), [checkpoint lifecycle](../src/control/isolatedBackend.ts).                                                                                                                     |
| Structured output              | turn/start outputSchema when supplied; native normalization and controller validation for plan/review. [adapter](../src/control/backends.ts), [normalizer](../src/control/nativeOutputSchema.ts).                                                                                                                                                                                                                                     | Output schema staged privately by auth runtime and passed with --output-schema; prompt also requires schema JSON. Strict final normalization/handoff validation; duplicate or absent terminals fail. [native](../src/control/subscriptionNative.ts), [runtime](../src/control/authRuntime.ts), [schema](../src/control/nativeOutputSchema.ts).                                                                                                    | Controller validates plan/review JSON; provider-native schema enforcement is not established by this loop. [loop](../src/control/backends.ts), [planning/review](../src/control/scheduler.ts).                                                                                                                                                                                                                                         |
| Usage                          | Gateway counters and admitted rates produce metered estimates; partial/failed runs preserve uncertainty. Cache cost and invoice equivalence remain gaps. [gateway](../src/control/inferenceGateway.ts), [usage](../src/control/usage.ts), [lifecycle](../src/control/isolatedBackend.ts).                                                                                                                                             | Reported/unknown native tokens and elapsed time; invocation limits, optional reported-token fence, no dollar estimate/reservation. Native counters are not provider-enforced caps; missing counters cannot prove a configured ceiling. [native](../src/control/subscriptionNative.ts), [accounting](../src/control/store.ts), [contract](../src/control/executionContract.ts).                                                                    | Provider counters and configured prices produce estimates. Vertex records thinking/cache details; other provider cache pricing is incomplete. [providers](../src/control/providers.ts), [Vertex](../src/control/vertexProvider.ts), [limits](../src/control/executionLimits.ts).                                                                                                                                                       |

## Restriction decision and configurable alternatives

No adapter restriction is removed. This checkout provides neither complete native
feature documentation nor live isolation evidence for enabling subscription hooks,
MCP, apps/plugins, memory, multi-agent discovery, arbitrary egress, native approval
escalation or native session persistence. Paid app-server's partial customization
control is explicitly unverified; this candidate does not invent an enforced
blanket disable. Removing a flag based on its name alone would be insufficient.

Existing alternatives remain controller-owned: explicit instructionFiles,
runtimeInstructions, admitted prompts and pinned contract snapshots; selectable
valid execution contracts/providers; bounded subscription HTTPS host policy;
and project/installation publication and auto-merge policy. None is a worker
permission to widen authority. The status projection never reads private runtime
configuration and cannot advertise whether allowlisted hosts, credentials or
images currently exist. Enabling or qualifying execution requires the existing
operator workflow. See [configuration](configuration.md), [subscriptions](subscriptions.md)
and [gateway](gateway.md).

Isolation is a container/source/import boundary. `write_file` has path and mode
checks, but a native or portable shell can mutate its private source beyond task
patterns; validation at import and review rejects such trusted-source changes.
Plan/review shells are not intrinsically read-only syscalls. Native sandbox bypass
must not be confused with host access. Containers retain pinned images, restricted
mounts, read-only roots, dropped capabilities, disposable homes (dedicated auth
session for subscription), bounded resources and authority-aware teardown.
[Import implementation](../src/control/environments.ts) and
[regressions](../src/control/isolatedBackend.test.ts) establish these distinctions.

## Status API and dashboard contract

Authenticated `GET /api/v1/projects`, `GET /api/v1/goals` and
`GET /api/v1/goals/{id}` append `executionCapabilities` to each stored status
object. `GET /api/v1/dashboard` uses the same projection on its project and goal
objects. Inputs and persisted goal/project schemas do not accept this field.
Creation/mutation/replay responses retain their existing envelopes; clients read
status to obtain current source capabilities. Project enabled state and current
readiness do not change source support.

```json
{
  "version": 1,
  "basis": "current_code",
  "path": "subscription_codex_exec",
  "features": {
    "integrations": {
      "state": "disabled_by_policy",
      "reason": "Worker MCP and native discovery are disabled by the adapter; subscription Codex also disables apps and plugins."
    }
  }
}
```

The example shows one feature; actual responses contain every feature in
[ExecutionCapabilities](../src/control/executionCapabilities.ts): tools,
instructions, nativeCustomization, integrations, providerTools, humanHandoff,
ownerHandoff, nativeApprovals, networkAccess, boundedEgress, sessions,
sessionContinuation, structuredOutput, usage, isolation, publication, autoMerge.
States mean:

- `supported`: a repository implementation exists under its stated bounds, not a live readiness or qualification assertion.
- `disabled_by_policy`: explicit adapter or admitted policy withholds the feature.
- `unavailable`: no implementation, insufficient evidence, or missing matching execution contract; reason distinguishes these cases.

Reasons are fixed source descriptions. Only path selection and admitted boolean
policy affect them; credentials, host/model names, private paths, config values,
raw diagnostics and probe results are never copied. The projection has no side
effects or authority grants. [Shared implementation](../src/control/executionCapabilities.ts),
[API](../src/control/api.ts), [dashboard](../src/control/dashboard.ts),
[UI](../src/control/ui.ts), [OpenAPI](openapi.json).

Projects and goal details render literal capability states/reasons through DOM
text nodes and retain the existing limits and usage views. Readiness, qualification
receipts and executionLimits remain separate; no numerical caps are duplicated
in capabilities. [API/privacy regressions](../src/api.test.ts),
[privacy](../src/privacy.test.ts), [projection tests](../src/control/executionCapabilities.test.ts),
[UI tests](../src/control/backlogUi.test.ts).

## OpenHands and Linear evidence boundary

This checkout contains no supplied OpenHands ACP documentation, OpenHands
built-in-agent documentation or Linear coordination documentation. Repository
search found no verifiable supplied references for those systems. Therefore this
assessment cannot establish their tool inventories, instruction layers, isolation,
approvals, session behavior, usage or integrations, or compare them with these
harnesses. The requested ACP versus built-in-agent distinction and Linear
coordination distinction remain documentation gaps; they must not be treated as
interchangeable execution paths or inferred feature parity. No public documentation
was fetched and no live comparison was performed. This candidate adds no OpenHands
or Linear adapter and makes no claims about their current behavior.

## Validation and operator follow-up

The admitted baseline passed unchanged `mc-check`. Candidate checks cover all
three projections/API paths, privacy and hostile UI text, Codex native approval
refusal and subscription flag/handoff fences. Existing regressions retain gateway
server-tool refusal, network ownership, pinned transport, symlink/path defenses,
credential hardlink rejection, stopped-source import, review mutation and stale
lease refusal. [Harness](../src/control/harness.test.ts),
[subscription native](../src/control/subscriptionNative.test.ts),
[auth runtime](../src/control/authRuntime.test.ts),
[gateway](../src/control/inferenceGateway.test.ts),
[network](../src/control/gatewayNetwork.test.ts),
[portable isolation](../src/control/isolatedBackend.test.ts).
Fixture checks do not qualify real native releases or providers.

No dependencies, lockfile, images, authentication stores or private configuration
are changed. There is no unavoidable worker image rebuild for this projection
and documentation change. A new controller release/build is required to expose
it. Subscription acceptance binds **all installed non-test JavaScript** and worker
assets through [subscriptionImplementationHash](../src/control/subscriptionQualification.ts);
this candidate changes that fingerprint, so installed subscription receipts must
be renewed for the exact candidate before admission. Applicable exact-release
provider/platform/portable isolation qualification also remains required; older
live evidence is not reused. The separate [portable qualification script](../scripts/qualify-portable-execution.mjs)
and [subscription qualification script](../scripts/qualify-subscription-coding.mjs)
are unchanged and were not run against live services here.

Readiness auditing, evaluation tooling, external-session observation and new native
session continuation are outside this candidate. Independent review and integration
belong to MissionControl after the candidate commit; this work does not publish,
merge, deploy or change images.
