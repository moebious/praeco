# ADR-005 — Durable Assignment Execution, Recovery and Runtime Ownership

**Status:** Proposed for review; not implemented
**Date:** 2026-10-17
**Depends on:** ADR-001–004

## Decision

**Trigger.dev owns every P0 financial Assignment workflow.** Vercel AI SDK is an inference/tool-loop library invoked inside bounded steps, **not** a second durable orchestrator. Chat SDK owns channel transport/conversation state only, not financial work. Praeco's authoritative operational record lives in tenant-scoped SQL; L2 alone owns financial commitments and approvals.

Eve and Pi Durable are **deferred alternative architectures**, not runtime dependencies, fallback workers or silent double executors. No continuous process or VM is required for an agent to remain persistent.

## Canonical semantics

- `PayableCase`: tenant-bound cross-source documentary/business *workspace*, not L2's canonical payable obligation or a duplicate verdict.
- `Assignment`: durable business responsibility with ID, tenant, type, principal, initiating actor, case, capability scope, state, version, creation/update timestamps and outcome references. A message, run, model turn or sandbox is not an Assignment.
- `AgentRun`: one bounded execution attempt within an Assignment with `triggerRunId`, attempts, progress and termination reason.
- `Checkpoint`: persisted **logical** progress marker with safe input/output refs and version, not serialized private chain of thought, ephemeral model execution stack or payment credential.
- `ExecutionEvent`: append-only operational transition with causation/correlation and idempotency identity; a notification is not a decision record.
- `ApprovalWait`: durable L3 observation of a *specific* L2 approval request; never a budget hold and never itself an approval.
- `CommandReceipt`: stable idempotency identity and result ref scoped by tenant, command type, actor, Assignment and payload digest.

Assignment lifecycle (P0): `QUEUED -> RUNNING -> WAITING_FOR_REVIEW -> RUNNING -> COMPLETED`, with transitions to `FAILED_RECOVERABLE`, `FAILED_TERMINAL` and `CANCELLED` as applicable. **These are workflow states, not L2 financial verdicts.** A financial `BLOCKED` decision completes the assignment investigation as `COMPLETED` referencing the immutable blocked decision record; it must not be confused with `FAILED_TERMINAL` infrastructure failure.

## Exclusive writer and reliable dispatch

1. A trusted inbound API authenticates tenant/actor/channel principal mapping, checks permissions and validates a normalized command.
2. Inside one SQL transaction, deduplicate `(tenantId, provider, providerEventId)` for received events; resolve/create the case; insert or load an `Assignment` and `CommandReceipt`; add an outbox event to start or resume its workflow.
3. Dispatch to Trigger.dev asynchronously from the outbox, using stable idempotency keys and replayable parameters. Crash between commit and dispatch is recovered by the Reconciler draining the outbox. Trigger may redeliver: the domain-level command receipt prevents duplicate assignment or financial effects.
4. The workflow state machine advances via compare-and-swap version transitions/unique write constraints. Task workers report outcomes and versioned event records. A retry must never overwrite a terminal state from a newer run. Queue concurrency is 1 per assignment.
5. L3 calls trusted L1 through registered sources and identifiers; collects stored envelope references. An empty/supplemental L1 result is a distinct admissible *operational* disposition, not READY evidence. L3 prefilters non-ready envelopes and never submits them to L2.
6. If a payable is eligible for L2, use stable per-intent L2 idempotency (`sha256(tenantId + ":" + canonicalPayableKey + ":" + intentDigestSha256)`). L2 re-resolves trusted evidence and current financial context for `decideAndCommit`.
7. On `PENDING_HUMAN_APPROVAL`, persist the L2 approval request ID and the Trigger wait token (`triggerWaitToken`) on the `Assignment` record and enter `WAITING_FOR_REVIEW`. Deliver notifications through outbox. The authenticated approver action is handled by L2; once L2 commits its decision, the web approval API completes the Trigger wait token synchronously. Trigger wait tokens are wake-up signals, not proof of finance authorization.
8. On financial decision, persist the immutable L2 decision reference and emit a response event. A crash during delivery replays the notification without rerunning `decideAndCommit`.

## The Reconciler

A named **Reconciler** running as a Trigger.dev scheduled task (15–30s cadence, tenant-batched) owns three explicit recovery duties:
1. **Outbox draining:** Drain undispatched outbox rows (L3 outbox, and calls trusted L2 outbox export/drain port if configured).
2. **Approval observation:** Read L2 approval lifecycle state (derived expiry `createdAt + 24h` evaluated on read); for expired or resolved approvals, transition L3 assignments to `COMPLETED` and complete L3 waits. The Reconciler never writes or mutates L2 state directly.
3. **Wait completion fallback:** Completes suspended Trigger waitpoints if the synchronous completion call by the web API failed or timed out.

Do not use multiple independent Trigger workflows or AI agent sessions as competing owners of a single Assignment; child tasks need explicit delegation and a clear parent ownership model.

## Failure and recovery

| Failure | Recovery rule |
| --- | --- |
| Duplicate delivery / webhook | One tenant-scoped inbound event receipt; respond with existing Assignment |
| Trigger retry after timeout | Re-read SQL state and command receipt; reuse idempotency key |
| L1 completed, receipt not delivered | Recover stored artifact/run references instead of inventing a READY invoice |
| L2 result uncertain after timeout | Query durable L2 command/decision by idempotency; NEVER commit again with a new key |
| Pending approval expired/rejected | Observe immutable L2 state and close/route case; do not invent approval |
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
- Expired/revoked authorization cannot be resumed from memory.
- Late webhook after completed Assignment cannot resurrect it.
- Cross-tenant source or case references fail closed.
- Failed notification is retried without duplicating financial decision.
- Sandbox loss does not lose assignment state.
- Terminal L2 BLOCKED is rendered as a completed blocked financial outcome.

## Non-goals

No general autonomous task scheduling, recursive arbitrary agent delegation, automatic policy tuning, continuous always-on compute, real payments, dual Eve/Trigger orchestration or Pi Durable runtime in P0.

**Implementation proceeds only after the contracts and tests are reviewed.**
