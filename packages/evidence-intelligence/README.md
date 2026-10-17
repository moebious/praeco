# Financial Evidence Intelligence (L1)

Source-backed extraction and deterministic normalization for Praeco.

**Current status:** canonical TypeScript interfaces and architecture only. No OCR services, APIs, verifier, runtime schemas, storage, or financial authorization are implemented in this package.

- [Contracts](src/contracts.ts)
- [Architecture](../../docs/architecture/evidence-intelligence.md)
- [Decision record](../../docs/adr/001-evidence-boundaries.md)
- [Evaluation specification](../../docs/evaluation/l1-acceptance.md)

The `L1_CONTRACT_VERSION` constant is a schema wire discriminator and is intentionally retained even though the repository's initial published design does not use historical release labels.
