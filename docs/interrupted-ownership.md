# Interrupted task ownership

A paused goal can retain a running task, an expired lease, an active attempt and
resource reservations after controller interruption. Pause controls dispatch;
lease expiry removes execution authority. Neither establishes that the worker,
container, network or an external tool effect stopped. Read-only status must not
repair these records or describe an expired worker as a live owner. Previously,
expiry reconciliation freed ownership and queued a retry without inspection;
startup intent also identified tasks without binding their admitted generation.

## Inspect and recover

1. Inspect the dashboard snapshot's `ownership.tasks` alongside tasks, attempts,
   checkpoints and execution records. Authority is `live`, `expired`, `orphaned`,
   `fenced` or `awaiting_operator`. Worker lease projections also distinguish live
   from expired leases. `health.startupRecoveryFault` exposes cleanup failure.
   These projections perform no recovery writes. Ownership pages contain at most
   500 tasks; the store's `ownership(limit, after)` returns a `nextCursor`.
2. Use normal controller startup under its exclusive instance lock to fence prior
   authority and reconcile registered runtime resources. Startup revokes worker
   credentials and inference capabilities, expires leases, records attempt
   generations and creates durable inspection questions before cleanup. During
   normal scheduling, expired leases enter the same inspection state through
   `reconcileExpired(taskId, generation)`. A live lease or wrong generation is
   refused by that path. Startup intentionally fences prior live leases because
   the caller holds the exclusive controller lock.
3. Inspect the retained source/checkpoint, pending tool effects and unreported
   usage. Failed cleanup keeps the attempt `recovering`, its worker/resource
   reservations retained and admission fenced. Restore the configured runtime's
   ability to clean up registered resources before retrying startup. Do not edit
   database records to claim cleanup or bypass a generation/ownership mismatch.
4. For the pending question, choose `defer` to leave it pending, or submit
   `inspect` using the operator answer API with the question's current revision.
   `POST /questions/QUESTION_ID/answer` accepts
   `{"option":"inspect","revision":1,"explanation":"Evidence of stopped execution and resources; inspected effects"}`.
   When ownership is still retained, a nonempty explanation is required, and
   recorded containers, active execution and gateway networks block resolution.
   The dashboard provides a Recovery evidence field. The CLI also accepts
   `question answer QUESTION_ID --option inspect --explanation "Inspected stopped resources and retained effects"`.
5. Resolution closes the exact interrupted attempt and retires only its startup
   task intent in the same transaction. It preserves the attempt checkpoint and
   clears `pendingTool` only from the task's future checkpoint to avoid replaying
   an ambiguous tool call. Repeated startup cannot reopen a resolved admission.
   The goal stays paused with its revision unchanged. Resume it explicitly only
   after review; a fresh claim increments generation and rejects old workers.

## Accounting and safeguards

Running metered inference may have progressed past its last checkpoint. Recovery
records unknown total usage while retaining partial usage in that checkpoint;
the reservation remains counted as unresolved spending. Ownership confirmation
does not settle billing. Use the separate evidence-backed usage reconciliation
procedure in [state.md](state.md) for closed metered attempts.

Subscription recovery preserves unknown, non-dollar usage and admitted attempt
counts. An open recovering admission retains its identity writer fence. Closing
ownership does not invent token totals or reopen token-capped admission when
usage is unknown. Public subscription admission remains subject to its existing
qualification gate.

Claims cannot reuse a task with retained ownership, an open admission or a
pending recovery question. Cleanup completion alone leaves the task waiting for
inspection. Startup intent with a different generation fails transactionally
without releasing the newer owner's resources. Legacy task-only intent is
upgraded only from a recovering admission; a new active admission is insufficient
evidence. Repeated recovery creates one question per task attempt. Cancelling
a goal first fences an expired active attempt and does not free its retained
ownership or settle its partial checkpoint as final usage.

## Evidence and limits

`src/control/interruptedOwnership.test.ts` reproduces the paused/expired state in
temporary synthetic SQLite databases and covers read-only inspection, live lease
refusal, repeated recovery, checkpoint and resource retention, cleanup failure,
operator resolution before cleanup completion, restart, orphaned admissions and
generation/legacy fencing. `subscriptionAccounting.test.ts` covers identity and
unknown usage retention without dollar reservations.

An operator explanation records an attestation; it cannot prove the absence of
unregistered processes or undo external effects. Recorded active resources must
be cleaned up through their owning runtime. Unknown or mismatched legacy
admissions fail closed and require separate inspection. These synthetic tests
do not establish live crash-container, provider billing or authenticated
subscription qualification. No live databases or existing subscription test
records are needed for reproduction.
