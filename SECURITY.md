# Security

MissionControl is a preview. Bind the controller to loopback and use authenticated
access. Do not expose the API directly to the public internet. A private reverse
proxy must preserve exact host/origin and TLS handling; a reachable port is not
an authentication boundary.

The controller owns application writes. Use scoped automation identities for
other agents and revoke unused credentials. Task workers require registered
identity, current leases and approved isolated execution. Never grant a connector
or coding worker the operator token. Real provider credentials stay controller-side;
subscription sessions belong to their dedicated authentication environment.

Configuration, prompts, model output, goal descriptions, checkpoints, reports,
evidence, connector stores and backups are private application data. Keep secrets
and state outside both public source and configuration Git repositories. Restrict
local permissions and use explicit credential references. Logs and artifacts can
contain private material even when the original request looked harmless.

Publication requires reviewed source/history, credential and private-content scans,
and exact source/npm/installed inventories. A scanner pass supports review; it does
not establish that all private information is absent. Never include live credentials,
personal tasks or operational evidence in a public issue.

Report vulnerabilities through GitHub private vulnerability reporting when it is
enabled for the published repository. Include the affected version, impact and a
synthetic reproduction. If private reporting is unavailable, ask the maintainer
for a private reporting channel before sending sensitive details.

Optional Matrix/Telegram, macOS and subscription features have separate acceptance
limits. Their source availability does not establish encrypted-device, notification,
platform or authentication qualification. Consult the exact release's acceptance
report and fail closed when execution or credential ownership is uncertain.
