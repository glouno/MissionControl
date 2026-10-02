# MissionControl

MissionControl turns development goals into dependency-aware tasks, leases work
to isolated agents, records attempts and checks, and asks for explicit approval
when work needs a human decision. One controller owns the SQLite application
database. Humans and other agents use its authenticated HTTP API, CLI, MCP and
six-view dashboard.

This is a **v1 preview candidate**. The initial supported target is Linux/WSL,
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
