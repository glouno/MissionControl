# MissionControl

MissionControl turns development goals into dependency-aware tasks, leases work
to isolated agents, records attempts and checks, and asks for explicit approval
when work needs a human decision. One controller owns the SQLite application
database. Humans and other agents use its authenticated HTTP API, CLI, MCP and
six-view dashboard.

This is a **preview candidate**. The initial supported target is Linux/WSL,
with Azure Foundry API execution. Consult the exact release's acceptance report
before enabling real work. macOS, subscription coding, Bedrock and chat connectors
are optional or experimental; their presence in source is not qualification.

## Try it without credentials

Install Node 24 LTS and Git. From this checkout:

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js --config-dir "$HOME/.config/missioncontrol-preview" init \
  --state-dir "$HOME/.local/state/missioncontrol-preview" \
  --secrets-dir "$HOME/.local/share/missioncontrol-preview-secrets" --example
node dist/cli.js --config-dir "$HOME/.config/missioncontrol-preview" doctor
node dist/cli.js --config-dir "$HOME/.config/missioncontrol-preview" serve
```

In a second terminal, use the **absolute checkout path** to `dist/cli.js`:

```sh
node /path/to/MissionControl/dist/cli.js \
  --config-dir "$HOME/.config/missioncontrol-preview" goal create \
  --project synthetic \
  --input "$HOME/.config/missioncontrol-preview/synthetic-goal.txt" \
  --idempotency-key first-synthetic-goal
```

The generated synthetic project performs deterministic planning, coding, checks
and review with no model calls or spending. `init` without `--example` creates
disabled defaults. Building and installing do not start services or log in.

## Set up your installation

- [Installation and first workflow](docs/installation.md)
- [Configuration and private customization](docs/configuration.md)
- [Agent API and CLI workflows](docs/agents.md), [OpenAPI](docs/openapi.json)
- [Azure Foundry execution](docs/azure.md) and [worker images](docs/worker-images.md)
- [Database ownership and recovery](docs/state.md), [encrypted backups](docs/backups.md)
- [Security](SECURITY.md), [licensing and corresponding source](docs/licensing.md)
- Optional: [Matrix](docs/matrix.md), [subscription environments](docs/subscriptions.md)

Keep project settings, prompts and machine configuration in external files or a
private `missioncontrol-config` repository. Keep credentials, runtime databases,
missions/specs, reports, sessions and crypto stores outside the public checkout.
Real execution requires an explicitly reviewed Docker image and provider runtime;
there is no silent host-execution fallback. Publication and auto-merge are disabled
unless project and installation policy explicitly allow them.

Original MissionControl code is **AGPL-3.0-only**. Builds include the exact reviewed
original source for the dashboard/API source download. Dependencies retain their
own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md). No vendor
executables, prebuilt worker images or homeserver images are distributed here.

For a concise read-only overview across configured local and remote installations, install the
[`missioncontrol status` companion](docs/status-cli.md) with
`./scripts/install-status.sh`. It supports v1 goals and legacy missions without
starting workers or changing state.

Work also maintains a project backlog independently of admitted goals. Saving or
archiving backlog does not start execution. Explicit launch uses the applied
project configuration after dependency and admission checks; see the
[compute-ready backlog workflow](docs/configuration.md#synthetic-project-backlog-and-explicit-launch).

## Development direction

Use this repository as the canonical source for engine, dashboard, connectors,
installation and release tooling. Develop changes on named branches and temporary
linked worktrees; version numbers belong in releases, not checkout names. Keep
private installation configuration in its own repository, and keep installed
releases, mutable state, credentials and recovery archives outside source.

The product direction is one goal-based controller and one authoritative
application database, shared by CLI, API, MCP, dashboard and encrypted human
connectors. Work can be saved in a durable project backlog without execution;
explicit launch applies project policy, dependency checks and execution admission.
Results require exact-candidate checks and independent review. Interrupted work
retains ownership and uncertain usage until evidence-backed recovery.

The initial release target remains Linux/WSL with isolated Azure execution.
Subscription execution requires private acceptance bound to the exact installed
implementation, image, model and authentication policy. Matrix, macOS and other
providers retain their implementations and tests; release support requires actual
platform/provider acceptance. Component tests do not qualify a changed release.
See [consolidated capabilities and validation](docs/development.md) and
[interrupted ownership recovery](docs/interrupted-ownership.md).
