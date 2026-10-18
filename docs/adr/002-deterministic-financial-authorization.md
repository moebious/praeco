# ADR-002 — Deterministic Financial Authorization

**Status:** Proposed for review (L2 architecture closure; not yet implemented)
**Date:** 2026-10-17
**Scope:** Praeco / 30X Blinka hackathon — synthetic Accounts Payable
**Supersedes:** No accepted ADR. Complements ADR-001 and the existing L2 proposal.

## Context

Praeco turns untrusted invoices into payable proposals. A model, chat message, external accounting record, remembered instruction or sandbox action must never become financial authority merely by being available to an agent. The challenge requires autonomous decisions, clear explanations, a bounded human-approval path, and **zero payments authorized outside configured rules**. No real transfers are required or permitted in the hackathon.

L1 v3.0.0 is the accepted, provider-independent evidence contract. L3 owns multichannel PayableCase correlation and task orchestration. L2 alone owns business eligibility, simulated commitments, authoritative policy state and financial outcomes.

## Decision

### Authority boundary

- L3 submits references to proposed obligations, **not** an agent-authored verified invoice or authority claim.
- L2 resolves every READY envelope through the trusted backend L1 reader (including stored verification bindings), and resolves authoritative financial context server-side under an authenticated tenant.
- A trusted context resolver is a **read-only port** over versioned synthetic records in P0; possible future Blinka/ERP adapters do not gain authority to modify L2 rules.
- Evaluation and authorization are distinct: a read-only preview cannot commit funds, and a stale preview cannot be used as an approval.
- L2 is independent of Pi, Trigger.dev, AI SDK, MCP, Daytona, Stripe Link and any banking provider.

### Six ordered financial gates

| Gate | Mandatory evaluation | On failure |
| --- | --- | --- |
| G1 Evidence admissibility | Trusted persisted L1 READY envelope, accepted digest-bound report, sufficient critical facts and references | Hard block |
| G2 Duplicate obligation | No previously committed/conflicting payable with the same canonical business identity, regardless of file hash/channel | Hard block |
| G3 Beneficiary / account | Approved canonical vendor, permitted beneficiary and **full exact** trusted payment destination | Hard block |
| G4 Contract | Applicable trusted contract/PO/amendment; amount and period match explicit currency/tolerance rules | Hard block |
| G5 Budget | Sufficient authoritative USD-period budget when committing, considering all prior simulated commitments | Hard block |
| G6 Delegated autonomy | Agent has an active scoped capability and is within per-payment and configured per-period autonomous ceilings | Eligible threshold excess: human review; missing/revoked/out-of-scope capability: hard block |

Any hard failure dominates a simultaneously exceeded G6 threshold. When hard gates G1–G5 fail, G6 must still be evaluated and recorded as `REVIEW_ELIGIBLE` with fact `dominated: true` to preserve the complete audit trail. Record a structured result for every applicable gate; gate status is strictly `PASS`, `FAIL`, `REVIEW_ELIGIBLE`, or `NOT_EVALUABLE` (with an explicit reason code) if upstream evidence prevents sound evaluation. Never hide downstream hard blockers behind an early PENDING verdict.

**Evidence prefiltering and G1 semantics:** L3 prefilters incoming envelopes and never submits non-ready envelopes to L2 (non-ready is an L3 operational review state visible in the UI with no L2 decision record). L2's `G1` `FAIL` is strictly reserved for envelopes that were asserted ready at proposal time but fail server-side verification at decision time (e.g. tampering, artifact corruption, or report binding mismatch).

**Canonical financial verdicts remain exactly:** `AUTHORIZED_SIMULATED`, `BLOCKED`, `PENDING_HUMAN_APPROVAL`. REVIEW_REQUIRED and PROCESSING_FAILED are **L1 processing states**, not new L2 financial verdicts. An L1 non-ready envelope cannot result in authorization.

### Canonical payable business identity and multi-envelope claims

Use length-prefixed canonical key encoding (`${tenantId.length}:${tenantId}:${canonicalVendorId.length}:${canonicalVendorId}:${normalizedInvoiceNumber.length}:${normalizedInvoiceNumber}`) to prevent delimiter-collision attacks (such as invoice numbers containing `:`). Resolve canonical vendor identity **from trusted records** by joining on **canonicalized tax ID** (uppercase alphanumeric, punctuation stripped) with an exact match; missing or ambiguous tax ID fails closed (`BLOCKED: VENDOR_TAX_ID_UNRESOLVED`). The vendor master owns canonical display names; L1's observed legal name is a corroboration field, never a primary join key. Normalize invoice numbers deterministically (Unicode normalization, outer whitespace removal, case folding); do not aggressively strip punctuation or leading zeros without an explicit rule.

**Multi-envelope and duplicate handling (MVP):**
1. Obligation rows (`payable_obligations`) are created **only at commit**, never at PENDING.
2. When multiple READY invoice envelopes share an identical canonical key and identical intent digest within a case or across channels, they constitute one obligation: select a deterministic representative (the earliest registered source) and record the others as corroborating duplicates.
3. Multiple READY invoice envelopes with the same canonical key but different intent digests fail closed with `AMBIGUOUS_PAYABLE_CLAIM`. Supplemental context sources (`CHAT`/`EMAIL`) contribute zero invoice fields.
4. G2 checks committed obligations only. In concurrent execution for the same payable, the unique-constraint loser on commit records a `BLOCKED` decision (`G2_DUPLICATE` if identical intent digest, or `G2_CONFLICT` if different intent digest), never an unhandled driver error and never a retry with a new key.
5. Duplicate arrivals while a prior request is PENDING are permitted at initial evaluation and caught during atomic approval-time re-evaluation. Resubmission after expiry creates a fresh PENDING request with a new approval request.

### Contract matching taxonomy

A contract record explicitly declares its matching mode:
- `EXACT`: Contract amount, currency, and period must match exactly. Under-billing is a mismatch and fails closed with `UNDER_BILLING_DISALLOWED`.
- `RECURRING_TOLERANCE`: An approved recurring reference amount with a declared `maxPositiveVariancePct` (for the canonical SaaS scenario, reference USD 470 with max 5% positive variance; USD 480 qualifies). Tolerance applies to positive variance only; under-billing passes.
- `CEILING`: An approved upper bound (e.g., maximum USD 4,000 for agency work). Amounts at or below the ceiling pass; amounts exceeding the ceiling fail G4.

Compare unrounded exact decimals in the contract's currency using L1 normalization. A chat-only claim of an additional bonus (such as USD 450 in Case 04) never constitutes a contract amendment.

### Budget period assignment

Assigning a payable to a corporate budget period `(tenantId, YYYY-MM)` uses a deterministic fallback chain:
1. UTC month of the observed invoice `issueDate` when `OBSERVED`.
2. Fallback to the UTC month of the observed `dueDate` (guaranteed observed by L1 critical fields) with a recorded reason code (`PERIOD_FROM_DUE_DATE`).
3. Billing period is recorded non-blocking context; for net-terms invoices where service period precedes invoice issue month, mismatch is informative and does not block.

### Delegated autonomy and threshold evaluation (G6)

G6 checks worker capability grants and autonomous ceilings uniformly across all proposals, regardless of initiator. A proposal exceeding the autonomous ceiling initiates the normal `PENDING_HUMAN_APPROVAL` workflow; an authenticated `FinanceAdmin` may then exercise the bound, single-use approval action to authorize it. Missing or revoked grant actions fail closed (`BLOCKED: GRANT_ACTION_NOT_PERMITTED`), while an eligible amount exceeding the worker or policy ceiling escalates (`PENDING_HUMAN_APPROVAL`).

### Human approval lifecycle and staleness

Only an authenticated, tenant-bound `FinanceAdmin` may authorize a specific eligible over-limit decision. The approval binds the payable ID, exact source financial amount/currency, normalized amount and FX snapshot, canonical vendor and destination fingerprint (using keyed HMAC with a synthetic fixture-supplied key of ≥ 32 bytes, defined in test fixtures, never in spec text), budget identity and limit revision (`budgetId` + `limitUsd` revision), contract/policy/grant revisions, and expiry.

An approval decision does not blindly change PENDING to AUTHORIZED. It triggers an **entirely fresh** trusted L2 evaluation and atomic budget commit.
- **Budget consumption is not staleness:** Changes to `committedUsd` during an approval wait do not invalidate the approval binding. Instead, fresh evaluation of G5 catches budget exhaustion and legitimately returns `BLOCKED: INSUFFICIENT_BUDGET`.
- **Staleness is reserved for structural changes:** If amount, currency, beneficiary, payment destination, contract revision, policy revision, or grant revision changes between request and approval, fail the stale grant and require a fresh eligible request.
- **Expiry:** Exactly **24 hours** from approval request creation (`createdAt + 24h`), evaluated on read against an injectable clock. Pending approval does **not** hold funds in P0.

### Monetary policy and Blinka extensibility

Use exact base-10 decimal arithmetic. Preserve L1's fixed fictional demo FX snapshots: USD identity, 4,000 COP/USD and 20 MXN/USD, HALF_EVEN for displayed USD cents. Exact threshold comparisons must not use already-rounded display USD. P0 has one USD corporate budget per tenant/month, with month boundaries in UTC and no actual banking-balance requirement. Budget and available cash are **different facts**.

Future Blinka balance, vendor and route information may be consumed via a trusted versioned financial context adapter, but neither a banking API read nor a payment credential changes the six-gate authority model. Live FX quotes, payouts, ACH, SWIFT, cards and payment execution are out of scope. `AUTHORIZED_SIMULATED` never means PAID.

## Rejected alternatives

- LLM-directed allow/deny or agent-authored ready evidence.
- Human “approve anyway” bypass of contract, duplicate, vendor or budget gates.
- Using source SHA-256 or external ERP Bill ID alone as payable identity.
- Requiring MCP, Link CLI or a payment provider to authorize a simulation.
- Treating a preview, a Trigger waitpoint or a chat approval message as committed financial state.

## Consequences and verification

L2 must implement a side-effect-free deterministic evaluator and a trusted transactional authorization service. Every decision includes structured gate checks, tenant/actor identity, evidence references, original/normalized amounts, authoritative context versions, policy/grant revision, reason codes, timestamp and ledger/approval linkage. Sensitive accounts are redacted from logs and inspector UI.

Acceptance requires all eight canonical isolated golden scenarios (2 authorized simulated, 5 blocked, 1 pending), threshold-versus-hard-gate precedence, idempotency, concurrency and approval re-evaluation tests. Historical replay is read-only. The test oracle must remain inaccessible to the runtime. The accepted L1 v3.0.0 contract remains untouched.

**This ADR is a proposed decision for review in its draft PR; merge/acceptance is the formal ratification step.**
