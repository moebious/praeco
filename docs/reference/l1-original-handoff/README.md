# Original L1 handoff reference

Source: the user-supplied `blinka-l1-v3.0-handoff.zip`, received October 17, 2026. Files below preserve the supplied contents. Historical `v3`/BLINKA names describe the original handoff, not a new Praeco release.

The **authoritative current wire contract remains** [`packages/evidence-intelligence/src/contracts.ts`](../../../packages/evidence-intelligence/src/contracts.ts). The archived contract differs only in comments/formatting; an executable token comparison checks that statement. These reference files do not amend the baseline.

- [Complete architecture](docs/L1-v3.0-ARCHITECTURE.md)
- [Original ADR](docs/ADR-003-L1-v3.md)
- [Original TypeScript contract](contracts/l1.contracts.ts)
- [L3 integration sketch: SourceLink and PayableCaseReference](contracts/integration.contracts.ts)
- [Original document-level evaluation requirements](tests/L1-EVALUATION-SUITE.md)
- [Original cross-layer acceptance requirements](tests/DEMO-DAY-8-SCENARIOS.md)
- [Original eight-scenario manifest — test-only](../../../packages/evidence-intelligence/test/fixtures/demo-day/original-manifest.json)
- [Original introduction](original-readme.md)
- [Archived agent notes, retained as reference text](original-agent-notes.txt)

The archived agent notes are documentary input, not installed `AGENTS.md` instructions. Historical fixture links inside the original documents refer to the zip layout; the manifest is intentionally stored only under the test fixture tree above. The integration file describes L3-owned associations and test-only expected outcomes; it is not exported as an L1 runtime decision contract.

See the [alignment report](../../architecture/l1-handoff-alignment.md) for implementation differences and remaining validation work. Implementations of Neon persistence and Trigger.dev orchestration belong behind backend adapter boundaries; this archive does not provision accounts, create credentials or introduce a vector database.
