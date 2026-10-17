# BLINKA v3.0 — Eight Scenario Cross-Layer Acceptance Contract

**Status:** Test design and ground truth expectations. **Not executed.** Synthetic raw PDFs/emails/chat records, mocks and automated test runner must still be created. The manifest is `../fixtures/demo-day-8-scenarios.json`.

## Scenario matrix

| ID | L1 must extract / cite | L2 ground truth / seeded state | Expected L2 outcome |
|---|---|---|---|
| 01 | Bogotá contractor invoice USD 2,200 | Allowlisted, matching account, contract USD 2,200, budget 5,000, threshold 2,500 | `AUTHORIZED_SIMULATED` |
| 02 | SaaS invoice USD 480 | Prior recurring baseline USD 470; 2.13% change < 5%; otherwise allowed | `AUTHORIZED_SIMULATED` |
| 03 | Mexico invoice MXN 76,000, FX 20 MXN/USD → USD 3,800 | Valid contract limit 4,000 and budget 4,500; threshold 2,500 | `PENDING_HUMAN_APPROVAL` |
| 04 | Argentina PDF USD 1,950 + separate chat about USD 450 bonus | Contract fixed USD 1,500; no authorized amendment | `BLOCKED` (`CONTRACT_AMOUNT_MISMATCH`) |
| 05 | Forwarded invoice USD 2,200, same vendor + invoice number + period as case 01 | Ledger **seeded with prior authorization** | `BLOCKED` (`DUPLICATE_EXISTING_AUTHORIZATION`) |
| 06 | Colombia COP 2,400,000, FX 4,000 COP/USD → USD 600 | Beneficiary not allowlisted | `BLOCKED` (`BENEFICIARY_NOT_ALLOWLISTED`) |
| 07 | Invoice USD 2,100 | Independent seeded budget snapshot: USD 1,400 available | `BLOCKED` (`INSUFFICIENT_PERIOD_BUDGET`) |
| 08 | Invoice USD 1,200 with source payment account | Authorized vendor but different registered account | `BLOCKED` (`PAYMENT_ACCOUNT_MISMATCH`) |

## Strict separation of concerns

- **L1** extracts facts, cites source-specific evidence, normalizes currency (USD, COP, MXN) and verifies mechanical consistency; a downstream BLOCKED invoice can have a completely valid, ready L1 envelope.
- **L3** links sources into payable cases. In case 04, L1 independently processes the PDF and registers the message; L3 correlates the message without merging original source provenance. Do not infer invoice identity solely from similar file names.
- **L2** owns contracts, allowlists, account matching, ledger duplicates, budgets and autoapproval thresholds. L1 MUST NOT return a payment decision. Human approval is separate and never overrides a hard blocker.
- **All fixture policy states are isolated**. Scenarios 05 and 07 explicitly preseed a prior authorization and remaining budget respectively, so outcomes do not depend on batch order. Run a separate ordered batch with explicit state transitions if presenting cumulative budget effects.

## Required executable acceptance tests for Codex

1. Ingest each synthetic raw source (to be generated); compare critical extraction fields against per-document ground truth and verify source citations.
2. Assert USD identity, MXN 76,000 / 20 = 3,800.00 USD, COP 2,400,000 / 4,000 = 600.00 USD; verify rate IDs, effective times and HALF_EVEN rules are persisted.
3. Assert absent FX quote, wrong pair, zero/negative rate, nondecimal numeric input or tampered FX snapshot forces non-ready and never invokes payment authorization.
4. Reprocess case 05 under a different filename and document source hash while preserving business identity: L1 can be ready, but L2 MUST block using prior ledger state.
5. Reconcile case 04 with an independent chat source: retain separate source hashes/evidence; L2 blocks unauthorized bonus. Chat-only supplemental data must not overwrite the invoice total.
6. For case 07, assert USD 2,100 against the seeded USD 1,400 budget blocks, regardless of evaluation order. Test concurrent attempts to consume the same budget transactionally in L2.
7. For case 08, assert the extracted payment account matches the **document**, but fails comparison to the trusted vendor directory in L2; redact account IDs in published demo audit logs.
8. Every outcome produces gate-by-gate audit information through L2/L3. `AUTHORIZED_SIMULATED` must never be labeled `PAID` or move funds.
9. A threshold-exceeding, otherwise compliant invoice must request human approval, not execute immediate simulated authorization; reevaluate rules on approval.
10. Assert all 8 outputs under their exact individual seeded policy/ledger context; report failures and unknowns rather than fabricating coverage.

## Demo terminology / assumptions

- Company: fictional Acme Global Inc., US entity with LATAM contractors.
- `maxAutoApproveUsd`: USD 2,500.00 across **all** scenarios. A previous USD 1,500 example is not applicable to this dataset.
- MXN and COP rates are **synthetic demo quotes**, not live FX market rates.
- `AUTHORIZED_SIMULATED` means the system recorded permission to pay in the **simulation**; no real disbursement is part of this challenge.
- 8 scenarios demonstrate business rules; retain the broader 30+ synthetic document-level adversarial evaluation requirement from L1.
