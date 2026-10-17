# Financial Evidence Intelligence (L1)

Source-backed extraction and deterministic normalization for Praeco.

**Current status:** local source registry, Zod schemas, exact-decimal normalization, evidence verifier, immutable envelope reader and CLI are implemented. LiteParse runs locally. LlamaParse/LlamaExtract adapters have mocked protocol tests; live provider quality validation remains pending. Financial authorization remains exclusively in L2.

- [Contracts](src/contracts.ts)
- [Architecture](../../docs/architecture/evidence-intelligence.md)
- [Decision record](../../docs/adr/001-evidence-boundaries.md)
- [Evaluation specification](../../docs/evaluation/l1-acceptance.md)
- [Provisioning and L2/L3 integration](../../docs/architecture/l1-runtime.md)

From the repository root: `npm ci`, `npm run check`, then `npm run l1:demo`. No API key is required for the explicitly labelled offline demo. Hosted processing is opt-in; see the integration guide for environment configuration and the limits of the current verifier.

The `L1_CONTRACT_VERSION` constant is a schema wire discriminator and is intentionally retained even though the repository's initial published design does not use historical release labels.
