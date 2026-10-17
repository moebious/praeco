# L1 Evaluation Contract — v3.0

## Required fixtures (minimum 30 synthetic samples)

| Group | Quantity | Ground truth / assertions |
|---|---:|---|
| Native PDF SaaS USD | 4 | invoice identity, beneficiary, total, due date, line items and citations |
| Colombian COP cuentas de cobro | 5 | local date formats, tax ID vs account, COP/USD computation and missing invoice numbers |
| Scanned/photographed invoices | 4 | source region, OCR uncertainty, digits and totals |
| Email / chat text | 4 | no unnecessary OCR, correct message-span provenance |
| Mixed packets / multi-page docs | 3 | document boundaries, segment page mapping, no evidence mixing |
| Contradictory monetary information | 4 | conflicting totals/paid balances safely require review |
| Missing/corrupted fields and altered accounts | 3 | missing evidence never accepted as verified |
| Malicious document instruction / injection | 3 | no tool/policy/approval override; source treated as data |
| **Total** | **30** | Human-authored expected statuses and per-field source evidence |

## Automated checks

1. `READY` implies digest-bound `ACCEPTED` report and critical fields present with evidence.
2. `REVIEW_REQUIRED`, `REJECTED`, and `PROCESSING_FAILED` never authorize anything; L2 owns that invariant too.
3. Original-source hash corruption invalidates verification.
4. Unknown evidence ID, wrong page, out-of-bounds box and invalid UTF-8 offsets fail.
5. Invoice number, tax ID and account identifiers are not conflated.
6. `2500.00 USD → 2500.00 USD`, `8000000 COP / 4000 COP_per_USD → 2000.00 USD`, `76000 MXN / 20 MXN_per_USD → 3800.00 USD`, `2400000 COP / 4000 COP_per_USD → 600.00 USD`.
7. Half-even tie cases, large decimals, zero/negative FX rate and unsupported currency are handled deterministically.
8. Missing/zero/negative rate, rate/source-currency mismatch, unsupported ISO code, and half-even boundary cases must fail closed.
9. A changed parser result invalidates its extraction/report digest; replay uses retained snapshots.
10. Uncertain OCR critical digit produces REVIEW_REQUIRED, not automatic acceptance.
11. Mixed packet never crosses original segment boundary for a field citation.

These are **acceptance criteria to implement and validate**, not passing test results. Provider integration tests must be separate from pure verifier tests.

See DEMO-DAY-8-SCENARIOS.md for additional cross-layer acceptance requirements.
