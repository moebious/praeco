# ADR-005 — Durable Assignment Execution, Recovery and Runtime Ownership

**Status:** Accepted; implementation pending
**Date:** 2026-10-17
**Depends on:** ADR-001–004

## Decision

**Trigger.dev owns every P0 financial Assignment workflow.** Vercel AI SDK is an inference/tool-loop library invoked inside bounded steps, **not** a second durable orchestrator. Chat SDK owns channel transport/conversation state only, not financial work. Praeco's authoritative operational record lives in tenant-scoped SQL; L2 alone owns financial commitments and approvals.

Eve and Pi Durable are **outside this baseline**, not runtime dependencies, roadmap deliverables, fallback workers or silent double executors. No continuous process or VM is required for an agent to remain persistent.

## Canonical semantics

- `PayableCase`: tenant-bound cross-source documentary/business *workspace*, not L2's canonical payable obligation or a duplicate verdict.
- `Assignment`: durable business responsibility with ID, tenant, type, principal, initiating actor, case, capability scope, state, version, creation/update timestamps and outcome references. A message, run, model turn or sandbox is not an Assignment.
- `AgentRun`: one bounded execution attempt within an Assignment with `triggerRunId`, attempts, progress and termination reason.
- `Checkpoint`: persisted **logical** progress marker with safe input/output refs and version, not serialized private chain of thought, ephemeral model execution stack or payment credential.
- `ExecutionEvent`: append-only operational transition with causation/correlation and idempotency identity; a notification is not a decision record.
- `ApprovalWait`: durable L3 observation of a *specific* L2 approval request; never a budget hold and never itself an approval.
- `CommandReceipt`: stable idempotency identity and result ref scoped by tenant, command type, actor, Assignment and payload digest.

Assignment lifecycle (P0): `QUEUED -> RUNNING -> WAITING_FOR_REVIEW -> RUNNING -> COMPLETED`, with transitions to `FAILED_RECOVERABLE`, `FAILED_TERMINAL` and `CANCELLED` as applicable. `BLOCKED` is exclusively an L2 financial verdict; the Assignment completes with that stored decision reference. Terminal Assignment states cannot be reopened by a delayed event. Recovery from `FAILED_RECOVERABLE` uses an authenticated resume, the same financial intent and a newly fenced run.

## Exclusive writer and reliable dispatch

1. A trusted inbound API authenticates tenant/actor/channel principal mapping, checks permissions and validates a normalized command.
2. Inside one SQL transaction, deduplicate `(tenantId, provider, installationId, providerEventId)` for received events and bind a backend-computed normalized payload digest. Exact retry returns the prior receipt; conflicting payload under that key fails closed. Resolve/create the case, insert/load its Assignment and command receipt, and add the start/resume outbox event atomically. Never derive tenant or actor from unchecked message fields.
3. Dispatch to Trigger.dev asynchronously from the outbox, using stable domain command keys and replayable parameters. Crash between commit and dispatch is recovered by draining the outbox. Trigger task/run-scoped deduplication, retention expiry or failed-run key clearing never replaces SQL command receipts. A stateless outbox drainer only delivers commands; it does not advance a competing workflow.
4. Claim one active run/monotonic ownership epoch per Assignment with a SQL version guard. Bind trusted tenant/actor/worker context to every protected operation; compare active run, epoch and expected version before transitions, checkpoints or new financial dispatch. CAS over state alone does not authorize the caller or fence a stale worker. Already-sent L2 calls may finish; reconcile them through their existing intent/key instead of pretending cancellation or a new owner erased the effect.
5. L3 uses L1 `processWithReceipt` or the external intake adapter and persists source/hash, pipeline run, explicit disposition and envelope references. Resolve those references through trusted readers on recovery. `SUPPLEMENTAL_CONTEXT` retains a completed run without a fabricated invoice; empty invoice/uncertain results fail closed. Context-only work cannot create a financial intent.
6. Before dispatch to L2, persist a backend-created intent binding case/source revision, proposal digest, actor, worker, requested budget and stable L2 idempotency key. Claim dispatch rights and the immutable intent in one fenced SQL transaction; stale workers cannot create another intent, while already-issued duplicate requests must retain the same payload/key. That key never depends on Trigger run/attempt ID and never changes after timeout. Query L2's authoritative command receipt when completion is unknown; only confirmed NOT_FOUND permits resubmitting the identical command/key. L2 re-resolves trusted evidence and current financial context for `decideAndCommit`.
7. On `PENDING_HUMAN_APPROVAL`, persist the original decision and approval request ID, then enter `WAITING_FOR_REVIEW`. L2 alone handles authenticated consent. Read the L2 approval lifecycle before/after registering a bounded Trigger wait and on every wake/timeout/reconciliation. RESOLVED must provide its new immutable resolution decision ID; never poll the original PENDING decision expecting it to mutate. Check resolution/request/tenant/intent bindings and record the new decision reference. Rejection, expiry or stale permission without a new L2 decision is an operational resolution, not an invented financial verdict. Wait tokens and callback payloads are notification only; keep completion credentials out of channel/model output.
8. On financial decision, persist the immutable L2 decision reference and emit a response event. A crash during delivery replays the notification without rerunning `decideAndCommit`.

Do not use multiple independent Trigger workflows or AI agent sessions as competing owners of a single Assignment; child tasks need explicit delegation and a clear parent ownership model.

SQL stores domain state and guards; Trigger remains the only durable workflow executor. Reconciliation may enqueue a wake/resume for the existing Assignment or claim a fenced replacement after termination. It cannot run a parallel financial state machine. Cancellation fences future work but remains requested while an L2 command or approval remains unresolved; record/reconcile any existing commitment before terminal status. A known committed outcome completes with its actual financial reference and cannot be hidden as CANCELLED. L3 cancellation never reverses a commitment or resolves an L2 approval.

## Failure and recovery

| Failure | Recovery rule |
| --- | --- |
| Duplicate delivery / webhook | One tenant-scoped inbound event receipt; respond with existing Assignment |
| Trigger retry after timeout | Re-read SQL state and command receipt; reuse idempotency key |
| L1 completed, receipt not delivered | Recover stored artifact/run references instead of inventing a READY invoice |
| L2 result uncertain after timeout | Query durable L2 command/decision by idempotency; NEVER commit again with a new key |
| Approval resolved but notification lost | Query approval lifecycle by request ID, load its resolution decision ID and preserve the original PENDING record |
| Wait completes/times out before L2 resolution | Re-read authoritative lifecycle; continue bounded reconciliation without inferring APPROVE/EXPIRE from the wait |
| Pending approval expired/rejected | Observe L2 lifecycle and any resolution decision; close/route operational work without inventing a financial outcome |
| Process/VM lost | Reconstruct from persisted Assignment, checkpoint and source refs |
| Channel send failed | Retry outbox notification with provider dedup semantics; no financial re-execution |
| Revoked capability | Enforce current server-side grant at every protected action, even after checkpoint |
| Source/financial context changed | Reevaluate through trusted L1/L2; prior simulation does not imply fresh approval |
| Unknown external payment attempt (future) | Halt, reconcile with provider and operator; never blindly retry transfer |

**Safe self-healing** means bounded retry, state reconstruction and escalation. It never changes policy, beneficiary or grant to make a failed financial step pass.

## Historical replay and traces

Replay uses captured IDs, versions and execution events to reconstruct/explain a historical Assignment **read-only**. Trigger.dev task retry is a new execution attempt; it is not an authoritative historical replay. Live re-evaluation is a distinct command and may produce a different result. AI model text and telemetry are not an auditable source of financial truth. Keep secrets, bank identifiers and private reasoning out of logs.

## Required adversarial tests

- Duplicate same event across two deliveries yields one Assignment.
- Crash after transactional outbox insert but before Trigger dispatch recovers task.
- Parallel workers attempting stale transition cannot both become exclusive owner.
- L2 timeout/retry yields same decision and at most one ledger commitment.
- Pending human approval survives restart; forged chat confirmation never resolves it.
- Lost approval event and resolve-before-wait race recover the new decision by approval request ID.
- Trigger deduplication expiry/failed-run recreation and stale ownership never create a new financial intent/key.
- Cancellation with an unknown L2 result reconciles before terminal status and never hides or reverses a commitment.
- Context-only L1 intake retains source/hash/run/disposition across restart and never authorizes.
- Expired/revoked authorization cannot be resumed from memory.
- Late webhook after completed Assignment cannot resurrect it.
- Cross-tenant source or case references fail closed.
- Failed notification is retried without duplicating financial decision.
- Sandbox loss does not lose assignment state.
- Terminal L2 BLOCKED is rendered as a completed blocked financial outcome.

## Non-goals

No general autonomous task scheduling, recursive arbitrary agent delegation, automatic policy tuning, continuous always-on compute, real payments, dual Eve/Trigger orchestration or Pi Durable runtime in P0.

**Implement from this reviewed contract and acceptance plan. Executable L3 tests belong in the implementation slices; no L3 runtime is claimed here.**
