# MissionControl storage and execution invariants

Preserve running installations and their state. Source edits are not deployment;
qualify a versioned runtime before switching the active installation. Preserve
reserved dashboard ports and existing private preview routes.

Admission must include the physical Windows volume backing WSL, not only Linux
free space. Missing or stale host metrics block heavy work. Use the installed
host-owned devbox-storage gate for cooperating heavy jobs, with realistic peak
estimates; do not nest its lock or bypass denied admission. Parallel editing is
separate from heavy-build concurrency.

Durable evidence and source recovery are not caches. Exclude generated Matrix
Rust targets and dependency trees from recovery artifacts. Retention requires
ownership, inactive leases/processes, exact references and verified recovery.
Never delete live databases, dirty source, in-use images/volumes or sole rollback
copies through blanket GC. Every exported cache and failed scratch owner needs
both byte and age limits plus restart reconciliation. Preview before apply.

Idle dispatch identities are ephemeral; persist worker registrations only for
actual claims or explicit worker registration. Preserve historical task/attempt
references; do not bulk-prune live tables to address bookkeeping growth.

Test low host space with plentiful WSL space, missing/stale metrics, idle dispatch
loops, pass/fail/crash retention and repeated-run storage plateaus. Keep verifier
source/base/contract/signature checks intact. Consult the host's machine-bootstrap
storage runbook for local budgets and maintenance procedures.
