# BLINKA — Layer 1 v3.0 handoff

**State:** Architecture and interface baseline locked; implementation, providers and empirical verification pending. Supersedes v2.0.

## Contents

- [L1 v3 architecture](docs/L1-v3.0-ARCHITECTURE.md)
- [ADR-003 v3 contract amendment](docs/ADR-003-L1-v3.md)
- [Canonical TypeScript contract](contracts/l1.contracts.ts)
- [L1 evaluation specification](tests/L1-EVALUATION-SUITE.md)
- [Cross-layer Demo Day scenario spec](tests/DEMO-DAY-8-SCENARIOS.md)
- [Eight scenario manifest (synthetic expected values, not source PDFs)](fixtures/demo-day-8-scenarios.json)
- [Codex instructions](AGENTS.md)

## Compatibility

This is a **major contract version** (`3.0.0`), with currency-agnostic configured FX quotes replacing v2 COP-only types. v2 results require explicit migration/reprocessing. Multi-document payable correlation remains L3's responsibility; vendor, agreement, budget, threshold and duplicate business decisions remain L2's responsibility.

The eight scenarios are acceptance designs. Their expected L1 facts and L2 outcomes are not demonstrated performance. Provider integration, sample PDF generation, execution, automated test runner, authorization kernel, and UI are separate remaining workstreams.
