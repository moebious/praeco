# Praeco

**Autonomous, governed financial operations.**

**Repository version:** 1.0.0. The L1 `3.0.0` value identifies its internal wire contract, not the Praeco release.

Praeco is the project submitted by team **Praeco** to the **30X Hackathon — Blinka Challenge**. It explores a domain-specific autonomous Accounts Payable team: intake invoices, extract source-backed financial facts, evaluate company policies deterministically, and produce auditable simulated decisions.

> **Hackathon safety boundary:** No real money moves. `AUTHORIZED_SIMULATED` does **not** mean a bill has been paid. Only synthetic company, vendor, contract, and invoice data may be committed.

## Architecture

| Component | Ownership | Status |
| --- | --- | --- |
| **L1 · Financial Evidence Intelligence** | Immutable sources, parsing, extraction, evidence verification, exact-decimal normalization | Local runtime and LlamaIndex adapters implemented; live cloud/OCR validation pending |
| **Document classification · DocJev + Jev 1.14** | Packet segmentation proposals through a typed fail-closed adapter | Live benchmark on synthetic packets: 5/5 exact, boundaries 6 TP / 0 FP / 0 FN; verified segments drive L1 extraction and the L3 Vera flow; classification never determines evidence readiness or authorization |
| **L2 · Financial Decision Kernel** | Deterministic authorization policies, six gates, ledger, budget, idempotency | Kernel, approvals, trusted L1 reader adapter and operations dashboard implemented; the ADR-003 SQL transaction boundary is proven in CI against PostgreSQL while the in-memory synthetic ledger remains the demo default |
| **L3 · Praeco Agent Harness** | Collaborative AP agents, governed capabilities, execution recovery, human review, cross-source payable cases | Specialist roles, durable workflow runner, L1/L2 orchestration and the verified-segment packet flow implemented; P0 runs on the in-process deterministic demo runtime of ADR-007 (Trigger.dev/Neon swap-in pending) |
| **DEMO-001 · Synthetic AP Environment** | Test fixtures, reference data, seed/reset/replay and test-only oracle | Handoff prepared; integration pending |
| **DEMO-002 · AgentMail intake** | Email ingestion adapter | Proposed, not required for core golden-set tests |

### Golden set

Eight synthetic payable scenarios cover two automatic simulated authorizations, one human escalation and five hard blocks. The *expected* outcomes are test-only and must never be available to runtime agents or financial policy evaluation.

### Repository layout

```text
apps/              # Finance operations dashboard (serves the L2 inspector UI)
packages/          # L1 evidence intelligence, external intake, L2 decision kernel, SQL store slice, document-classification adapter, agent harness
integrations/      # AgentMail, Daytona and other adapters (as needed)
demo/              # Synthetic AP environment, replay, evaluation
docs/              # Architecture decisions and specifications
scripts/           # Development and repository checks
```

Directories are added as their implementations land. The accepted L1 wire contract is preserved.

## Run L1

Use Node 22.12+ and npm. Run `npm ci`, `npm run check`, and `npm run l1:demo` for a synthetic offline invoice. See the [L1 provisioning and integration guide](docs/architecture/l1-runtime.md) for hosted LlamaParse/LlamaExtract configuration and L2/L3 integration. The offline extractor is explicitly labelled; passing local tests does not establish hosted OCR accuracy or financial authorization safety.

The separate [external-document intake package](packages/external-document-intake/README.md) preserves mock ERP attachment provenance and revisions without changing L1's wire contract. Run `npm run test:l1:integration` to exercise it.

## Run L2

`npm run test:l2` exercises the decision kernel, transactional semantics, human-approval lifecycle and a trusted L1 `reader.loadReady` integration against a real synthetic PDF. `npm run l2:demo` evaluates the eight canonical Blinka scenarios through the six gates and demonstrates one simulated FinanceAdmin approval; `npm run l2:web` serves the operations dashboard at `http://localhost:3000`. The L2 store is an in-process synthetic ledger for the hackathon, not the SQL-backed authoritative store required by ADR-003, and no real payments are ever made: `AUTHORIZED_SIMULATED` never means `PAID`.

## Document understanding (DocJev + Jev 1.14)

Real mail arrives as mixed packets: several invoices, continuation pages and supporting contracts inside one document. The [document-classification adapter](packages/document-classification-adapter/README.md) wires DocJev/Jev into the pipeline as **proposals only**:

- Jev proposes where each distinct document starts and ends; a typed, fail-closed adapter validates every packet — complete page coverage, no overlaps, recognized categories, source-hash match — and never surfaces provider probabilities.
- Verified segments drive L1 extraction through the frozen `DocumentSegment` seam (`classifiedBy: 'DOCJEV'`), preserving original page numbers in every citation.
- Only invoice segments become extraction candidates; contract and supplemental pages stay context; review-flagged segments can never become `READY`.
- Evidence: the [live benchmark](docs/evaluation/docjev-splitting-benchmark.md) scored 5/5 exact synthetic packets with boundaries 6 TP / 0 FP / 0 FN. Field-level extraction accuracy is a separate, still-unevaluated measurement.

Jev never determines evidence readiness or financial authorization — verified evidence and the six deterministic gates decide. The offline default runs on fixture classifications; live Jev runs are manual, gated behind the `evaluation` environment, and billed to OpenRouter.

## Run L3

`npm run test:l3` exercises the agent harness end to end: Vera ingestion and source linking, Kael read-only policy preview, Nova's commit flow, human-approval waits, and the verified-segment packet flow in which one mixed packet splits into two invoices that both authorize through the real six-gate kernel. Everything is offline and deterministic (ADR-007): no live model calls in tests.

## Contribution workflow

Use **[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)** from the first commit:

- `feat(l1): implement source digest verification`
- `fix(l2): prevent duplicate budget reservations`
- `test(demo): cover unknown beneficiary case`
- `docs(architecture): document payable-case ownership`
- `chore(repo): initialize Praeco repository`

See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md) before generating implementation code.

## License and scope

The repository is public for the hackathon. No production authorization guarantee is claimed: hosted OCR accuracy, field-level extraction accuracy and adversarial end-to-end validation remain unproved.
