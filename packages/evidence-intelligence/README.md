# Financial Evidence Intelligence (L1)

Source-backed extraction and deterministic normalization for Praeco.

Praeco is repository v1. The `L1_CONTRACT_VERSION` remains `3.0.0` as the internal wire-format version.

**Current status:** local source registry, Zod schemas, exact-decimal normalization, evidence verifier, immutable envelope reader and CLI are implemented. LiteParse runs locally with bundled Tesseract OCR enabled for PDFs; OCR-assisted envelopes remain review-only. A historical synthetic LlamaCloud smoke grounded both digital PDFs; the PNG scan stayed in review. Citation recovery now accepts only exact field-schema placeholders with a unique labelled-value match on the cited page and retains an audit trail. This narrowed policy has mocked regression coverage; hosted validation of it remains pending. See [live provider findings](../../docs/evaluation/llama-cloud-live-smoke.md). Financial authorization remains exclusively in L2.

- [Contracts](src/contracts.ts)
- [Architecture](../../docs/architecture/evidence-intelligence.md)
- [Decision record](../../docs/adr/001-evidence-boundaries.md)
- [Evaluation specification](../../docs/evaluation/l1-acceptance.md)
- [Provisioning and L2/L3 integration](../../docs/architecture/l1-runtime.md)

From the repository root: `npm ci`, `npm run check`, then `npm run l1:demo`. No API key is required for the explicitly labelled offline demo. Hosted processing is opt-in; see the integration guide for environment configuration and the limits of the current verifier.
