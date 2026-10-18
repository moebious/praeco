# L1 — Evidence and extraction acceptance plan

**This file defines acceptance criteria and records the latest offline corpus run.** Passing this machine-authored suite does not establish independent extraction accuracy.

## Latest offline run

**Observed:** 2026-10-18 UTC via `npm run l1:evaluate` against the 30-document synthetic corpus.

| Measure | Result |
|---|---:|
| Documents / output envelopes | 30 / 33 |
| Expected document statuses matched | 30 / 30 |
| Unsafe ready envelopes | 0 |
| Ready envelopes / expected ready | 20 / 20 |
| USD normalization expectations matched | 33 / 33 |
| Verified citation references | 376 |
| Local pipeline latency p50 / p95 | 164.09 ms / 3,440.08 ms |

The expected statuses and normalization values are machine-authored synthetic expectations reviewed in code. Independent human field annotation is pending, so full critical-field accuracy remains unmeasured. Raster samples are intentionally non-ready with the local parser. These results validate deterministic fixture behavior, not hosted provider quality, production accuracy or L2 decisions. This run overlapped the full check on the same host; its timings are observations under concurrent load, not a performance baseline.

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

## External document integration

`npm run test:l1:integration` exercises the separate external-document adapter against real local L1 processing and persisted readers. Coverage includes repeated delivery, immutable revisions, content-digest snapshots, external metadata retention, tenant isolation, ERP/document disagreement, absent attachments, missing documentary account evidence, revoked/unavailable connections, receipt/source tampering and historical replay without external access. See the [provenance specification](../architecture/external-document-intake.md).

These are synthetic integration boundary tests. They do not validate real ERP/Blinka APIs, OAuth, financial authorization or hosted OCR quality. The canonical contract, 30-document corpus and expected financial decisions remain unchanged.

### Executed validation

Observed 2026-10-18 UTC for the local integration slice:

| Command / check | Result |
| --- | --- |
| `npm ci` | Passed |
| `npm run check` | Both workspaces typecheck/build; 103 core tests + 18 integration tests passed |
| `npm run test:l1:integration` | 18 / 18 passed explicitly |
| `npm run l1:demo` | Ready, accepted verification; COP 8,000,000 normalized to USD 2,000.00 |
| `npm run l1:evaluate` | 30 / 30 status matches; 33 / 33 normalization matches; zero unsafe-ready cases |
| Canonical contract / ADR / corpus changes | None; contract Git hash remains `ee1f94a797cd461b5fcfa394dd7ebe8cd8d18fd9` |
| Isolated L1 workspace install, build, production install and CLI | Passed without the integration workspace or test fixtures |
| Built integration package smoke / package manifest | Mock Bill import and trusted read passed; dry-run package contains no tests or expected outcomes |
| Docker image build/run | Not run: local Docker daemon unavailable |
| Live provider smoke | Not run for this integration change; no hosted provider calls |
