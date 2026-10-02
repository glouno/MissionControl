# Installation qualification

This repository is a v1 preview candidate. Core builds require Node 24 LTS
and Git. Real execution requires a qualified Docker Engine/Desktop installation.
Encrypted backup requires age. Matrix is optional and does not make Rust a core
installation dependency.

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js --config-dir /private/config init \
  --state-dir /private/state --secrets-dir /private/secrets --example
node dist/cli.js --config-dir /private/config doctor
node dist/cli.js --config-dir /private/config serve
```

From another terminal (including an unrelated working directory), submit the
explicitly configured fake project:

```sh
mission-control --config-dir /private/config goal create \
  --project synthetic --input /private/config/synthetic-goal.txt
```

When running directly from source, replace `mission-control` with the absolute
path to `dist/cli.js` prefixed by `node`. The generated repository, workspaces,
SQLite database and operator token all live outside source. The fake workflow
records implementation, configured checks and independent review before success.

Edit external configuration, run `config validate`, then `config apply`. Changes
to host/provider/server settings require a stopped instance and `config apply
--offline`. Existing goals retain their admitted revision. Real provider modes
remain gated on isolation qualification; there is no host fallback.

`service install` prepares a separate user service definition. It does not enable
or start it. Run `service start` explicitly after configuration review and
`doctor`; use `service status`, `restart`, and `stop` for its lifecycle.
`service uninstall` requires a stopped controller (unloaded on macOS). Operations
refuse altered definitions, foreign paths and Linux drop-in overrides; use the
configuration directory and executable release that installed the service.
Service output is suppressed by default to keep private diagnostics out of
shared system journals. Builds and installs do
not start services, log in, or consume inference.

The initial preview targets Linux/WSL. macOS/Docker Desktop, subscription coding,
additional Matrix device/failure behavior and off-host recovery remain experimental
and are deferred from initial preview qualification. The exact release acceptance
report determines which Azure paths and installed workflows have passed.

Run `node scripts/qualify-platform.mjs darwin /private/reviewed-image.txt
/private/new-evidence` on the actual Mac after building a clean reviewed checkout
and a locally installed immutable worker image. Use `linux` on Linux/WSL. The
command records platform, Docker, image, Node and lockfile fingerprints, runs a
fresh synthetic installation, gateway/egress, logged-out native status and active
container crash checks, and creates private evidence outside source. It starts no
installed service, performs no login or inference, and does not qualify real
subscriptions or device/backup behavior. Review receipts before sharing them.

Release preparation/verification additionally uses Python 3 and its standard
archive library. Release source and installed archives have normalized owner,
mode and candidate timestamp metadata. Verification streams every member without
extracting it, checks exact inventory/content hashes and refuses links, special
files, duplicate names, unsafe paths, privileged modes and local owner metadata.
The npm payload is verified against its own explicit manifest as well. A payload
verification receipt establishes integrity, not release qualification.

For a disposable Linux controller lifecycle proof, run
`node scripts/qualify-controller-service.mjs /private/new-service-receipt.json`.
It refuses any existing v1 controller definition, loaded unit or overrides, uses
fresh external synthetic state and an unused port, then removes only its exact
owned unit. It tests authenticated API access, completed synthetic work and
state preservation through restart; existing legacy services/routes stay intact.
It is separate from macOS acceptance and production activation.

## Dashboard login

`serve` prints the selected local application URL. Open it on the machine running
the controller and authenticate with the operator token saved privately under the
configured secrets directory. Never place the token in a URL or paste it into a
public issue. A browser on another machine needs an explicitly configured private
HTTPS reverse proxy; its localhost does not reach the controller.

## Installed archive

A reviewed installed archive contains the compiled CLI, lockfile, built-in profiles,
documentation, notices and exact original-source assets. Extract it into a new
release directory, run `npm ci --omit=dev --ignore-scripts` there, and invoke
`node /absolute/release/dist/cli.js`. It does not require TypeScript or Rust.
The source archive can instead be built with `npm ci --ignore-scripts` and
`npm run build`. Neither archive includes runtime data or credentials.

From a source checkout, `npm run privacy` audits the generic publication inventory
and `node scripts/check-package.mjs` inspects the actual planned npm payload after
building. Installation-specific scans belong to a private release workflow.

## Dashboard browser acceptance

Browser tooling is separate from the core runtime. Install Playwright and Chromium
in a disposable development tooling directory, then run:

```sh
PLAYWRIGHT_MODULE=/absolute/tools/node_modules/playwright/index.mjs \
  node scripts/dashboard-acceptance.mjs
```

`PLAYWRIGHT_CHROMIUM_EXECUTABLE` may select an already installed reviewed browser.
The harness creates private temporary config/state/secrets/repository, starts only
an ephemeral loopback controller, and removes its owned resources. It tests actual
operator login, goal submission/details/decisions/control/history/evidence and
source download workflows. It does not start installed services, authenticate a
real provider, or qualify optional connectors/platforms.
