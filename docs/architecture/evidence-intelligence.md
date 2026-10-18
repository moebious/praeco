# L1 — Financial Evidence Intelligence

**Status:** Accepted initial architecture and interface baseline. **Implementation not yet verified.**

The current `contracts.ts`, runtime guide and executable acceptance fixtures define Praeco L1. Provider and human-validation limits are recorded in the [evaluation documentation](../evaluation/l1-acceptance.md).

## Mission

Transform untrusted PDF, image, email and chat sources into reproducible, source-attributed financial facts. L1 never authorizes payments, matches authoritative agreements, enforces budgets, validates vendor allowlists or grants agent permissions.

## Five-stage architecture

1. **Multichannel intake and immutable source registry:** store exact bytes/message snapshots with tenant-scoped SHA-256 and durable restricted artifact references; distinguish technical replay deduplication from business invoice duplication.
2. **Adaptive parsing:** direct native email/chat text, LiteParse for digital PDFs, LlamaParse candidate for scans and complex page layouts; route by properties, not extensions.
3. **Optional document classification/splitting:** DocJev candidate for heterogeneous packets; preserve source page mapping and explicitly handle uncertain boundaries.
4. **Structured extraction:** LlamaExtract candidate; map provider-specific output to `InvoicePayload`, `ObservedField<T>` states and source-specific `EvidenceReference` citations. No provider types escape adapters.
5. **Independent verification and financial normalization:** trusted verifier checks source/hash binding, citation validity, consistency, uncertainty and exact-decimal math; produce versioned `InvoiceEnvelope`.

## Stack candidates

TypeScript strict, Node.js, Hono, Zod, decimal.js and Vitest. LiteParse, LlamaParse, optional DocJev and LlamaExtract remain adapters requiring integration validation. Object storage choice remains open. No vector database or generic RAG is required in L1.

## Normative safety invariants

- All source documents, mail and model outputs are **untrusted**; document instructions never override system policies.
- `OBSERVED` does not mean verified; an `ACCEPTED` report covers structure, provenance and consistency, not guaranteed OCR fidelity.
- Every material observed field must link to valid evidence from the exact immutable original source or retained parse artifact.
- Unknown/contradictory critical financial facts, unsupported currencies, wrong/missing FX rates and verification failures are never ready for autoauthorization.
- Use base-10 decimal strings and exact arithmetic, not JS floating-point arithmetic.
- FX: `USD = sourceAmount / quotePerBase`, where `1 USD = quotePerBase` source units. Demo rates are fictional: 4,000 COP/USD and 20 MXN/USD. USD is identity. HALF_EVEN rounds to two USD decimals; persist rate snapshot and calculation trace.
- Store original source, parser/extractor artifacts, verifier report, hashes, versions and audit references. Redact payment account identifiers in public output.
- `READY_FOR_POLICY_EVALUATION` requires a trusted digest-bound `ACCEPTED` verification result and no critical issue. Only L2 can authorize simulated payments.
- Failed processing remains auditable. L3 can retry safely or route to human review; provider failures are not business decisions.
- Multiple documents correlating to one payable remain distinct L1 sources. **L3** creates the cross-source `PayableCase`; **L2** owns policy and business validity.

## Canonical contract

[`packages/evidence-intelligence/src/contracts.ts`](../../packages/evidence-intelligence/src/contracts.ts) defines DocumentSource, DocumentSegment, EvidenceReference, ObservedField, InvoicePayload, FxRateSnapshot, FinancialNormalization, VerificationReport, InvoiceEnvelope and DocumentIntelligencePort. The technical `schemaVersion` discriminator is retained for wire compatibility; it is not a repository release number.

## Validation required before claims of readiness

- Runtime Zod schemas and exact-decimal normalizer.
- Trusted verifier implementation and immutable artifact storage.
- Deterministic unit and property tests.
- At least **30 distinct synthetic adversarial document fixtures**, with source citations and annotated human ground truth.
- Adapter tests for real parsers/extractors.
- End-to-end scenarios against L2/L3, which are not implemented yet.
