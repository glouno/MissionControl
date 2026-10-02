# External configuration

Run `mission-control --config-dir /private/config init --state-dir /private/state
--secrets-dir /private/secrets`. These are three separate directories. The
configuration directory may be a private Git repository; state and secret values
must stay outside both source and configuration repositories.

`config.json` has `schemaVersion: 1`, `stateDir`, `secretsDir`, `server`,
`authority` and `files`. File groups reference projects, profiles, providers,
hosts, connectors, prompts, schedules and dedicated authentication environments. Relative paths resolve from the file
declaring them. Unknown keys and missing/redirected references are rejected.

New installations have no enabled projects, paid provider, connector, publication
or auto-merge authority. Project defaults inherit explicit profiles, then apply
project settings. Goal requests may reduce execution limits but cannot replace
repositories, checks, models or publication policy. Credential values are not
configuration fields: use `{ "kind": "file", "path": "credential-name" }` or an
explicit environment reference. Secret files must be private regular files.

`config validate` reads configuration without changing state. `config apply`
requires an authenticated running controller. Changed projects and prompts are
activated explicitly and future goals record the new hash; admitted goals keep
their previous snapshots. Server/provider/runtime changes use `config apply
--offline` while the controller is stopped.

Built-in profiles resolve against the installed package. `builtin.synthetic`
enables deterministic fake execution with no credentials or spending. Add
`--example` to `init` to create its temporary example project and goal input.

Projects select `promptIds` explicitly. Prompts are admitted with content hashes;
other projects' prompt files are never silently included. `contextRoots` is an
installation allowlist of `{id,path}` roots. A project may select specific
`contextFiles: [{rootId,path}]` for private specs. These are copied into the
admitted context snapshot, bounded to 64 KB, hashed and fenced against traversal
and symlinks. They remain private application data and never recreate mission
file execution or enter release exports.

`authority.maxTotalAdmittedCostUsd` is a cumulative admission allowance across
CLI, schedules and connectors; its default is zero. It is independent of the
per-goal cap and is not measured spending or a provider-enforced dollar ceiling.
The allowance is never silently replenished on completion. Change its external
configuration explicitly. `storage` configures free-space admission and registered
cache/archive/retention budgets; unfinished/pinned/recovery protections still apply.

Host runtime upstreams require explicit `authentication` (`azure-cli` or a secret
reference with an approved header). Runtime provider IDs match each goal's admitted
provider ID; matching another model's name cannot substitute authority. Goals
record a runtime revision, and dispatch refuses if that approved runtime changed.
Azure remains controller-side. Subscription coding integration and live provider
qualification are still pending.

Metered tool-loop runtime definitions use `protocol: "tool-loop"`, the exact
admitted Azure/Bedrock `backend` configuration, and explicit authentication.
Azure accepts `azure-cli` or `secret` with a private reference. Bedrock accepts
`aws-session` with separate `accessKey`, `secretKey`, and `sessionToken` references;
the SDK does not discover credentials from the general home/environment. Session
expiry fails provider requests and requires operator refresh. Native Responses
and Messages modes retain their fixed endpoint/header contract.

The tool loop runs in the controller, but its file and shell operations execute
inside the invocation's disposable container, with no inference network. Neither
cloud credentials nor session references enter that container. Source import
requires a stopped container, a current lease and scoped changed paths. Separate
verification and review still apply. Token prices are configured estimates, not
provider invoices. Synthetic Linux Docker qualification does not establish live
Azure/Bedrock or macOS support.

Real provider files require an `executionContract` separating harness, provider,
authentication reference, execution and usage policy. Contracts reject real host
execution, mismatched native subscription harnesses and subscription dollar
policies. Metered limits cannot widen the provider's policy. Authentication
references name controller capabilities or dedicated environments, never contain
credentials. Admitted contracts remain in immutable goal/attempt snapshots.
The native subscription contract is prepared, but coding admission remains
explicitly refused pending runtime integration and live qualification.

Provider authentication must reference its own host runtime provider ID (metered)
or a matching dedicated authentication environment (subscription). Configuration
validation rejects unsupported native Bedrock combinations, mismatched runtime
protocols/models/authentication and backend-level provider overrides. All provider
references are validated even when disabled. Disabled projects can stage valid
subscription configuration for private setup; enabling coding still requires
qualification. Subscription goals use zero dollar budgets and reservations, with
attempt, time and concurrency limits bounded by the admitted policy. No missing
measurement becomes zero spending.

Startup recovery uses the explicitly applied configuration snapshot before
inspecting authentication writers or resources. Editing configuration files alone
does not change which identity the controller is allowed to reconcile.

## Private customization repository

A private repository can hold `config.json` and referenced files, for example:

```text
missioncontrol-config/
  config.json
  projects/example.json
  providers/azure-code.json
  hosts/linux-worker.json
  profiles/development.json
  prompts/review.json
  prompts/review.txt
  schedules/daily.json
```

The layout is conventional; each reference is explicit, so no folder discovery
imports surrounding settings. Generic project/provider defaults may be committed
privately, but secret values, auth sessions, databases, logs, evidence and backup
bundles stay in separate private local stores. Add a private `.gitignore` as a
second defense, never as the boundary that makes storing credentials safe.

Use `--config-dir /absolute/missioncontrol-config` or
`MISSIONCONTROL_CONFIG_DIR` from any working directory. Keep the public engine
checkout replaceable. `init` creates separate OS-appropriate defaults when custom
paths are omitted; explicit example creation uses an external disposable project.
Run validation after editing references and apply changes deliberately. Revoking
installation authority does not rewrite admitted goal history or grant a broader
replacement configuration.
