# Read-only cross-machine status

Install the lightweight observer from this checkout (Python 3 standard library;
no Node build, database initialization or worker start required):

```bash
./scripts/install-status.sh
missioncontrol status
missioncontrol status --host local
missioncontrol status --host remote --ssh-host YOUR_SSH_ALIAS
missioncontrol status --json
missioncontrol status --config-dir /path/to/config
missioncontrol status --state-dir /path/to/state
```

`missioncontrol` is a status-only companion to the existing `mission-control`
application CLI. Both binaries are declared in the package manifest. The default
view checks hosts declared in the private observer configuration at
`~/.config/missioncontrol-status/config.json`; without that file it checks only
this machine. Add a remote endpoint with `--ssh-host`. Remote inspection sends the same Python collector over SSH;
no remote installation or service change is required. Connections and queries
have bounded timeouts. `NO_COLOR=1` disables color.

Discovery uses platform defaults, MissionControl environment paths, local macOS
LaunchAgent configuration, live Linux process `--config-dir` arguments, and the
explicit installation catalogs configured with `--catalog` or the private
observer configuration.
It does not crawl archives or test databases. Custom dormant installations need
explicit local `--config-dir` or `--state-dir` (repeatable); on the remote machine run this
script there with `--host local` to select custom remote paths. Uninitialized
configurations are reported without creating their state. Discovery is an
inventory of these known sources, not a guarantee of every installation.

Databases are opened with SQLite `mode=ro`, query-only transactions and no
application constructor, migrations or scheduler calls. Both legacy missions
and v1 goals/tasks are supported. The human view shows a bounded list; `--json`
provides the bounded collector payload, counts, state paths and discovery roots.
It never returns configuration credentials, provider settings or process argv.

Host headings identify where the controller state was read, not independently
verified execution placement. V1 tasks show worker IDs and whether the recorded
task lease is still valid. A lease is liveness evidence, not proof of CPU use or
successful work. Worker heartbeat freshness uses a two-minute observation window;
recent heartbeats do not imply tasks are executing. Legacy task `running` status
is explicitly unverified; legacy worker heartbeat state/age is shown separately.
Expired task leases are retained in the report rather than counted as live work.

Check the observer independently of the application test suite:

```bash
python3 scripts/test_status.py
```

Private observer configuration example (keep real host names and paths outside this repo):

```json
{"hosts":{"local":{"label":"Local"},"remote":{"label":"Devbox","ssh":"YOUR_SSH_ALIAS","catalogs":["~/YOUR_CONFIG_REPO/installations"]}}}
```

An optional trusted `command_prefix` list can route the collector through a
remote launcher. Set `shell` to `windows` when that launcher is parsed by the
Windows command line. Such a route may start an environment; keep it out of the
default inventory with `include_in_all: false` and explicitly select that host
when recovery inspection is needed. Host names, launchers and installation paths
remain private configuration.
