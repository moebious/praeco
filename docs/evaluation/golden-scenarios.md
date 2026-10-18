# Praeco — Eight canonical synthetic payable scenarios

**Status:** acceptance specification, not passing end-to-end tests. All amounts, vendors, contracts and FX rates are fictional.

| Case | Source claim | Authoritative synthetic initial state | Expected L2 outcome | Worker Grant Seed |
| --- | --- | --- | --- | --- |
| 01 Bogotá contractor | USD 2,200 invoice | Allowlisted, account matches, contract USD 2,200 (mode `EXACT`), budget USD 5,000 | `AUTHORIZED_SIMULATED` | Limit USD 2,500; `REQUEST_SIMULATED_AUTHORIZATION` |
| 02 SaaS invoice | USD 480 recurring | Prior USD 470, max +5% tolerance (mode `RECURRING_TOLERANCE`), allowed vendor/contract/account, budget USD 5,000 | `AUTHORIZED_SIMULATED` | Limit USD 2,500; `REQUEST_SIMULATED_AUTHORIZATION` |
| 03 Mexico agency | MXN 76,000 = USD 3,800 (20 MXN/USD) | Matching contract max USD 4,000 (mode `CEILING`), budget USD 4,500, auto threshold USD 2,500 | `PENDING_HUMAN_APPROVAL` | Limit USD 2,500 (< $3,800); `REQUEST_SIMULATED_AUTHORIZATION` |
| 04 Argentina contractor | USD 1,950 PDF plus separate USD 450 bonus chat | Contract only USD 1,500 (mode `EXACT`); no authorized amendment | `BLOCKED` — contract mismatch | Limit USD 2,500; `REQUEST_SIMULATED_AUTHORIZATION` |
| 05 Forwarded duplicate | Same invoice number/vendor/period as case 01, different transport | Prior authorization preseeded in ledger | `BLOCKED` — duplicate | Limit USD 2,500; `REQUEST_SIMULATED_AUTHORIZATION` |
| 06 New beneficiary | COP 2,400,000 = USD 600 (4,000 COP/USD) | Beneficiary not allowlisted in vendor directory | `BLOCKED` — allowlist | Limit USD 2,500; `REQUEST_SIMULATED_AUTHORIZATION` |
| 07 Insufficient budget | USD 2,100 | Independently seeded available period budget USD 1,400 | `BLOCKED` — insufficient budget | Limit USD 2,500; `REQUEST_SIMULATED_AUTHORIZATION` |
| 08 Changed account | USD 1,200 | Known vendor; invoice payment account differs from trusted directory | `BLOCKED` — destination mismatch | Limit USD 2,500; `REQUEST_SIMULATED_AUTHORIZATION` |

## Required execution semantics

- Fixed demo `maxAutoApproveUsd`: **USD 2,500**.
- Default worker grant: `perPayableLimitUsd: "2500.00"`, `allowedActions: ["PROPOSE_PAYABLE", "REQUEST_SIMULATED_AUTHORIZATION"]`.
- The independent adversarial L1 corpus has at least 30 documents: eight scenarios alone do not prove extraction reliability.
- Each isolated scenario has its own authoritative vendor, contract, policy and ledger snapshot. Do not let previous scenario execution change expected results.
- Sequential budget consumption is a separate integration mode, with recorded transactions and deterministic expected state transitions.
- L1 extracts/cites source facts and normalizes monetary values; it does not know ground-truth payment outcomes.
- L3 correlates PDF and chat independently for case 04. No agent may silently upgrade chat claims into authorized contract amendments.
- L2 evaluates six financial gates (evidence, duplicates, beneficiary/account, contract, budget, threshold), with hard blockers overriding human escalation.
- A human approval request must not bypass hard blocks; re-evaluate all authoritative state at approval time.
- Every outcome includes legible gate-by-gate evidence and rationale. Simulated authorization is not payment execution.
- Golden outcomes must live in a **test-only fixture** never importable by the runtime.

## Adversarial acceptance checklist

1. **Hard-block dominance:** An invoice exceeding the auto-approve threshold that ALSO has a hard policy failure (e.g. unknown vendor, bank account mismatch, contract mismatch, or exhausted budget) must return `BLOCKED` with the hard-gate failure code, NEVER `PENDING_HUMAN_APPROVAL`.
2. **Exact decimal arithmetic:** Evaluating `MXN 50000.01 / 20` yields `USD 2500.0005`, which strictly exceeds the `USD 2500.00` auto-approval threshold and triggers `PENDING_HUMAN_APPROVAL`, proving no float rounding artifacts.
3. **Idempotency guarantees:**
   - Resending identical `(tenantId, idempotencyKey, payloadDigest)` returns the identical prior `FinancialDecisionRecord`.
   - Reusing `idempotencyKey` with a different payload digest is rejected immediately (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`).
4. **Budget concurrency & atomicity:**
   - Two concurrent decisions competing for a shared budget where `available = 1000` and each requests `700` must result in exactly one commit and one `BLOCKED: INSUFFICIENT_BUDGET`.
   - Concurrency race on auto-approve unique constraint loser returns `BLOCKED: G2_DUPLICATE` (if intent matches) or `BLOCKED: G2_CONFLICT` (if intent differs), never an unhandled SQL error.
5. **Approval lifecycle & staleness:**
   - Approvals expire at `createdAt + 24h` evaluated on read.
   - If budget is consumed during an approval wait, the subsequent approval resolution returns `BLOCKED: INSUFFICIENT_BUDGET` (G5 fresh evaluation) without invalidating the approval binding.
   - If contract, vendor account, amount, currency, policy or grant changes during the wait, approval resolution fails closed with `APPROVAL_STALE`.
6. **Worker capability grants:**
   - Missing or revoked grant action (e.g. calling `decideAndCommit` without `REQUEST_SIMULATED_AUTHORIZATION`) fails closed (`BLOCKED: GRANT_ACTION_NOT_PERMITTED`).
   - Proposing an eligible amount exceeding the worker's grant `perPayableLimitUsd` (e.g. limit $2,000 for a $2,200 invoice when G1–G5 pass) escalates to `PENDING_HUMAN_APPROVAL` (eligible excess).
7. **Contract matching semantics:**
   - `EXACT`: under-billing or over-billing fails (`UNDER_BILLING_DISALLOWED` / `CONTRACT_AMOUNT_MISMATCH`).
   - `RECURRING_TOLERANCE`: under-billing passes; over-billing $\le$ configured `maxPositiveVariancePct` passes; exceeding tolerance fails.
   - `CEILING`: amounts $\le$ ceiling pass; amounts > ceiling fail.
8. **Multi-envelope canonical claims:**
   - Multiple READY envelopes with identical canonical key and intent digest resolve to a single obligation with duplicates noted.
   - Multiple READY envelopes with identical canonical key but conflicting intent digests fail closed with `BLOCKED: AMBIGUOUS_PAYABLE_CLAIM`.
