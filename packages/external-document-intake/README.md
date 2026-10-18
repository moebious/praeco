# External document intake

Backend-only documentary intake and provenance for Praeco integrations. This package registers immutable snapshots through L1 and records external provider, object, and revision bindings separately from invoice evidence.

## Behavior

- Preserve external document revisions and source hashes.
- Return persisted source, processing-run, and envelope references for L3.
- Distinguish invoice input from supplemental context, which may produce no invoice envelope.
- Keep accounting metadata separate from verified documentary facts.

`MOCK_ERP` is synthetic. QuickBooks, Xero, and Blinka identifiers are metadata values, not implemented live integrations. The package does not make financial decisions.

## Test

From the repository root:

```bash
npm run build
npm run test:l1:integration
```

See the [intake contract and trust boundaries](../../docs/architecture/external-document-intake.md) and [L1 trusted readers](../../docs/architecture/l1-runtime.md).
