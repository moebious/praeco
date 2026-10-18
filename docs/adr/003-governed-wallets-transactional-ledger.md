# ADR-003 — Governed Agent Wallets and Transactional Ledger

**Status:** Proposed for review (not implemented)
**Date:** 2026-10-17
**Related:** ADR-001, ADR-002, `docs/architecture/agent-wallets.md`

## Decision

An Agent Wallet is a **revocable scope of financial authority**, not a bank account or stored-value balance. P0 has one company-wide USD budget for each tenant and UTC accounting month. Agents share this pool; a grant limits the **subset** of actions an agent may request, not a second source of funds.

- Corporate budget: `(tenantId, periodKey=YYYY-MM)`, `limitUsd`, `committedUsd` (stored in exact unrounded USD), immutable revision metadata.
- Capability grant: worker identity, tenant, allowed actions (`PROPOSE_PAYABLE` and `REQUEST_SIMULATED_AUTHORIZATION`), authorized vendors/categories if set, per-payable USD limit, any optional per-period autonomous ceiling, period of validity, grant version and revocation.
  - **Command to Action Mapping:** L2 `decideAndCommit` requires `REQUEST_SIMULATED_AUTHORIZATION`. L2 `preview` requires `PROPOSE_PAYABLE`.
  - **Profile Scoping:** Grants bind to the worker identity; Vera/Kael/Nova specialization lives in L3 tool routing. In L2, grant has `workerId`, tenant, and optional `capabilityProfile` metadata.
- No pending-approval holds/reservations in P0; a pending decision is not committed and does not reduce available budget.
- An approved over-threshold exception is single-use, bound to the specific financial intent and current policy, and is not a permanent grant increase.
- Reject or flag any rule configuration that contradicts the invariant: an over-limit human approval cannot override a hard financial gate.

**Available budget = period limit - committed simulated obligations** (P0 only). This represents budget eligibility, **not bank liquidity**. Do not display total balances across agent wallets as if they were additive. Future reservations and banking balances require separate designs.

## Write-side transaction

Use Neon PostgreSQL (via Drizzle or equivalent) as the planned authoritative financial store. Make the database, rather than an agent run, authoritative.

A protected `decideAndCommit` command MUST:

1. Authenticate and bind tenant and invoking actor server-side. Validate stable idempotency key scope and payload digest.
   - **Idempotency Key Derivation:** `idempotencyKey = sha256(tenantId + ":" + canonicalPayableKey + ":" + intentDigestSha256)`.
2. Resolve L1 `reader.loadReady` by trusted envelope reference; do not accept an agent-supplied READY object. Resolve versioned vendor, destination, contract, company policy, grant and budget context.
3. Enter a database transaction and **serialize the relevant budget row** (row lock or atomic conditional update); take appropriate serializable/unique-key protection for payable identity and command deduplication.
4. Recheck all authoritative mutable facts used in the transaction: invoice obligation identity, duplicate status, vendor/account/contract versions, budget and grant/policy versions. Any upstream lookup without a stable snapshot/version must be revalidated or fail closed.
5. Evaluate the six gates using exact decimals; write a decision record for all results.
   - For `AUTHORIZED_SIMULATED`, insert a unique commitment and append-only ledger event and update the protected budget exactly once in the same transaction.
   - For concurrent auto-approve attempts on the same payable key, the unique-constraint loser catches the constraint and records a `BLOCKED` decision (`G2_DUPLICATE` if identical intent digest, `G2_CONFLICT` if different intent digest), never an unhandled driver crash or new-key retry.
   - For BLOCKED or PENDING, commit audit records but no budget change.
6. Store the command idempotency outcome atomically with decision; repeated identical commands return the **same** durable decision, with no new ledger mutation. Reject reuse of the same key with different payload (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`).
7. Insert transactional outbox record atomically in the same database transaction. The primary delivery path dispatches immediately post-commit; the trusted Reconciler acts as fallback poller to drain stranded outbox rows (e.g., if the process terminates between commit and immediate dispatch). Never emit successful authorization before SQL commit.

Use tenant-scoped composite keys, unique constraints for committed business obligations and idempotency, nonnegative USD budget/commitment constraints, and protected server-only mutations. The budget and commitment data must be consistent under concurrent submissions. DB isolation choice is implementation-specific but acceptance tests must demonstrate it.

For P0, synthetic context that would become external is stored in the same trusted SQL boundary. A future Blinka API read cannot participate atomically in PostgreSQL and will require its own verified snapshot/freshness and external execution reconciliation.

## Human approval lifecycle

An eligible above-threshold request creates an immutable requested-intent snapshot with `PENDING_HUMAN_APPROVAL` and a separate mutable lifecycle record. Approval grants may be issued only by a tenant-scoped `FinanceAdmin` after authenticated server-side consent and expire 24 hours after approval request creation (`createdAt + 24h`, P0), evaluated on read.

On approval: verify approver role and allowed scope, approval status, expiry, original amount/currency, L1 snapshot, vendor and destination (using keyed HMAC with a synthetic fixture-supplied key of ≥ 32 bytes, defined in test fixtures, never in spec text, never raw unkeyed hash), budget identity and limit revision (`budgetId` + `limitUsd` revision), policy/grant revision, then lock the approval row to ensure single use. Re-resolve trusted state and re-evaluate **all** hard gates.
- If everything still qualifies, consume the one-off threshold exception only for the matching intent and commit atomically.
- **Budget exhaustion during wait:** A change in `committedUsd` during the approval wait does not invalidate the approval binding; rather, the fresh G5 re-evaluation catches the budget exhaustion and legitimately returns `BLOCKED: INSUFFICIENT_BUDGET`.
- **Structural staleness:** If amount, currency, beneficiary, destination, contract, policy, or grant revision has changed, record stale/invalid approval and require a new request. Rejection and expiry never debit budget.

Retries of the same approval command return the previous decision; simultaneous approval submissions cannot authorize twice. A late approval can legitimately return BLOCKED when budget has been consumed. Approval is consent, never an override of G1–G5.

## Ledger and audit

Store append-only simulated financial events with stable event/decision IDs, tenant, payable, actor, command idempotency, occurred-at, original currency, exact amounts, FX snapshot and policy/evidence reference. Correction entries compensate prior commitments; they do not mutate historical events. Database operations under ordinary admin privileges are not cryptographically immutable: do not claim otherwise.

Historical replay loads the original captured evidence and versioned context **read-only** and reproduces the original financial checks; current re-evaluation deliberately consults up-to-date state, and may differ. Never commit on historical replay.

Every displayed outcome must distinguish `AUTHORIZED_SIMULATED` from `PAID`. Never expose complete bank identifiers or provider secrets in agent traces, logs or UI.

## Required adversarial acceptance

- Two simultaneous USD 700 authorizations against USD 1,000 available: **at most one commits**.
- Duplicate arrivals from two distinct source hashes: at most one business obligation is committed.
- Concurrent retries using same key produce one decision/commitment; conflicting payloads using same key fail.
- Threshold-eligible payable plus hard-invalid vendor/contract/budget returns BLOCKED, not PENDING.
- Pending approval consumes no budget; approval at T+24h or after revocation fails.
- Approval after another commitment exhausts budget cannot authorize.
- Policy or recipient change after approval request invalidates stale permission; no bypass.
- Source- or tenant-tampered envelope does not reach authorization.
- Financial historical replay never mutates ledger.

## Non-goals

Real payments, account custody, payouts, Link wallets, MCP-based authority, bank balance synchronization, distributed transactions across banks, settlement and financial regulations are outside P0.

**This ADR is submitted for review, not claimed implemented or formally accepted until merged.**
