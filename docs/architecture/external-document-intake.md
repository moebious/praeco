# External document intake and provenance

This implements the additive integration slice described by `L1-INT-001`. It changes no canonical L1 contract, intake channel, financial authority or wire version. The repository remains v1; the L1 wire discriminator remains `3.0.0`.

## Integration impact assessment

| Concern | Existing capability | Integration change |
| --- | --- | --- |
| Exact documentary bytes | Tenant-scoped immutable L1 registration | Reuse `register()` after checking document size/type |
| Provider identity and revisions | `originMessageId` supplies transport immutability; no ERP metadata model | Separate external bindings and deterministic snapshot origins |
| Extraction, citations and money | Independent verifier and pinned exact-decimal normalization | Reuse `process()` without ERP values in its input |
| Downstream trust | Persisted envelope reader and deterministic replay | Return IDs, then resolve through the trusted reader |
| Payable correlation and ERP discrepancies | L3 owns the case; L2 owns financial validity | Return accounting context separately; make no matching decision |
| Persistence and orchestration | L1 immutable persistence port; local implementation | Separate local provenance store; Neon and durable execution remain future adapters |

Implementation lives in `packages/external-document-intake`, outside the L1 domain package. Real QuickBooks, Xero and Blinka adapters are unavailable. Their provider names are reserved metadata values, not compatibility claims. Only `MOCK_ERP` is exercised.

The handoff's cloud-failure description predates the latest narrow synthetic recheck. The [live provider record](../evaluation/llama-cloud-live-smoke.md) preserves the earlier failures and later two-PDF success; the scan still requires review. This integration does not add cloud assurance or run a billable smoke test.

## Trusted intake operation

The trusted backend constructs a tenant-bound intake service after authenticating the request. Tenant identity is configuration, never a document or provider metadata field. The upstream connection resolver must enforce tenant/provider/connection scope and return `ACTIVE` before a document can be imported or its integration receipt returned.

```ts
import { createExternalDocumentIntake, FileExternalDocumentProvenanceStore } from '@praeco/external-document-intake';

const intake = createExternalDocumentIntake({
  authenticatedTenantId,
  l1,
  provenance: new FileExternalDocumentProvenanceStore('/private/praeco-integrations'),
  resolveConnection: identity => connectionRegistry.status(identity),
});

const imported = await intake.ingest({
  externalReference: {
    provider: 'MOCK_ERP',
    connectionId: 'synthetic-connection',
    externalEntityType: 'BILL',
    externalEntityId: 'bill-1',
    externalRevision: 'revision-1',
    externalAttachmentId: 'attachment-1',
  },
  documentBytes: alreadyFetchedBytes,
  channel: 'PDF',
  mimeType: 'application/pdf',
});
```

The operation copies the input bytes, checks the 20 MB limit and supported channel/MIME/signature, registers the exact snapshot, captures its binding, and processes it with L1. Native email/chat snapshots must be valid UTF-8 `text/plain`. PDF/image signatures are an intake filter; L1 still performs parsing and verification.

The integration has no HTTP fetcher. OAuth, credentials, webhook authenticity, connection ownership, permissions and fetching belong upstream. A TypeScript tenant argument is not an authentication mechanism; this factory and both stores remain backend-only.

## Provenance and snapshot identity

An external object is identified by the authenticated tenant plus provider, connection, entity type and entity ID. Attachment identity is separate from that parent object. Every binding stores those fields, optional provider revision/update time/attachment ID, the L1 source ID/hash and first capture time. Strict schemas reject unknown fields, including credentials and self-asserted verification reports.

| Situation | Snapshot behavior |
| --- | --- |
| Same attachment, revision, format and bytes delivered again | Same source and binding; reuse an existing completed intake receipt |
| Reliable provider revision changes | New immutable origin, source and binding |
| Same reliable revision/attachment/format reused with different bytes | Registration fails with `EXTERNAL_REVISION_CONTENT_CONFLICT` |
| No provider revision | Content digest determines the snapshot version; changed bytes create a new source |
| Another attachment under the same Bill | Separate snapshot, retained under the same parent external object |
| Provider update timestamp changes without document changes | Retain another metadata binding to the same source; preserve the earlier binding |
| Same external identifiers under another tenant | Separate sources, bindings and receipts |

The origin is a digest of provider/connection/object/attachment, a tagged provider revision or content digest, and document channel/MIME. L1 supplies tenant scoping. Binding IDs also include the source digest and retained external metadata. Capture time is first-writer-wins and does not affect identity. Provider timestamps and revision names do not establish financial authority or select a financially valid "latest" obligation.

Bindings and completion receipts are separate immutable records. A captured binding without a receipt records an interrupted attempt and can be redelivered. A receipt retains envelope IDs, run IDs and processing dispositions; it is not a verification report. Before returning references, the intake checks each through `reader.load()` and compares the stored source/run/status bindings. Corrupted or redirected evidence fails closed.

Sequential identical redelivery with a receipt avoids another processing run. Concurrent deliveries or a crash before the receipt commit can still produce extra retained L1 runs and provider charges. No distributed exactly-once processing is claimed. A completed failed/review receipt is returned unchanged; explicit reprocessing and retry orchestration belong to the trusted application/L3, not silent receipt replacement.

The local store uses restricted directories, hashed tenant/record paths and atomic first-writer records. `history()` scans one tenant's bindings and returns capture order, preserving every revision. It is intended for the synthetic slice; indexed database storage, retention, durable queues and multi-process provider-job recovery remain future work. Its trust model assumes backend-controlled storage, as does the existing local evidence store.

## L3 and L2 consumption

`imported.binding` correlates the external object to its immutable `sourceId` and `sourceHashSha256`. `imported.envelopes` contains only envelope IDs, run IDs and L1 dispositions. L3 owns `PayableCase` creation and association. The adapter neither creates a payable-case ID nor uses a Bill ID as the business duplicate key.

L2 resolves each proposed envelope through the existing trusted boundary:

```ts
const evidence = await l1.reader.loadReady(
  authenticatedTenantId,
  imported.envelopes[0].envelopeId,
);
```

A reference or an ERP JSON record does not grant readiness. `loadReady()` still rejects missing, corrupt or non-ready evidence. An observed account is a documentary claim; L2 independently resolves the permitted beneficiary/account, contract, duplicates, budget and policy. An ERP recorded amount never replaces the document's observed amount. No banking quote enters L1 normalization and no payment decision or instruction is emitted.

Revoked/unavailable connections block new imports and integration receipt lookup. Authorized historical L1 reads/replay use retained data without contacting the provider, even if its connection is no longer available. Retention/access policy remains the backend's responsibility.

## Synthetic ERP slice and validation

`createSyntheticErpAdapter()` accepts an already-fetched synthetic Bill, recorded amount, optional opaque beneficiary reference and optional document attachment. It returns accounting context separately from document references. A Bill without an attachment yields `DOCUMENT_REQUIRED`, with no registered source or fabricated envelope. Account references cannot fill missing documentary fields or authorize a beneficiary.

Run `npm run test:l1:integration` for the explicit integration suite. It exercises an actual synthetic PDF, repeat and concurrent delivery, revision conflicts, digest snapshots, multiple attachments, tenant separation, missing attachments, ERP/document amount disagreement, missing account evidence, revoked/unavailable connections, unsafe metadata, source/receipt tampering and offline historical replay.

Run `npm ci`, `npm run check`, `npm run l1:demo` and `npm run l1:evaluate` for full local validation. The 30-document corpus and Golden Set expected decisions stay test-only and unchanged. Independent field annotation remains deferred; these tests establish boundary behavior, not production extraction accuracy, real ERP interoperability or end-to-end financial authorization.
