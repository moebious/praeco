# L1 handoff alignment

Reviewed against the user-supplied `blinka-l1-v3.0-handoff.zip` on October 17, 2026. The source archive is retained as [historical reference](../reference/l1-original-handoff/README.md); the existing Praeco `contracts.ts` remains authoritative.

## Findings before changes

The original and current canonical TypeScript declarations match after removing comments/trivia. No domain type, enum/discriminant or function signature differs. A regression test compares the declarations; CI separately preserves the current file's original Git blob hash. **No wire/schema migration or redesign is needed.**

The original `integration.contracts.ts` explicitly calls itself an L3 integration sketch, not an L1 implementation contract. `SourceLink` and `PayableCaseReference` are restored as reference for L3; `ExpectedDemoOutcome` stays test/documentation-only. They are not silently added as L1 decision types or exported into a runtime financial authority contract.

The earlier public `main` contained summarized architecture and contracts. PR #1 introduced a runtime and synthetic corpus, but that did not prove fidelity to the unpublished handoff or complete the original validation requirements. These are different snapshots, not contradictory implementation claims.

## Behavior and evidence reconciliation

| Handoff detail | Earlier PR behavior / gap | Reconciliation |
| --- | --- | --- |
| Supplemental chat may yield no invoice | Empty extraction treated as failure; non-invoice text became a missing invoice | Explicitly recognized native supplemental context is retained, classified and audited with zero envelopes. Unknown/invoice-like input still produces a non-ready outcome. |
| Retained-snapshot deterministic replay | Processing always invoked parsing/extraction again; reader only recomputed normalization | `replay(tenantId, envelopeId)` uses retained parsed text, extraction, evidence and original FX/rule version, creates a fresh report/envelope, and makes no provider call. Changed artifacts or incompatible rules invalidate replay. |
| Native message-span provenance | Native sources normally used retained parse-artifact spans | Exact single-message snapshots with `originMessageId` use `MESSAGE_SPAN`; multipage/other representations retain source-bound `TEXT_SPAN`. UTF-8 boundary and accented-text regressions cover both. |
| Local dates and line items | Dates required ISO strings; extraction adapters did not expose line items | Explicit Spanish date labels support deterministic DD/MM/YYYY → ISO with original quotes preserved. Labelled and LlamaExtract nested line items have citations and quantity/price/subtotal checks. Ambiguous formats remain non-ready. |
| Public account audit references | Operational summaries omitted accounts entirely | Default summary still omits them; trusted backends can request redacted/keyed-HMAC account references. This is audit correlation, never account authorization. |
| Original eight-scenario manifest | Summary table and unrelated 30-source local corpus | Original JSON is restored byte-for-byte under test fixtures. Ten independent raw input sources now exercise eight L1 scenarios, including two separate supplemental messages. L2 seeded snapshots/expected decisions remain outside runtime. |
| Canonical FX fixtures | Development defaults used different IDs/timestamps | Original-scenario tests supply the exact original configured rate snapshots and assert IDs, timestamps, amount/currency and USD results. No rate is inferred from the invoice/model. |
| Corpus quality and human labels | 30 synthetic documents existed, with machine-authored expectations | Corpus remains explicitly machine-labelled pending human sign-off. Four digital USD PDFs now include actual line items. Raster offline failures are not counted as OCR accuracy. |
| Live digital/COP/scan smoke and metrics | Mocked provider tests and unit results only | Separate opt-in billable smoke command and offline evaluator added. They report unknown cost/accuracy as null; live validation and independent human truth remain pending. |
| Provider-independent persistence | Pipeline composed the file repository directly | Backend `ImmutablePersistencePort` now accepts another immutable persistence implementation without changing domain contracts; a non-filesystem adapter test exercises the same pipeline. |

## Technology boundaries

**Neon/PostgreSQL:** storage implementation choice behind the immutable persistence port. A production adapter must guarantee atomic insert-if-absent, reject differing bytes for an existing key, retain tenant-scoped records and artifact hashes, and keep arbitrary SQL/provider objects outside domain payloads. The current patch does not create a Neon project, run migrations or claim a verified PostgreSQL adapter. Object storage may back blobs while PostgreSQL stores manifests. No pgvector/generic RAG dependency is introduced.

**Trigger.dev:** external scheduling/retry/recovery choice. A Trigger task can invoke registration/processing and persist returned envelope IDs; use retained-snapshot replay for deterministic verification rather than rerunning LLM extraction. New extraction attempts remain explicit, separately audited and potentially billable. No Trigger SDK type is added to L1 domain contracts; distributed stage orchestration/resume is still a separate adapter workstream.

**LlamaIndex:** LiteParse, LlamaParse and LlamaExtract remain the selected parsing/extraction path. Local execution and mocked wire tests are distinct from provider quality validation. DocJev remains optional. Daytona/exe.dev and optional Sentry/Langfuse instrumentation do not gain financial authority.

## Open validation and interpretation points

- The existing default readiness profile is conservative: invoice number, due date and tax ID are required in addition to beneficiary/account/currency/amount. The handoff permits field-specific versioned requirements and explicitly forbids fabricated invoice numbers. The implementation preserves `MISSING` and routes to review; it does not claim those extra fields are universally mandated by the handoff. Broader profiles should be agreed with L2 before relaxing readiness.
- The original scenario 04's primary PDF amount is USD 1,950. The separate message discusses a proposed USD 450 bonus relative to a USD 1,500 base; it does not add another USD 450 to the invoice or prove an approved amendment. L3 verifies association; L2 evaluates the original contract independently.
- Original `fixtureStatus: DESIGN_ONLY_NOT_RENDERED` values are preserved in the historical manifest. The executable input inventory records the new renderings separately rather than rewriting the supplied oracle's history.
- No exact historical byte-identical LLM regeneration is promised. Replay compares retained claims, citations, checks/status and normalization; IDs/timestamps of the newly issued report may differ.
- Live LlamaParse/LlamaExtract smoke, human per-field annotation, population accuracy claims, authenticated service admission, production retention controls, Neon connectivity, Trigger recovery and cross-layer financial decisions remain unverified. Compilation and local test passes do not close these release requirements.

## Commands

`npm run check` runs deterministic/unit, provider-wire, corpus and original-scenario L1 tests. `npm run l1:evaluate` writes observed offline metrics to the package's `.cache/l1-evaluation/report.json`. `npm run l1:smoke` is separate and refuses to run unless explicitly enabled with `L1_RUN_LIVE_SMOKE=1` and configured LlamaCloud credentials; it can consume provider credits. See the [runtime guide](l1-runtime.md) for provisioning and integration.
