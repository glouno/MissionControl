# Agent API and CLI

The controller is the application write owner. Other agents use its HTTP API,
CLI or MCP; they do not open SQLite, edit task rows, copy operator credentials,
or infer task success from a model message. OpenAPI describes the canonical
`/api/v1` routes. Project and schedule definitions come from explicit external
configuration application, not a second mutable catalog.

## Give an agent limited access

From an operator-owned terminal, provision a short-lived identity for a configured
project. The token is written to a new private file; it is not printed:

```sh
mission-control --config-dir /private/config access create assistant \
  --project synthetic \
  --permissions goals:read,goals:create,goals:control \
  --token-file /private/secrets/agent-token --hours 24
mission-control --config-dir /private/config access list
```

The token file must be beneath this installation's configured `secretsDir`; the
examples assume `/private/secrets`. It must be a private canonical regular file.

The identity may read its scoped projects/goals/tasks/attempts/evidence/events,
submit bounded goal descriptions and pause/resume/cancel permitted goals. It
cannot answer human approvals, change plans/providers/budgets/policy/configuration,
publish changes or claim arbitrary tasks. Give read-only agents `goals:read` only.
Revoke an identity with `access revoke assistant`. Token values and token-file
contents must never enter configuration Git or public logs.

An agent uses its token file for normal online CLI commands:

```sh
mission-control --config-dir /private/config --token-file /private/secrets/agent-token \
  project list
mission-control --config-dir /private/config --token-file /private/secrets/agent-token \
  goal create --project synthetic --input /private/goal.txt \
  --idempotency-key synthetic-request-1
mission-control --config-dir /private/config --token-file /private/secrets/agent-token \
  goal inspect GOAL_ID
```

Use a stable idempotency key for a retry of the same mutation. A changed request
with the same key is a conflict. Automation goal creation and state-changing
requests require `Idempotency-Key`; validating a goal draft does not. Preserve
returned goal IDs and current revisions instead of retrying a different request
because a network response was ambiguous.

## HTTP workflow

The following Python example reads a token from a private local file. It does not
put the token in a command-line argument or print it. Set the URL to the selected
loopback instance port; the default is 43201.

```python
from pathlib import Path
import json
from urllib.request import Request, urlopen

token = Path('/private/secrets/agent-token').read_text().strip()
request = Request('http://127.0.0.1:43201/api/v1/goals',
    data=json.dumps({'projectId': 'synthetic',
                     'description': 'Create the synthetic artifact and pass checks.'}).encode(),
    headers={'Authorization': 'Bearer ' + token,
             'Content-Type': 'application/json',
             'Idempotency-Key': 'synthetic-http-request-1'}, method='POST')
with urlopen(request) as response:
    print(json.load(response)['id'])
```

Inspect the goal through `GET /api/v1/goals/GOAL_ID`; inspect attempts, evidence
and events through the documented scoped endpoints. Lists support bounded `limit`
and `after` cursors; retain the last returned ID, and do not interpret an empty
page as global completion. A 401 means missing/expired/revoked authentication,
403 means insufficient authority, and 409 means a conflicting revision, ownership
or admission state. Read the structured error and resolve that cause before retry.

## Execution workers

An orchestration agent submits work; the controller dispatches approved isolated
workers. Execution claims require a registered worker identity, current execution
session/resource ownership, provider/image admission and fenced lease generation.
The general API is not permission to execute on arbitrary hosts. Unknown ownership
or changed isolation policy refuses admission. Only checks and independent review
of the exact candidate can accept a result. Remote worker fleets are deferred.

Human decisions remain operator-owned and revision-bound. An agent may inspect a
pending decision when authorized but must not answer on behalf of the operator.
CLI and MCP online operations use the same application services and permissions.

## Corresponding source

The authenticated dashboard offers the installed build's source download through
`GET /api/v1/source`. `GET /api/v1/source-info` exposes its version, optional clean
source commit, byte count and SHA-256 without checkout paths. Missing or altered
source assets return unavailable; they are never replaced with a guessed URL.
Source download is operator-authenticated and does not contain installation config,
state, secrets or runtime reports.

## Durable project backlog

Backlog stores work for later review in the controller's SQLite database. Add,
show, list, update and archive never create goals, jobs, leases, attempts or budget
reservations and never invoke models. Operators can use all backlog operations;
automation uses its existing `goals:read` permission for reads and `goals:create`
for mutations, with its existing project restrictions and mutation idempotency
requirement. Workers and connectors cannot access backlog.

Create a private JSON input file such as `/private/backlog.json`:

```json
{
  "title": "Improve validation",
  "description": "Validate incoming requests before writing state.",
  "priority": 10,
  "dependencies": [],
  "acceptanceCriteria": ["Invalid input leaves state unchanged"]
}
```

All commands require explicit project scope; mutations of existing entries also
require the current pending revision. Update input contains only fields to change.
Higher numeric priority sorts first; priority does not schedule execution.

```sh
mission-control --config-dir /private/config backlog add --project synthetic \
  --input /private/backlog.json --idempotency-key backlog-add-1
mission-control --config-dir /private/config backlog list --project synthetic --status backlog
mission-control --config-dir /private/config backlog show BACKLOG_ID --project synthetic
mission-control --config-dir /private/config backlog update BACKLOG_ID --project synthetic \
  --revision 1 --input /private/backlog-edit.json --idempotency-key backlog-edit-1
mission-control --config-dir /private/config backlog launch BACKLOG_ID --project synthetic \
  --revision 2 --idempotency-key backlog-launch-1
# Alternatively archive a pending entry:
mission-control --config-dir /private/config backlog archive OTHER_BACKLOG_ID --project synthetic \
  --revision 1 --idempotency-key backlog-archive-1
```

HTTP uses `GET/POST /api/v1/backlog`, `GET/POST /api/v1/backlog/{id}` and
`POST /api/v1/backlog/{id}/archive` or `/launch`. Reads require `projectId` in the
query; writes require it in the JSON body. Archive and launch bodies contain only
`projectId` and `revision`. Entries have stable IDs, timestamps, revisions and
`backlog`, `archived` or `launched` status. Each update or status transition
increments the revision. Archived and launched entries cannot be edited.

Dependencies are existing backlog IDs in the same project. Unknown IDs,
cross-project references, duplicates, self references and cycles are rejected.
A dependency is satisfied only when it has launched and its linked goal is
`completed`. Pending or archived work, and planning, running, paused, failed,
cancelled or publishing goals do not satisfy it. Archiving a dependency does not
release dependent work. Backlog dependencies are launch prerequisites, not goal
task dependencies, and are never launched automatically.

Explicit launch rechecks the pending revision, dependencies, currently applied
trusted project configuration, project enabled state and installation authority.
Input cannot supply provider settings or execution flags. Work text and acceptance
criteria become the goal description; execution settings come from the project.
Configuration refusal and unmet dependencies leave the entry pending. Goal
creation, accounting, planning job and backlog goal link commit together.

Launch returns the admitted goal and persists `goalId` and `launchedRevision` on
the entry. Retrying the same launched revision returns that original goal, even
after restart or a later configuration change, without new admission or spending.
Use the original pending revision for replay, not the incremented entry revision.
A different revision conflicts (409); archived entries cannot launch. Launch
replay does not revalidate already admitted work. New launches always revalidate.
