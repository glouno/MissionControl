# Consolidated development

The canonical source combines the published engine with the pending backlog
candidate and reviewed private recovery fixes. Private Git ancestry and operational
material are excluded. Older dashboard and Azure branch variants were compared
with the subsequent source; their feature flows are retained with the newer
credential, scope, dispatch, token-bound and packaging safeguards.

## Retained capabilities

- Goal planning, dependency tasks, generation-fenced leases and isolated execution.
- Independent verification/review and exact-candidate integration/publication policy.
- Six dashboard views, authenticated sessions, CSRF/origin checks, bounded evidence
  downloads, source delivery, filters and mobile layouts.
- Durable project backlog with inert CRUD, revision checks, dependency validation,
  atomic explicit launch and recurring schedules.
- Strict native subscription output schemas and coding-to-review continuation.
- Subscription admission bound to private implementation/image/auth/model evidence.
- Readiness diagnostics that distinguish configuration, authentication, image and
  acceptance failures without starting execution.
- Interrupted ownership inspection, durable recovery decisions, generation fencing,
  resource retention and unknown-usage accounting. Dashboard and CLI accept the
  required recovery explanation.
- External private configuration, encrypted backups, restoration and service tooling.
- Scoped automation identities, API/CLI/MCP workflows and transport-neutral encrypted
  connector routing; optional integrations retain their own qualification limits.

## Verification and releases

Run `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`,
`python3 -B scripts/test_status.py`, `npm run privacy`,
`node scripts/history-audit.mjs` and `node scripts/check-package.mjs`.
The synthetic suite includes a real recurring scheduler interval. Browser acceptance
uses separately installed Playwright through `PLAYWRIGHT_MODULE`; it creates its
own temporary repositories, configuration, tokens and databases.

Core tests and browser checks run without paid provider calls or production state.
Matrix Rust tests use the locked companion dependencies. A deployable release must
also pass its applicable platform, provider, isolation and recovery gates against
its exact fingerprints. Do not reuse an older live acceptance receipt after code
changes, or call a source consolidation a production upgrade.

## macOS parity checks

Use Node 24 (check `node --version`; newer majors are outside the supported
engine), Git, Python 3 and `age`/`age-keygen` on PATH. The test preloader and
standalone acceptance scripts resolve the temporary parent automatically because
macOS `/var` paths alias `/private/var`. Runtime canonical-path and intentional
symlink rejection checks remain unchanged. Run the same checks above on macOS;
the separate macOS CI job retains the existing Linux required-check names.

Image-build ownership uses the boot-session UUID and microsecond process start
time from macOS libproc through isolated Python 3. Linux retains its `/proc`
identity. The regression test checks a real child's stable identity and verifies
it disappears after exit. Missing host APIs fail closed; PID alone is never
sufficient evidence of ownership. The output-limit fixture keeps its synthetic
child alive until termination so buffered output does not race an immediate exit
and a subsequent signal to an exited process group; production termination
authority remains unchanged.

Run `node scripts/backlog-acceptance.mjs` for the disposable API/CLI and recurring
scheduler workflow, and the documented browser acceptance with a separately
installed Playwright. Docker Desktop must be running for the six-stage
`qualify-platform.mjs darwin` proof with a reviewed, locally installed immutable
worker image. This proof does not qualify real subscriptions, inference,
launchd activation or optional Matrix devices. Linux-in-Docker regression results
also do not establish WSL service behavior.
