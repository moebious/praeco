# @praeco/document-classification-adapter

Typed, fail-closed adapter over DocJev/Jev document packet splitting —
the PR B slice of the Jev integration plan. It proposes document
segmentation only: **it never determines evidence readiness or financial
authorization**, and it is not wired into the L1/L2/L3 runtime (that is PR C).

## What it does

- **Bounded process bridge** (`invokeDocJevSplit`): spawns the pinned DocJev
  CLI (`python -m jev_docs.cli split <pdf> --rules <rules> --ocr liteparse
  --engine jev --model jev-1.14`) with a kill-on timeout (default 150s), an
  output-size cap (default 5 MiB), and sanitized errors. Credentials travel
  only via the child environment and never appear in messages or logs.
- **Typed validation** (`validateSplitResult` / `classifyDocumentPacket`):
  parses the split result against the pinned DocJev wire contract and enforces,
  fail-closed:
  - every original page belongs to exactly one contiguous segment (no gaps,
    no overlaps, no duplicates, no out-of-range pages),
  - only recognized categories (`invoice`, `contract`,
    `supplemental_context`, `other`) pass,
  - source provenance (`source_sha256`, `canonical_sha256`) must match the
    caller-registered source when provided,
  - any `needs_review` segment, `other` category, or provider warning marks
    the whole packet **review-required** (review-only downstream).
- **Provider probabilities are deliberately not surfaced.** They are not
  calibrated evidence confidence and must never influence L1 READY or L2
  decisions; the typed output cannot carry them.

## Errors

`ClassificationError` with codes: `INVALID_JSON`, `SCHEMA_INVALID`,
`PAGE_COUNT_MISMATCH`, `COVERAGE_INVALID`, `UNKNOWN_CATEGORY`,
`SOURCE_HASH_MISMATCH`, `DOCJEV_TIMEOUT`, `DOCJEV_EXECUTION_FAILED`,
`OUTPUT_TOO_LARGE`. Messages carry operational metadata only — never
document text or credentials.

## Usage sketch

```ts
const packet = await classifyDocumentPacket({
  documentPath: 'packet.pdf',
  rulesPath: 'docs/evaluation/docjev-rules.yaml',
  pythonCommand: process.env.DOCJEV_PYTHON ?? 'python3',
  model: 'jev-1.14',
  expectedPageCount: 4,
  expectedSourceSha256: registeredSourceHash,
  extraEnv: { TYPESAFE_API_KEY: providerKey }, // passed through, never logged
});

if (packet.reviewRequired) {
  // route to human review; no segment is finance-ready
}
```

## L1 integration (segmented extraction)

`SegmentedLabelledTextExtractor` implements L1's `ExtractionPort` so the frozen
L1 v3.0.0 wire contract stays untouched:

- Verified packet segments (from `validateSplitResult` or the live
  `DocJevClassificationSource`) group parsed pages into candidate invoices via
  `DocumentSegment` with `classifiedBy: 'DOCJEV'`.
- Only invoice-category segments become extraction candidates; contracts,
  supplemental context and unknown pages stay context with no invoice draft.
- Continuation pages merge into one invoice, with every citation keeping its
  ORIGINAL page number and artifact — nothing is renumbered or re-quoted.
- Fail-closed rules: contradictory restatements become CONFLICTING fields;
  line items spanning multiple pages (page-local numbering cannot distinguish
  continuation items from restatements) route to review; review-flagged
  segments carry `DOCJEV_REVIEW_REQUIRED` so the verifier can never mark them
  READY; missing classifications keep the conservative base behavior.
- The L1 runtime records honest provenance: DOCJEV-classified segments report
  `provenance.classification.provider = 'DOCJEV'` (the contract's own enum).

The workflow runner gained an explicit `envelopeId` binding so a payable case
can name which verified invoice envelope of a multi-invoice packet it owns;
single-invoice sources keep the first-envelope default.

## Evidence and status

The wire contract mirrors the pinned DocJev revision
(`c7abe276a970605feb9cb8b27513365b6c10726e`) verified against upstream
source, and the underlying splitting capability is evidenced by the live
benchmark (5/5 exact packets, boundaries 6 TP / 0 FP / 0 FN — see
`docs/evaluation/docjev-splitting-benchmark.md`). Tests are fully offline:
bridge behavior is exercised through scripted stand-in interpreters, and no
test performs provider inference.
