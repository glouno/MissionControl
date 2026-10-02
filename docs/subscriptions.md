# Subscription isolation qualification

Subscription execution is not enabled in this candidate. The authenticated
native runtime must own only its dedicated login/session directory and run within
an isolated Linux container. It must never inherit the user's general CLI home,
ambient hooks/MCP configuration, provider keys, connector secrets or controller
credentials. One writer per subscription identity is the initial policy.

The egress foundation is implemented as an authenticated CONNECT relay over
controller-owned Docker stdio. Workers have internal isolated networks. Controller
DNS resolution rejects private, metadata, Tailscale, documentation, multicast and
unsupported IPv6 addresses; connections pin the checked IPv4 result. Hostnames
are exact allowlist entries on port 443, with bounded bytes, concurrency and time.
Initial TLS SNI must match the admitted hostname. Fragmented/unknown ClientHello
and encrypted ClientHello are rejected pending independent qualification. TLS
remains between the client and provider; the relay does not decrypt it.

`node scripts/qualify-subscription-egress.mjs /private/reviewed-image-digest.txt`
uses a reviewed immutable Python-capable image and a synthetic TLS handshake to an
authentication endpoint. It performs no login and no inference. Linux acceptance
checks TLS verification, authenticated proxy access, destination denial and direct
private-network denial. This is not subscription runtime qualification.

Dedicated login/setup is prepared; real user acceptance is still required:

- Codex supports `codex login --device-auth` and dedicated `CODEX_HOME`. File-based
  credentials use `cli_auth_credentials_store = "file"`; restrict login method to
  ChatGPT for the subscription environment. Never copy the ambient auth store.
- Claude supports a dedicated `CLAUDE_CONFIG_DIR` and native `/login`. Its
  subscription credentials live within that environment on Linux. Keep API-key,
  cloud-provider and OAuth-token environment overrides absent so the admitted
  authentication method cannot silently change.
- Login, refresh, restart, expiry refusal, auth store backup, exact network
  endpoints, disabled unrelated tools/hooks and bounded native execution must all
  pass before integration. Do not run a paid API as a substitute for subscriptions.

Official references: [Codex authentication](https://developers.openai.com/codex/auth/)
and [Claude Code authentication](https://code.claude.com/docs/en/authentication).
Vendor binaries and redistribution terms must be qualified separately.

Usage receipts are checked against each goal's admitted billing policy at worker,
checkpoint, task transition and controller settlement boundaries. Subscription
receipts cannot report dollar costs or substitute a metered/synthetic receipt.
Reported subscription usage requires an explicit token measurement; default native
aggregate counters do not turn unavailable usage into measured zero. Ambiguous
failures retain unknown usage. These safeguards prepare accounting integration;
native subscription coding admission remains disabled.

## Dedicated private authentication workflow

Add an auth file to `config.json` under `files.auth`. Its strict schema is:

```json
{
  "id": "dedicated-codex",
  "harness": "codex",
  "imageDigest": "sha256:<reviewed-immutable-digest>",
  "sessionDir": "dedicated-codex",
  "egress": {
    "hosts": ["auth.openai.com", "chatgpt.com"],
    "maxConnections": 8,
    "maxBytes": 134217728,
    "timeoutMs": 600000
  },
  "qualified": false
}
```

Use `claude-code` for the Claude harness. Exact endpoint allowlists must be
qualified against the installed native version; these example Codex hosts are
not a claim of complete login/refresh coverage. The session path resolves within
`secretsDir`, outside both Git repositories. Changing the admitted image, egress
or identity requires a fresh reviewed authentication environment. Configuration
cannot claim qualification by setting `qualified` to true.

Stop the candidate controller before these offline operations. The commands
acquire its instance lock and record resource ownership in the application DB:

```sh
mission-control --config-dir /private/config auth prepare dedicated-codex
mission-control --config-dir /private/config auth inspect dedicated-codex
mission-control --config-dir /private/config auth status dedicated-codex
mission-control --config-dir /private/config auth login dedicated-codex
```

Login requires an interactive private terminal. Complete the native device or
browser flow there; never paste login codes, URLs or tokens into chat, CI, issues
or progress evidence. Native login output is not persisted by MissionControl and
Docker container logging is disabled. Status reports only recognized subscription
sign-in, logged-out or unrecognized state; account fields/raw native diagnostics
are discarded. A successful login command does not establish release qualification.

The container receives a clean environment, a disposable home and workspace,
and one persistent session mount. It has no project mount during authentication.
Codex's temporary executable wrappers live in a separate tmpfs, outside persistent
state. The egress capability travels over Docker stdin rather than arguments,
container configuration or persisted records. The relay has no host mount.

A failed teardown retains the writer lock. After a process crash, first inspect
and explicitly recover the controller lock. Startup reconciles a confirmed dead
local writer and its matching resources. For explicit offline recovery, inspect the auth writer nonce
and use `auth recover ID --nonce NONCE`. Recovery requires the original local
writer PID to be dead and verifies recorded container labels before cleanup.
Daemon failures or ownership mismatches refuse cleanup and keep admission closed.
Do not manually remove locks while a container can still write its session.

`node scripts/qualify-auth-environment.mjs /private/reviewed-image-digest.txt`
checks both native logged-out status paths twice with empty dedicated stores on
real Linux Docker, along with teardown and restart. It does not authenticate or
run inference. Actual login, expiry/refresh, bounded coding and macOS remain gates.

## Dedicated session backup and recovery

Stop the controller and authentication operations before `auth backup ID
--destination /private/backups/session.age --recipient-file /private/recipient`.
The command holds application and session ownership, refuses unreconciled auth
containers, and encrypts a private inventory with identity, policy hash and file
hashes. No writer lock or disposable Codex temporary directory enters the bundle.
Symlinks, foreign ownership and open session writers are rejected.

Restore with `auth restore ID --input /private/backups/session.age --identity-file
/private/age.key` into the selected configuration's **new** dedicated session
directory. The harness, environment ID and admitted image/egress policy must match.
The dedicated identity is retained; do not run its old and restored stores at once.
Inspect and run native status through isolation after restore. Session revocation,
refresh and vendor keychain portability can still require a new supported login.
Synthetic encrypted restore passes; authenticated cross-machine recovery remains
an external acceptance gate. General home-directory authentication is never copied.

## Coding feasibility adapter

`SubscriptionBackend` connects controller-created private source copies to the
same session owner and CONNECT relay used for authentication. Status checks use
a disposable home without project configuration discovery. Status, refresh and
coding retain one writer; teardown must stop the owned container before any Git
inspection/import. Unresolved teardown retains ownership, source and recovery
records. Session hardlinks and symlinks refuse import. Verification has a separate
source/container without a session mount; review gets a distinct execution.

The native adapter uses Codex `exec --json --ephemeral --ignore-user-config
--ignore-rules`, disables project instruction discovery and optional integrations,
and reads the prompt from stdin. Claude uses safe mode, no setting sources,
explicit disabled hooks/empty MCP configuration and bounded turns. Both have
external isolated execution, time/output bounds, strict terminal-result parsing
and structured handoffs. These safeguards do not prove vendor login/refresh or
all customization behavior until the pinned native version passes live acceptance.
Official Codex flag guidance: [non-interactive execution](https://developers.openai.com/codex/noninteractive/)
and [configuration reference](https://developers.openai.com/codex/config-reference/).

Subscription admission accounting uses immutable attempts instead of dollar
budget rows. Planning, coding and review each consume an invocation; their total
counts toward the admitted subscription `maxAttempts`. One subscription identity
can have only one active controller attempt, and native login/coding shares its
filesystem writer lock. No vendor dollar estimate becomes subscription spending.
Missing token totals remain unknown. With `maxReportedTokens`, unknown totals
block further admission; reported totals are inspected after native completion.
This is an observed-use/admission limit, not a provider-enforced token ceiling.

```sh
node scripts/qualify-subscription-coding.mjs /private/reviewed-image-digest.txt
```

This Docker proof first inspects the pinned native versions/required flags, then
builds a disposable derived image with **synthetic** native tools. It exercises
coding, independent checks/review, session restart, direct/private-network denial
and unauthorized proxy denial. No login, real session, inference or production
admission occurs. Failed proof state is retained privately for inspection.

The production scheduler still refuses subscription goal admission. Remaining
gates include real login/refresh/restart/expiry, proof that native configuration
controls are effective, reviewed release qualification receipts, and actual
Docker Desktop acceptance. Sibling contract
snapshots are explicitly refused by the feasibility adapter until implemented.

## Installation runtime binding

A subscription provider has an explicit host runtime definition:

```json
{
  "protocol": "subscription",
  "harness": "codex",
  "model": "configured-native-model",
  "authentication": { "kind": "session", "reference": "dedicated-codex" }
}
```

The provider's execution contract, this definition and dedicated auth environment
must agree on harness, model and session reference. Each project must use the same
pinned image as its auth environment. One installation runtime host is supported;
multiple host runtimes are rejected rather than silently selecting the first.
Goal admission snapshots record the image and authentication-policy hash, alongside
the complete configuration/runtime revision. Changed or missing snapshots refuse
runtime binding. Verification uses a separate source-only container; it does not
mount the native session. The backend branch remains behind the closed production
qualification gate. Configuration cannot enable it or claim a verified release.

`doctor` lists individual project/provider/image/auth-policy/writer/qualification
faults. It inspects local image metadata and private store identity only, never
starts native tools, pulls images, authenticates or provisions accounts. An
unlocked prepared store does not prove login validity; use isolated native status
and the private live acceptance workflow explicitly.
