# Native devbox execution

MissionControl can supervise installed Codex on Linux/WSL in owned Git worktrees.
Native and container execution use the same goals, task generations, attempts,
leases, candidate capture, trusted checks, independent review and integration.
The native route is a preview: see [validation and outstanding live coverage](native-runtime-validation.md).

The worker user supplies the devbox trust boundary. A worktree coordinates source
ownership; it does not isolate that user's files or credentials. Native CPU and
memory declarations are scheduler accounting, not enforced OS limits. Select the
container route when the existing container isolation guarantees are required.

## Select the existing installation

A host file names the executable, home, tool PATH and permissions explicitly:

```json
{
  "id": "devbox",
  "nativeProfiles": {
    "existing": {
      "executable": "/usr/local/bin/codex",
      "codexHome": "/home/worker/.codex",
      "home": "/home/worker",
      "path": "/usr/local/bin:/usr/bin:/bin",
      "permissions": "devbox",
      "requiredExecutables": ["node", "npm"],
      "setupCommands": ["npm ci --ignore-scripts"],
      "requiredPaths": ["package.json", "package-lock.json"],
      "requiredScopePaths": [],
      "buildOutputPaths": ["build/**"],
      "requiredUrls": []
    }
  }
}
```

Replace those example paths with the worker's tested terminal environment. An
optional `profile` selects an existing Codex profile; an optional `environment`
supplies non-secret tool settings. Identity, PATH and Codex home have dedicated
fields. Controller tokens and ambient connector/API secrets are not inherited.
`devbox` explicitly grants the worker's normal devbox access; `workspace-write`
selects Codex's workspace sandbox. Enabled hooks still require normal persisted
hook trust. MissionControl neither bypasses that decision nor copies credentials.

The provider selects the named profile and the exact model you intend to use:

```json
{
  "id": "native-codex",
  "enabled": true,
  "backend": { "kind": "codex", "model": "your-selected-model" },
  "executionContract": {
    "harness": "codex",
    "provider": "codex-subscription",
    "execution": "native",
    "authentication": { "kind": "local", "reference": "existing" },
    "usagePolicy": { "kind": "observed" }
  }
}
```

An optional backend `reasoningEffort` overrides that setting for both execution
and review. When omitted, the selected Codex configuration supplies it.

Native currently supports Codex with an existing ChatGPT login. Unsupported
agent, authentication and billing combinations fail validation. No Docker image,
dedicated container authentication environment, gateway or image qualification
receipt is required. No environment, login or billing fallback is performed.

A project uses `executionMode: "native"`, that provider, its repository and
explicit trusted `verificationCommands`. For a local repository, `repository.branch`
must match `policy.targetBranch`. Include `native` and the provider ID in the
installation authority allowlists. List the host/provider/project files in
`config.json`; apply external configuration through the existing supported
operations. Host/provider changes require a stopped instance and offline apply.
Existing goals retain their admitted configuration.

Preflight checks the selected Codex version and existing login, required tools,
Git committer identity, repository inputs, declared documentation access, branch
consistency and checks. Task admission rejects insufficient resources and required
fixture/packaging files outside declared scope. Pinned sibling contracts and
instruction budgets keep their existing checks. Missing prerequisites are reported
before inference. Setup recipes run only in owned workspaces; they do not install
host packages or change global configuration.

## Run an explicit task

An operator-authored envelope avoids a planning invocation:

```json
{
  "goal": { "projectId": "app", "description": "Fix the selected bug" },
  "plan": {
    "tasks": [
      {
        "key": "fix",
        "title": "Fix the selected bug",
        "description": "Describe the bounded implementation",
        "allowedPaths": ["src/example.ts", "src/example.test.ts"],
        "acceptanceCriteria": [
          "The regression is fixed and trusted checks pass"
        ]
      }
    ]
  }
}
```

```sh
mission-control --config-dir /private/config project explain app
mission-control --config-dir /private/config project preflight app
mission-control --config-dir /private/config goal reviewed \
  --input /private/task.json --idempotency-key app-fix
mission-control --config-dir /private/config goal invocations GOAL_ID
mission-control --config-dir /private/config goal metrics GOAL_ID
mission-control --config-dir /private/config goal experiment GOAL_ID
```

Observation commands return JSON. Corresponding API paths are
`GET /api/v1/projects/{id}/explain`, `/preflight`, and
`GET /api/v1/goals/{id}/invocations`, `/metrics`, `/experiment`.
MCP exposes `project_explain`, `project_preflight`, `goal_invocations`,
`goal_metrics`, `goal_experiment`, and the idempotent `goal_reviewed` operation.
Authentication, project scope, CSRF and revision requirements remain in force.
The dashboard shows the environment, latest phase/activity, blocker and usage.

Implementation uses `codex exec --json`, preserving normal configuration,
repository instructions and approved integrations. A saved session is resumed
only by its explicit ID for the same task workspace. Independent review uses a
fresh session and a separate checkout of the captured candidate. Controller Git
operations capture candidates after writers stop. Trusted checks run in another
candidate checkout with declared setup, detecting tracked mutations and undeclared
untracked outputs. Build outputs must be declared or ignored by the repository.
Checks and review feed findings back into the same task. Returning an unchanged
rejected candidate produces an actionable block instead of routine replay.

## Observe and recover

Invocation metadata is stored in the controller's database, separately from
private raw files under `agent-output`. Raw output streams incrementally and uses
the existing 10 MiB/five-rotation log policy. Sanitized operational logs contain
metadata only. Preserve private files when investigating a failure; rotated trace
files may begin partway through an event, while database measurements remain
independent of rotation.

Metrics distinguish controller attempts, agent process invocations, command
executions and exposed Codex turns. Underlying model request counts remain
unavailable. Missing tokens remain null; cached input is a subset of input and is
never added to it. Subscription usage has no invented dollar conversion. Native
execution does not inherit image-bound subscription invocation ceilings; existing
explicit task, deadline, recovery and admission policies still apply.

Quota and authentication failures pause the goal through the existing provider
incident/recovery workflow. Repair the external condition, inspect retained
evidence, then use the existing explanation-bearing recovery operation. Resuming
a saved session does not erase unknown usage or release ownership automatically.

Launch intent is durable before spawning. The Linux process record includes PID,
process group, start identity, boot identity and an execution marker. A framed
launch handshake prevents EOF during controller failure from starting an
unrecorded worker. Cancellation stops owned processes, including ordinary detached
children that retain the execution marker. After restart, surviving execution is
stopped and artifacts retained; streams are not reattached. PID reuse or ambiguous
cleanup retains ownership and a specific blocker. This is process supervision,
not protection against a malicious same-user process that deliberately hides its
identity. See [migration and rollback](native-migration.md).
