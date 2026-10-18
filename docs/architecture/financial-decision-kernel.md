# L2 — Deterministic Financial Decision Kernel

**Status:** Proposed / Under Review (not an accepted ADR or implemented subsystem)
**Date:** 2026-10-17
**Scope:** 30X Hackathon — Blinka Accounts Payable, synthetic-only
**Related:** [L1 architecture](evidence-intelligence.md) · [L1 contract](../../packages/evidence-intelligence/src/contracts.ts) · [Golden scenarios](../evaluation/golden-scenarios.md) · [Agent Wallets](agent-wallets.md) · [Solution design](solution-design.md)

> **Design thesis:** probabilities and untrusted observations may propose an obligation; only trusted, versioned financial state and deterministic code may authorize a simulated commitment.

## 1. Authority and boundary

L2 is the **sole authority** for business payable deduplication, beneficiary/account eligibility, contract compliance, available budget, policy limits, the authorization decision, and its financial ledger effect. L1 supplies evidence-backed financial observations and exact-decimal normalization. L3 submits a proposed action and displays the result; it never makes its own binding financial verdict. No real payments, cards, crypto transfers, or bank connections are part of this design.

- A model's text, group-chat handoff, sandbox state, document, memory file, retrieved RAG chunk, or DocJev classification is **not** an authorization credential.
- A purported L1 envelope supplied by an agent must be resolved to a trusted persisted source/report; never accept a self-asserted READY JSON object.
- A source SHA-256 identifies bytes for technical replay. A **payable/obligation identity** identifies the financial liability; the two are not interchangeable.
- Authoritative vendor accounts, contracts, approved amendments, budgets, policies and human identities are resolved server-side under tenant isolation.

## 2. Six gates

| Gate | Deterministic question | Relevant failure |
| --- | --- | --- |
| G1 — Evidence admissibility | Is the L1 result READY_FOR_POLICY_EVALUATION, backed by a trusted ACCEPTED digest-bound verification report and valid source references? | Non-ready, forged or contradictory critical evidence **never** authorizes |
| G2 — Duplicate payable | Does this business obligation already have a committed or conflicting record, including across channels and altered source hashes? | Hard block |
| G3 — Vendor / beneficiary / account | Is the vendor allowlisted, its identity resolved, and the full payment destination an exact trusted-account match? | Hard block |
| G4 — Contract compliance | Is an authoritative contract/PO and approved amendment applicable to amount, currency, dates and tolerance? | Hard block unless a specifically defined review path is later approved |
| G5 — Budget | Does the authoritative available budget cover the proposed commitment after other commitments and any active holds? | Hard block on insufficiency |
| G6 — Autonomous authorization | Is the action within the scoped agent capability and autonomous transaction limit? | If G1–G5 pass, exceeding **only** an eligible autonomy threshold yields human approval |

**Precedence:** evaluate all applicable hard controls before selecting escalation; any hard block dominates G6 approval eligibility. Do not stop on the first review candidate and conceal a later hard block. Record each gate's structured checks and whether an upstream failure prevented evaluation. Missing critical facts fail closed; exact mapping between documentary correction and BLOCKED vs separate L1 review remains an integration decision, never automatic authorization.

**Canonical L2 outcomes (exactly):**
- AUTHORIZED_SIMULATED — an authorized **simulated** obligation/commitment; **not** PAID or a real transfer.
- BLOCKED — at least one hard failure, insufficient budget, inadmissible evidence, or other non-overridable ineligibility.
- PENDING_HUMAN_APPROVAL — all hard gates passed, but a specifically eligible authorization exceeds autonomous scope.

Approval request lifecycle states (approved, rejected, expired, cancelled, `APPROVAL_BLOCKED`) are **not additional L2 verdicts**. An eligible human response triggers a **fresh L2 evaluation** against current authoritative state. When that re-evaluation hard-fails (including a lost or revoked grant action at G6), the request closes in the terminal lifecycle state `APPROVAL_BLOCKED`: the recorded decision is the canonical `BLOCKED` verdict and approval is consent, never an override of G1–G5.

## 3. Conceptual interfaces (not implementation contracts)

- **FinancialDecisionKernel.evaluate(context) -> evaluation**: side-effect-free and deterministic given an immutable policy/data snapshot; contains checks, policy and rule versions, referenced evidence and candidate outcome.
- **FinancialAuthorizationService.decideAndCommit(command) -> decision record**: obtains authoritative context, evaluates and atomically records the decision plus the budget effect/idempotency marker.
- **FinancialAuthorizationService.resolveApproval(command) -> decision record**: verifies actor and scoped approval, reevaluates *all* gates in a transaction, then records the new outcome.

A preview evaluation must not be mistaken for an authorization. A passing preview becomes stale when budget, vendor, policy or contract state changes.

## 4. Money, FX, policy and state

Use base-10 exact decimal math; never JS floating-point for money. L1 pins demo FX snapshots of **USD identity; 1 USD = 4,000 COP; 1 USD = 20 MXN**, with explicit HALF_EVEN rounding to two USD decimals, source amount and calculation trace. L2 retains the original currency and L1 verified normalization; all budget comparisons follow a declared currency/rounding policy. Do not silently recalculate with live FX.

Version policies and capability grants. Persist authoritative policy revision and a digest/snapshot reference with each evaluation and decision. Chat-derived suggestions may produce **policy change proposals only**; activation requires an authenticated, authorized administrator and an auditable new version. Saved agent memory must never mutate vendor bank details, limits, contracts or allowlists.

## 5. Transactional budget and ledger invariants

Neon PostgreSQL + Drizzle is the **preferred, not yet approved** storage implementation. Whichever SQL backend is selected, L2 must implement the following guarantees:

1. One business obligation cannot be committed twice, even with different files, email forwards or multiple concurrent workers.
2. Budget availability cannot be overspent by parallel authorizations. Lock/serialize the relevant budget allocation or apply an equivalent atomic conditional update; enforce constraints on identities and idempotency keys.
3. Decision and budget mutation are committed consistently within an authoritative transaction. A failed transaction cannot yield a durable authorization event.
4. Retries, replays and duplicate Trigger.dev deliveries do not duplicate simulated commitments or ledger entries.
5. Financial events are append-only at the application authority boundary; corrections use compensating entries. Ordinary DB administrator privileges still require operational controls and do **not** make a SQL table cryptographically immutable.
6. Model workers and Daytona sandboxes never receive direct write access to financial tables or policy administration.
7. A human approval cannot override any hard gate, and cannot authorize based solely on stale wallet balance or an old preview.

**Pending approvals / reservations — open decision.** Decide whether PENDING_HUMAN_APPROVAL creates an expiring atomic hold or consumes no budget until reapproval. Document expiry, cancellation, race handling and free-balance display *before* implementing approval. Neither a chat banner nor a Trigger waitpoint is a financial reserve.

## 6. Reproducibility and security

A decision record should contain tenant and payable identities, requested amount and verified FX, trusted L1 references and hashes, authoritative vendor/account/contract/budget snapshot references, policy and evaluator versions, six gate results, autonomy/capability identity, outcome, actor, ledger transaction reference, timing, and approval linkage if relevant. Sensitive payment account numbers must be redacted in logs/UI; last four characters are **display only**, never an account-match algorithm.

Support two clearly labeled replay modes:
- **Historical replay:** evaluate against captured original facts and versioned policy to explain the original decision, without modifying balances.
- **Current re-evaluation:** obtain fresh authoritative state to decide whether a pending/new action can be authorized now.

Instrument correlation IDs (source, case, assignment, Trigger run, decision); Sentry/LLM traces cannot replace the authoritative ledger. No production-level guarantees are claimed until adversarial integration tests have been executed.

## 7. Acceptance and integration

[The golden scenario specification](../evaluation/golden-scenarios.md) remains the test oracle, never visible to the runtime or LLM. Current expected breakdown: **2 AUTHORIZED_SIMULATED, 1 PENDING_HUMAN_APPROVAL, 5 BLOCKED**. Examples include an altered-hash duplicate, account mismatch, a non-allowlisted vendor, unavailable budget, and a chat-only contract bonus without approved amendment. Each isolated scenario must seed independent authoritative state. Additional sequential/concurrent scenarios must declare shared-ledger semantics.

Required pre-implementation / release tests:
- Every hard-gate failure dominates a simultaneous above-threshold approval candidate.
- Duplicate arrival by different channels and idempotent retries yield at most one commitment.
- Two concurrent otherwise-valid invoices cannot consume the same remaining balance twice.
- Rejection/expiry/approval of a pending action is auditable and cannot bypass fresh policy checks.
- Money normalization is exact and the financial record preserves the trusted FX snapshot.
- Historic replay is read-only and produces an explainable version-bound result.
- Tenant separation and least-privilege tool access are enforced.

## 8. Decisions still open

- Exact payable business key and cross-source corroboration policy.
- Contract tolerance and which variances, if any, are eligible for human review.
- Enterprise budget scope, wallet allocation model, and reservation-on-pending semantics.
- Approval authority model, signature/evidence of consent, expiration, revocation and policy-change governance.
- SQL schema, transaction isolation strategy and event retention.
- Data migrations and operational controls for Neon, if adopted.

**Non-goal:** building a general-purpose agent policy engine or making claims of production financial authorization for a hackathon prototype.

## 9. Precedents / reading

- [Calvino reference implementation](https://github.com/moebious/factored-hackathon-2026-calvino): versioned deterministic policy gates and replay; its Python decision log is **not** a financial transactional ledger.
- [AI Teammates reference](https://github.com/code-with-antonio/ai-teammates): conversations, handoffs and durable chat, **not** financial policy authority.
- [Praeco L1 accepted boundary](../adr/001-evidence-boundaries.md).
