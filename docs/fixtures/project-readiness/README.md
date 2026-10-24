# Public illustrative project requirements

These files contain invented requirements, not exports from private projects.
At `2026-10-22T12:00:00Z`, run the command in ../../project-readiness.md; expected
JSON and text are checked byte-for-byte by regression coverage (exit 1).

| Project       | Illustrative repository       | Branch/base                    | Checks           | Provider/model                                            | Execution/verification images       |
| ------------- | ----------------------------- | ------------------------------ | ---------------- | --------------------------------------------------------- | ----------------------------------- |
| ExampleEngine | example.invalid/ExampleEngine | main / forty `1` digits        | mc-check         | codex-subscription / illustrative-operator-selected-model | sha256: sixty-four `1` / `4` digits |
| ExampleWeb    | example.invalid/ExampleWeb    | development / forty `2` digits | npm run check    | codex-subscription / illustrative-operator-selected-model | sha256: sixty-four `2` / `5` digits |
| ExamplePython | example.invalid/ExamplePython | development / forty `3` digits | python -m pytest | codex-subscription / illustrative-operator-selected-model | sha256: sixty-four `3` / `6` digits |

All use illustrative dedicated-session authentication, isolated Codex harness,
subscription limits (two attempts, ten minutes, one concurrent attempt) and a
Mac arm64 acceptance target. Every named image/base/model/repository is an
illustration to replace privately; none claims an installed/accepted artifact.

Unavailable private facts are JSON null: project/config/runtime/implementation/auth
policy hashes, selected private context hashes, applied requirements hash,
installed execution/verification images, host policy/Docker availability,
auth preparedness/writer state, unknown-usage status and qualification artifacts.
Actual private repository identities, branches, bases, checks, provider/model,
image requirements and platform acceptance were not supplied either; the
explicit example requirements stand in for them, never prove them.

All three project schemas validate. Provider enablement is false throughout;
ExampleWeb is disabled/unqualified, ExamplePython is disabled and paused, and
ExampleEngine's illustrative exported readiness boolean is true yet it is
unqualified/blocked. No real installation snapshot is included. Fixture success proves tooling reproducibility, not actual
project readiness, native Mac acceptance or live subscription acceptance.
