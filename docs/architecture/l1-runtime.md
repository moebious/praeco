# L1 runtime and integration handoff

The canonical `contracts.ts` file and `L1_CONTRACT_VERSION` are unchanged. This document describes implementation choices within that interface. L1 produces financial evidence; financial decisions remain exclusively in L2, and cross-source case correlation remains in L3.

## Provision locally

Use Node 22.12+ (CI uses Node 22) and npm:

```sh
npm ci
npm run check
npm run l1:demo
```

The offline demo processes the wholly synthetic labelled invoice in `packages/evidence-intelligence/examples/invoice.txt`; it does not call a hosted provider. `COP 8000000 / 4000` produces `USD 2000.00`. The console displays a redacted operational summary, never raw account identifiers or source quotations. The full envelope and source artifacts remain restricted in `.cache/praeco-l1`.

After building, process another snapshot:

```sh
npm run l1:process -- --file /path/to/synthetic.pdf --channel PDF --mime application/pdf --tenant synthetic-company
```

Plain email/chat means an exact UTF-8 body snapshot with `text/plain`. MIME mailbox parsing, attachments and AgentMail webhooks belong in separate inbound adapters. Filenames never determine parser routing: declared channel/MIME and actual PDF/PNG/JPEG signatures are checked.

The optional `Dockerfile.l1` builds a non-root one-shot demo runner. Persist `/app/.cache/praeco-l1` in a private volume. The runtime image copies built modules and one synthetic input example; it excludes tests and expected outcomes. It is a demo container, not an authenticated web service.

## LlamaIndex adapters

- **LiteParse 2.15.1:** local digital PDF extraction, per-page text, complexity signals, retained output and original-page mapping. OCR is disabled on the cheap path. A worker pool provides a 30-second parse deadline; partial or >50-page results fail closed.
- **LlamaParse API v2:** optional hosted path for scans/images and complex/insufficient native PDF text. Results remain `OCR_REQUIRES_REVIEW`; source citation validity does not establish OCR fidelity. Concrete corpus validation and an independent assurance policy are required before relaxing that boundary.
- **LlamaExtract API v2:** default extractor when `llamaCloud` configuration is supplied. Uploads the original source; requests schema-constrained fields, citations and confidence metadata; maps unique source-text matches back to retained original-page artifacts. Confidence never grants readiness. Missing citations, ambiguous matches, unresolved fields and uncertain packet boundaries require review.
- **Offline labelled extractor:** explicitly named `SYNTHETIC_LABELLED_TEXT`, for deterministic development of labelled invoices. It is not an LLM, OCR engine or general-purpose extraction claim. No expected outcomes are consulted. The same verifier applies to both extractors.
- **DocJev:** optional candidate remains unimplemented. Only explicit, one-invoice-per-page packets have automatic local splitting. Other boundaries require review rather than guessing.

Hosted calls are opt-in. Copy `.env.example` to an ignored `.env`, set `LLAMA_CLOUD_API_KEY` locally and optionally `LLAMA_CLOUD_PROJECT_ID`. Never paste keys into a prompt, public issue or commit. The library accepts credentials explicitly; it does not implicitly read other applications' environment files.

```sh
node --env-file=.env packages/evidence-intelligence/dist/cli.js --cloud
```

This command uploads the synthetic example and can consume provider credits. For scans, also pass `--file`, `--channel IMAGE` and the matching `--mime image/png` or `image/jpeg`. Supported cloud origins are the US and EU official API hosts; arbitrary origins and redirects are rejected. Polling is bounded, individual requests have timeouts, transient GET failures can retry, and POST job creation is not automatically repeated. Provider file/job IDs and returned artifacts are retained for debugging, including failures. Provider errors are sanitized before appearing in envelopes/logs.

`LLAMA_PARSE_VERSION=latest` is an integration convenience, not a reproducibility guarantee. Pin a supported concrete provider version before production claims; concrete returned provider configuration is retained in raw artifacts. The current L1 build does not run a durable distributed worker service or automatically resume an unfinished cloud job after a process crash. The recorded job ID is available for a future L3 recovery adapter; a new `process` call creates a new auditable attempt and may incur another provider charge.

Sources: [LiteParse library API](https://developers.llamaindex.ai/liteparse/guides/library-usage/), [Parse setup/wire format](https://developers.llamaindex.ai/llamaparse/parse/getting_started/), [Extract response and citation metadata](https://developers.llamaindex.ai/llamaparse/extract/guides/response-format/).

## L3 integration

```ts
import { createL1 } from '@praeco/evidence-intelligence';

const l1 = createL1({
  storageRoot: '/private/praeco-evidence',
  // Supply only in the trusted backend when provisioned:
  // llamaCloud: { apiKey: serverConfiguration.llamaCloudKey },
});

const source = await l1.register({
  tenantId: authenticatedTenantId,
  bytes: exactBodySnapshot,
  channel: 'EMAIL',
  mimeType: 'text/plain',
  originMessageId: inboundMessageId,
});
const envelopes = await l1.process(source);
```

Bind the tenant in authenticated application context, not an agent-supplied argument. Give the L3 model narrowly scoped tool wrappers and redacted summaries, not the store instance or arbitrary filesystem access. L3 retains each source separately, correlates `PayableCase`, and handles retries/human review. An extraction failure does not become a financial `BLOCKED` decision.

Registration is tenant-scoped and content-addressed; replaying identical bytes/channel/origin returns the original registered descriptor. Reusing the same transport message ID with different content fails. Reprocessing a registered source creates a new run and envelopes; L1 does not claim business-invoice deduplication or exactly-once external provider jobs. Those are distinct from financial ledger idempotency.

## L2 integration and trust

```ts
import { compareUsdRatio } from '@praeco/evidence-intelligence';

// Resolve from backend-owned storage, never accept an agent-authored envelope/report.
const verified = await l1.reader.loadReady(authenticatedTenantId, envelopeId);
const invoiceClaim = verified.envelope.invoice;
const comparison = compareUsdRatio(verified.usdRatio, '2500.00');
// comparison is arithmetic only. L2 owns all policy gates and the final decision.
```

`loadReady` verifies the persisted envelope receipt/hash, original source and every retained artifact binding, report content, invoice digest and recomputed normalization. It returns the full-envelope integrity digest and original exact USD numerator/denominator. Rounded `usdEquivalent` is for display; comparing MXN `50000.01 / 20` with USD `2500` must return greater-than even though the displayed value rounds to `2500.00`.

Canonical JSON v1 recursively sorts object keys, preserves array order and rejects undefined/nonfinite values. `invoiceDigestSha256` hashes the canonical invoice only, as named by the contract. The server-owned content-addressed envelope receipt separately binds normalization, citations, source/segment, provenance, artifacts and the verification report. The receipt does not add or change wire fields. Its protection assumes a trusted application/storage boundary; a filesystem administrator who can replace all records is outside this demo threat model. There is no public attestation/signature service.

L2 must still resolve authoritative vendor/account/contract/policy records, enforce duplicates/budgets/limits atomically, bind approval requests to revisions and reevaluate current state. An L1-ready changed account is correct extraction, not an allowed beneficiary. All downstream authorizations remain simulated.

## Readiness and monetary semantics

The conservative critical profile requires observed invoice number, due date, beneficiary legal name/tax ID/payment account, currency and total. Account rail must be explicitly present for the labelled format. Every observed field requires grounded evidence; optional missing fields are allowed, but ambiguous/conflicting observations require review. New formats and assurance profiles need explicit review and validation rather than weakening this profile globally.

Text evidence uses half-open UTF-8 byte spans into retained per-page artifacts or exact native message bytes. The verifier checks codepoint boundaries, source/hash binding, page/segment membership, quote equality, field-value support, label context, source conflicts and artifact hashes. Unsupported context routes to review. A page bounding box alone is not accepted as proof of its quoted text. Instruction-pattern detection only adds a review signal; capability isolation and deterministic verification enforce the actual trust boundary.

Amounts are nonnegative base-10 decimal strings, at most 15 integer digits and six decimal places; unsupported credit/refund semantics and zero payables do not become ready. Money arithmetic uses an isolated decimal.js context at 80 digits with HALF_EVEN output to two USD decimals. Quote direction is always source units per USD. Demo COP/MXN snapshots are pinned and fictional; USD uses identity.

An explicitly observed outstanding balance is preferred. Otherwise the observed total is a candidate, not a statement that nothing was previously paid. Positive observed paid amounts without a remaining balance require review; consistent total/paid/outstanding and complete subtotal/tax/discount or line-item arithmetic are checked. L2 independently reconciles prior obligations and reservations. L1 does not choose budget periods or financial policy thresholds.

## Validation and current limits

- Deterministic unit/property tests cover arithmetic, HALF_EVEN, invalid decimals/rates, exact threshold comparisons, trust resolution, source and envelope tampering, tenant isolation, UTF-8 citations and provider errors.
- The offline corpus includes 30 distinct source documents: 4 digital USD PDFs, 5 COP PDFs, 4 actual rasterized invoices, 4 native email/chat bodies, 3 two-invoice PDF packets, 4 contradictory documents, 3 missing/corrupt/changed-account documents and 3 injection documents.
- Raster cases without hosted parsing explicitly expect non-ready operational results. Those tests demonstrate safe absence of a provider, not OCR accuracy. Hosted OCR currently always requires review.
- Test-only annotations are machine-authored and reviewed in code; independent human annotation/sign-off remains pending. The manifest states this limitation. It never enters runtime input, model prompts or package/image runtime files.
- LlamaParse/LlamaExtract HTTP protocol tests use mocked responses. Without a provisioned key, no live cloud quality, latency or billing claim is made.
- L2/L3 end-to-end golden financial decisions, authenticated UI, multi-process recovery, production object storage, source-retention policy and production readiness are not validated by these L1 tests.

Before widening automatic readiness, run live adapter tests and independently annotated representative documents, then measure unsafe-ready cases **and** correct useful acceptance. Keep production readiness distinct from a passing synthetic harness.
