# Evidence intelligence · L1

Source-backed invoice extraction and exact-decimal normalization for Praeco. L1 retains original documents, checks citations against source artifacts, and exposes verified evidence to L2. Financial authorization belongs exclusively to L2.

## Capabilities

- Immutable, tenant-scoped sources, envelopes, processing receipts, and replay artifacts.
- Local PDF parsing with LiteParse and Tesseract; optional hosted LlamaParse/LlamaExtract adapters.
- Evidence grounding, critical-field checks, and deterministic currency normalization.
- Explicit separation of invoice evidence and supplemental context.
- Trusted `reader.loadReady()` access for downstream financial evaluation.

The offline extractor targets synthetic labelled documents. OCR-assisted output remains review-only, and hosted citation validity is not a measurement of extraction accuracy. See the [acceptance specification](../../docs/evaluation/l1-acceptance.md).

## Run

From the repository root:

```bash
npm ci
npm run check
npm run l1:demo
```

No API key is required for the offline demo. To process a local synthetic file after building:

```bash
npm run l1:process -- --file /path/to/invoice.pdf --channel PDF --mime application/pdf --tenant synthetic-company
```

Hosted processing is opt-in and can incur provider charges. Use the [runtime guide](../../docs/architecture/l1-runtime.md) for configuration, supported formats, trusted-reader semantics, and replay behavior.

## API and design

The internal wire contract is version **3.0.0**, independently of the repository release version.

- [Wire contracts](src/contracts.ts)
- [Runtime API](src/service.ts)
- [Evidence architecture](../../docs/architecture/evidence-intelligence.md)
- [Evidence boundaries](../../docs/adr/001-evidence-boundaries.md)
- [Hosted evaluation evidence](../../docs/evaluation/llama-cloud-live-smoke.md)
