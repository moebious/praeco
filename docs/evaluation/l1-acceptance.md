# L1 — Evidence and extraction acceptance plan

**This is a test specification, not executed test results.**

## Synthetic evaluation corpus: 30 documents minimum

| Sample category | Count |
| --- | ---: |
| Digital SaaS USD invoices | 4 |
| Colombian COP cuentas de cobro | 5 |
| Scans and photographed invoices | 4 |
| Email/chat native content | 4 |
| Multi-page mixed-document packets | 3 |
| Contradictory totals and amounts | 4 |
| Missing/corrupted fields and changed accounts | 3 |
| Malicious prompt-injection text in documents | 3 |
| **Total** | **30** |

## Acceptance checks

1. A ready envelope must include a trusted, digest-bound ACCEPTED verification report with critical evidence.
2. Altered source hash, invalid citation IDs, out-of-bounds PDF region, bad UTF-8 span and expired/untrusted evidence cannot be accepted.
3. Unknown, missing or contradictory critical fields must not produce a ready invoice.
4. Money vectors: USD 2,500 → USD 2,500; COP 8,000,000 / 4,000 → USD 2,000; MXN 76,000 / 20 → USD 3,800; COP 2,400,000 / 4,000 → USD 600.
5. HALF_EVEN tie cases; source-rate currency mismatch; absent, zero or negative rates; unsupported currencies; overly large decimal values must fail closed or calculate exactly.
6. Source-backed account details may differ from the trusted vendor directory; matching them is strictly an L2 obligation.
7. A mixed packet must retain source/segment provenance and never cross-document citations.
8. OCR uncertainty on critical digits requires review; a model's self-reported confidence never authorizes.
9. Provider tests remain separated from deterministic verifier tests.
10. L2 may never autoauthorize non-ready L1 envelopes.

Release condition: zero unsafe-ready cases and zero accepted critical fields without verified evidence in the labeled corpus. Preserve real failures, logs and traces.
