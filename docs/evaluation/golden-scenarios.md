# Praeco — Eight canonical synthetic payable scenarios

**Status:** acceptance specification, not passing end-to-end tests. All amounts, vendors, contracts and FX rates are fictional.

| Case | Source claim | Authoritative synthetic initial state | Expected L2 outcome |
| --- | --- | --- | --- |
| 01 Bogotá contractor | USD 2,200 invoice | Allowlisted, account matches, contract USD 2,200, budget USD 5,000 | `AUTHORIZED_SIMULATED` |
| 02 SaaS invoice | USD 480 recurring | Prior USD 470, <5% increase, allowed vendor/contract/account | `AUTHORIZED_SIMULATED` |
| 03 Mexico agency | MXN 76,000 = USD 3,800 (20 MXN/USD) | Matching contract max USD 4,000, budget USD 4,500, auto threshold USD 2,500 | `PENDING_HUMAN_APPROVAL` |
| 04 Argentina contractor | USD 1,950 PDF plus separate USD 450 bonus chat | Contract only USD 1,500; no authorized amendment | `BLOCKED` — contract mismatch |
| 05 Forwarded duplicate | Same invoice number/vendor/period as case 01, different transport | Prior authorization preseeded in ledger | `BLOCKED` — duplicate |
| 06 New beneficiary | COP 2,400,000 = USD 600 (4,000 COP/USD) | Beneficiary not allowlisted | `BLOCKED` — allowlist |
| 07 Insufficient budget | USD 2,100 | Independently seeded available period budget USD 1,400 | `BLOCKED` — insufficient budget |
| 08 Changed account | USD 1,200 | Known vendor; invoice payment account differs from trusted directory | `BLOCKED` — account mismatch |

## Required execution semantics

- Fixed demo `maxAutoApproveUsd`: **USD 2,500**.
- Each isolated scenario has its own authoritative vendor, contract, policy and ledger snapshot. Do not let previous scenario execution change expected results.
- Sequential budget consumption is a separate integration mode, with recorded transactions and deterministic expected state transitions.
- L1 extracts/cites source facts and normalizes monetary values; it does not know ground-truth payment outcomes.
- L3 correlates PDF and chat independently for case 04. No agent may silently upgrade chat claims into authorized contract amendments.
- L2 evaluates six financial gates (evidence, duplicates, beneficiary/account, contract, budget, threshold), with hard blockers overriding human escalation.
- A human approval request must not bypass hard blocks; re-evaluate all authoritative state at approval time.
- Every outcome includes legible gate-by-gate evidence and rationale. Simulated authorization is not payment execution.
- The independent adversarial L1 corpus has at least 30 documents: eight scenarios alone do not prove extraction reliability.
- Golden outcomes must live in a **test-only fixture** never importable by the runtime.
