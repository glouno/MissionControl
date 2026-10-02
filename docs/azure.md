# Azure Foundry API execution

Azure is an API-backed provider; it does not require a ChatGPT or Claude Code
subscription. The orchestrator is a Node controller that plans, dispatches and
tracks work. Its configured planning/coding/review harnesses call approved model
APIs. Choose model deployment identifiers available to your own Foundry account;
no account, endpoint or paid provider is enabled by public defaults.

The two intended native paths are:

| Harness                       | Runtime protocol | Provider                         |
| ----------------------------- | ---------------- | -------------------------------- |
| Codex                         | `responses`      | Azure Foundry Responses endpoint |
| Claude Code                   | `messages`       | Azure Foundry Messages endpoint  |
| Retained controller tool loop | `tool-loop`      | Explicit Azure backend           |

Qualification is specific to harness, model, image, protocol and source revision.
A working tool loop does not certify a native harness, and results from another
installation do not establish that your local image works. Consult the exact
release acceptance report for live-tested paths and limitations.

## Configure explicitly

1. Install Docker Engine and build/review an immutable worker image containing
   the native harnesses you select. Record its `sha256:` image digest. The public
   recipe is a template, not a redistributed vendor binary or qualified image.
2. In your external configuration root, add a provider file, project file and host
   runtime file. Reference them from `config.json`'s `files` groups. Match provider
   ID, model, harness, runtime protocol and image exactly.
3. Use controller-side `azure-cli` authentication or a private secret-file reference.
   Authenticate the Azure CLI yourself in the intended controller environment.
   Workers receive scoped relay capabilities, never your Azure credential.
4. Explicitly allow the selected provider IDs and `isolated` execution in
   installation authority. Set conservative per-goal and cumulative admission
   allowances; keep publication and auto-merge disabled during qualification.
5. Run `config validate`, stop the controller, then `config apply --offline` for
   runtime/security changes. Run `doctor`, start in the foreground and submit a
   small synthetic coding goal against a disposable Git repository.
6. Inspect attempts, checks, review, integration and usage before enabling useful
   private work. Do not treat a process exit or model response as success evidence.

A native provider's `executionContract` separates harness, provider, controller
reference, isolated execution and metered policy. For example (synthetic model and
limits; the host runtime must independently define `azure-code`):

```json
{
  "id": "azure-code",
  "enabled": false,
  "backend": { "kind": "codex", "model": "your-responses-deployment" },
  "executionContract": {
    "harness": "codex",
    "provider": "azure",
    "authentication": { "kind": "controller", "reference": "azure-code" },
    "execution": "isolated",
    "usagePolicy": {
      "kind": "metered",
      "maxCostUsd": 5,
      "estimatePerRunUsd": 1
    }
  }
}
```

The corresponding host runtime provider uses `protocol: "responses"`, your
explicit HTTPS `endpoint`, the exact same `model`, and
`authentication: {"kind":"azure-cli"}` or a reviewed secret reference. Claude Code
uses `harness/backend.kind: "claude-code"` and `protocol: "messages"`. Do not put
native provider settings in `backend.foundry` or rely on surrounding `.env`, hooks,
MCP configuration, alternative auth overrides or a general home-directory mount.

A project selects the provider, `executionMode: "isolated"`, repository, configured
checks and budgets. Its host runtime binds that project ID to the reviewed image
digest. Installation authority bounds project defaults and explicit goal requests;
a request cannot expand provider, execution, spending or publication authority.
Set the project's explicit `containerImage` to a reviewed immutable image for
independent checks; it may use the same qualified digest while running separately.

Native inference requests are limited to 32,768 output tokens per request.
Messages requires a valid bounded `max_tokens`; Responses supplies that bound when
omitted. The isolated Claude runtime explicitly sets the supported
`CLAUDE_CODE_MAX_OUTPUT_TOKENS=32768` setting so its default request fits the gateway
contract. The gateway rejects excessive requests rather than silently clamping them.

## Usage and failure

Reservations authorize admission; they are not measured spending or a cloud hard
cap. Usage distinguishes reported, estimated and unknown values. Missing billing
measurements remain unknown and preserve unresolved reservations. Review provider
evidence and use explicit reconciliation when supported; do not settle unknown
charges as zero. Time, output, attempts and concurrency remain bounded independently.

A rejected credential, unsupported deployment, failed relay or unqualified image
must fail closed with actionable evidence. There is no fallback to trusted host
execution. Real credentials stay controller-side and task containers cannot reach
unapproved provider endpoints, host services or private networks. Every live test
uses a disposable repository and a separately tracked conservative spending budget.
