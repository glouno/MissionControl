# Native runtime validation and acceptance

Native Codex execution currently supports Linux/WSL. Source verification and
installation activation are separate: merging or building this code does not
start services, authenticate providers, or enable native projects.

## Reproduce source verification

Use the pinned Node 24.21.0 and Rust 1.96.0 toolchains, install the locked
JavaScript dependencies with `npm ci --ignore-scripts`, and keep evidence outside
the source checkout:

```sh
python3 -B scripts/verify.py --lane linux --logs /private/new-linux-verification
```

The required Linux lane covers TypeScript, Node tests, Python status checks,
publication privacy, the installed package, the production dependency audit,
Git history, and locked Matrix Rust tests. The owned verifier separately binds
source, base, policy, dependency locks, toolchains and signed receipts. A local
summary is not a substitute for that authority.

The optional `--lane macos` checks portable source behavior. Linux native process
lifecycle tests are explicitly skipped on other hosts; portable protocol,
configuration, launcher and output tests still run. This does not qualify native
execution on macOS, which remains unsupported.

## Automated coverage

Synthetic native tests use disposable repositories, independent controller state,
local executable fixtures and unused loopback ports. They require no provider
credentials and do not use a running installation or its repositories. Coverage
includes:

- Full task delivery, trusted checks, independent review workspaces, and repair
  after failed checks or review findings.
- Explicit coding-session continuation, fresh review sessions, preserved native
  profile configuration, and excluded controller credentials.
- Shared preflight deadlines, cancellation before launch, missing prerequisites,
  task scope, unsupported hosts, and installation paths containing spaces,
  punctuation or non-ASCII characters.
- Malformed or duplicate protocol events, unknown usage, quota failures, launch
  authorization, detached descendants, reused process IDs, and bounded cleanup.
- Retained ambiguous ownership during startup and operation recovery, source
  mutation checks, declared build outputs, private output rotation, and compatible
  historical admission fingerprints.
- Complete backup refusal while native writers are active or cleanup is blocked,
  and restoration after ownership has settled.

The protocol remains invalid after a parse failure; later buffered events cannot
restore successful completion or trusted usage. Cancellation and preflight
expiration stop owned probe processes. Recovery must prove process ownership and
absence before releasing a claim; inspection errors preserve the fence.

For synthetic installed CLI, HTTP and MCP acceptance, run
`node scripts/backlog-acceptance.mjs` from the built checkout. Its controller and
configuration are disposable. Synthetic delivery does not establish live provider
behavior, billing, operational performance, or production acceptance.

## Reproduce live acceptance

Use a new private output root, an explicitly selected existing subscription and
the reviewed built source. Substitute the executable, home and model already
qualified for that installation:

```sh
node scripts/native-acceptance.mjs \
  --output-root /private/new-native-acceptance \
  --codex /usr/local/bin/codex \
  --codex-home /home/worker/.codex \
  --model your-selected-model
```

The script creates its own controller, state, configuration, token, disposable
repositories and unused port. It refuses an existing output root. It does not
activate native execution in another installation or edit an input checkout.

Available cases are `ordinary`, `check-repair`, `review-repair`, `cancellation`
and `restart`. Use `--cases ordinary,cancellation,restart` for a selected campaign.
Cancellation and restart cases establish an actual owned running command before
interruption, use supported stale-lock recovery, and verify process absence.
Quota failure stops the campaign with an acceptance gap and unknown usage retained.

The optional `real` case additionally requires `--real-repo`, `--real-branch`,
`--real-check`, `--real-envelope` and optionally `--real-setup`. Its explicit reviewed
scope uses project ID `real`, as documented in [native execution](native-execution.md).
Publication and automatic integration remain disabled for the acceptance fixture.

Keep per-case summaries, raw invocation files, exact source identities and
prerequisite results private. Historical receipts are evidence for their recorded
source and environment; repeat affected acceptance after either changes. Report
unavailable measurements as null, keep cached tokens as a subset of input, and do
not infer hidden request counts or subscription dollar charges.

Live evaluation adapters, actual private application acceptance, native macOS,
broader provider coverage and off-host recovery require separate qualification.
Passing source tests does not resolve those gates or establish a performance
ranking.
