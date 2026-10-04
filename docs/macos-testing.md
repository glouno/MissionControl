# macOS fixture validation

Use a disposable, owner-only, canonical temporary root. macOS `/tmp` and
`/var` paths can resolve to `/private/tmp` and `/private/var`; production
canonical-directory checks correctly reject their aliases. Do not relax those
checks or change an installed controller to run tests. Default per-user macOS
temporary paths can also exceed the Unix socket path limit.

The controller, connector and instance fixtures resolve only their newly created
temporary directories. The gateway-network fixture uses canonical `/tmp` on
Darwin to keep its socket path short, and honors `TMPDIR` on other platforms.
`mkdtemp` creates these directories with mode `0700`. Service managers and Docker
are injected mocks; databases and the Unix socket belong to disposable fixtures.
Explicit symlink/alias, file-mode and loaded-ownership rejection assertions remain
active. Canonicalizing a fixture does not authorize redirected runtime paths.

Run from this checkout with dependencies already installed. Node must satisfy
the package engine `>=24.0.0 <25`. Check the actual executable before interpreting
results; running on another major version is diagnostic evidence, not supported
engine qualification. No dependency installation or external API is needed.

```sh
(
  umask 077
  mc_tmp="$(mktemp -d /private/tmp/mcm.XXXXXX)"
  mc_tmp="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$mc_tmp")"
  export TMPDIR="$mc_tmp"
  node --version
  npm --version
  printf 'Private fixture root: %s\n' "$TMPDIR"
  npm run typecheck &&
  node node_modules/typescript/bin/tsc &&
  node --test --test-reporter=tap --test-timeout=20000 \
    dist/control/nativeOutputSchema.test.js \
    dist/control/workerHandoff.test.js \
    dist/control/subscriptionNative.test.js \
    dist/control/subscriptionAccounting.test.js \
    dist/control/usage.test.js \
    dist/instance.test.js \
    dist/service.test.js \
    dist/connectorServices.test.js \
    dist/control/gatewayNetwork.test.js &&
  git diff --check
)
```

This compiles the local tests without the source-archive/package steps performed
by `npm run build`. Temporary evidence is intentionally retained; remove only
the printed directory once review is complete. Do not point tests at a real state
root, credentials, a running worker or service directories.

For path regression diagnostics, create a nested directory inside that private
root, expose its parent through a symlink inside the root, and supply that alias
as `TMPDIR` for just the instance, controller-service, connector-service and
gateway-network files. The socket fixture should remain short; the other fixtures
should resolve their own roots. Never canonicalize the intentional aliases used
by rejection assertions.

The native adapter's synthetic output-limit child writes exactly `8 MiB + 1`
bytes and stays alive until terminated. A larger write followed by immediate exit
races buffered output against process-group teardown: the original fixture
produced `kill EPERM` on this Mac. This change continues to exercise output-limit
enforcement and real child termination. It does not prove runtime termination of
an already exited group; attributing the original error to that race is an
inference from the fixture and the successful revised test. Production process
authority, including Linux process checks, is unchanged; macOS fixture success
is not Linux execution qualification.

## Recorded local audit

Baseline: `8c3de18b42f0b7529c7a3f0dc9cb2f1d5f1a90fe`, Darwin arm64,
Node `v26.7.0`, npm `11.19.0` (outside the supported Node engine).
One targeted baseline run with a deliberately long `/tmp` alias reproduced
32 tests: 20 passed, 12 failed. Failures comprised eight canonical-path/ownership
fixture failures, three socket `listen EINVAL` failures and one output-limit
`kill EPERM` failure. All native-output-schema, handoff, accounting and usage
assertions passed. None of these observations justifies weakening runtime
safeguards.

The revised targeted run used canonical `TMPDIR=/private/tmp/mcm-mt_7338t`
(owner-only mode `0700`): 33 tests, 30 passed, 3 failed, 0 skipped. All schema,
accounting, native-adapter, instance and mocked service tests passed, including
the output-limit and intentional alias-rejection assertions. The three remaining
gateway-network tests failed at Unix socket bind with `listen EPERM` on short
canonical paths such as `/private/tmp/mc-network-4EyMtX/socket/inference.sock`.
The execution environment denied the bind; this does not establish a gateway
runtime defect or successful gateway qualification. No permission or network
policy change, mock socket replacement, or skipped assertion was used to bypass
it. Two failed targeted attempts were reached, so testing stopped.

`npm run typecheck` and direct TypeScript compilation exited `0`.
`git diff --check` passed.
Evidence is retained locally in `/private/tmp/mcm-mt_7338t/baseline.tap`,
`targeted.log`, `typecheck.log` and `compile.log`; these disposable paths are not
portable artifacts. Supported Node 24, successful socket execution and Linux
process authority remain unverified in this run.

Only the affected fixtures and this document need changes. A full suite is not
required for these scoped fixes; broader lifecycle, cloud, worker, release and
Linux validation remain outside this audit. Stop after two failed validation
attempts rather than retrying indefinitely.
