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

Any hard failure dominates a simultaneously exceeded G6 threshold. Record a structured result for every applicable gate; record explicit SKIPPED or NOT_EVALUABLE checks if upstream evidence prevents sound evaluation. Never hide downstream hard blockers behind an early PENDING verdict.

**Canonical financial verdicts remain exactly:** `AUTHORIZED_SIMULATED`, `BLOCKED`, `PENDING_HUMAN_APPROVAL`. REVIEW_REQUIRED and PROCESSING_FAILED are **L1 processing states**, not new L2 financial verdicts. An L1 non-ready envelope cannot result in authorization.

### Canonical payable business identity (MVP)

Use `(tenantId, canonicalVendorId, normalizedInvoiceNumber)`. Resolve canonical vendor identity **from trusted records**; never use a raw display name, source hash, email sender, bank account last four digits or agent-generated vendor ID as sufficient evidence. Normalize invoice numbers deterministically (Unicode normalization, outer whitespace removal, case folding); do not aggressively strip punctuation or leading zeros without an explicit rule. Invoice issue date, billing period, amount, currency and originating external ID are *corroborating attributes*, not separate bypasses for a conflicting canonical key.

If multiple distinct liabilities plausibly share this key, fail closed and require separately governed administrative correction outside the MVP. Exact retry of an existing request returns the prior committed decision; a fresh request referencing an already committed obligation is blocked and logged. L3 associates PDF, email, chat and ERP records to one case; L2 remains the arbiter of business duplication.

### Contract tolerances

A tolerance is valid only when explicitly configured in a trusted, versioned contract or approved amendment. For the canonical SaaS scenario the approved recurring reference is USD 470 with a **maximum 5% positive variance**; USD 480 qualifies. Other contracts default to exact matching under their own agreed amounts, currency and periods. Compare unrounded exact decimals; apply any configured rounding only at the declared comparison boundary. A chat-only claim of an additional USD 450 never constitutes a contract amendment.

### Human approval

Only an authenticated, tenant-bound `FinanceAdmin` may authorize a specific eligible over-limit decision. The approval must bind the payable ID, exact source financial amount/currency, normalized amount and FX snapshot, canonical vendor and destination fingerprint, applicable budget, policy/grant revisions, action and expiry. The approver may **not** bypass G1–G5 or broaden vendor/category permissions.

An approval decision does not blindly change PENDING to AUTHORIZED. It triggers an **entirely fresh** trusted L2 evaluation and atomic budget commit. At G6, a current, valid, single-use, human-scoped approval satisfies the explicit exception authorization for the bound threshold excess; without this distinction, above-threshold items would loop forever in PENDING. If amount, beneficiary, budget, contract or policy changes, fail the stale grant and require a fresh eligible request. Rejection/expiry/cancellation are auditable approval lifecycle events, not new financial verdict types. Pending approval does **not** hold funds in P0.

Proposed P0 expiry: **24 hours** from creation, tested with an injectable clock. Changing the expiry is a configuration revision; not an agent decision.

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
