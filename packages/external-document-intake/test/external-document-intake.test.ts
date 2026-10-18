import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createL1, L1_CONTRACT_VERSION } from '../../evidence-intelligence/src/index.js';
import { createExternalDocumentIntake, createSyntheticErpAdapter, FileExternalDocumentProvenanceStore } from '../src/index.js';
import type { SyntheticErpBill, ExternalDocumentReference, SyntheticErpImportResult } from '../src/index.js';
import { integrationHash } from '../src/external-document-provenance.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const now = () => '2026-10-18T12:00:00Z';
const objectReference = { provider: 'MOCK_ERP', connectionId: 'synthetic-connection', externalEntityType: 'BILL', externalEntityId: 'bill-1' } as const;
const reference: ExternalDocumentReference = { ...objectReference, externalRevision: 'revision-1', externalAttachmentId: 'attachment-1' };

async function setup(tenantId = 'tenant-a', sharedRoot?: string) {
  const root = sharedRoot ?? await mkdtemp(join(tmpdir(), 'praeco-external-intake-'));
  if (!sharedRoot) roots.push(root);
  const l1 = createL1({ storageRoot: join(root, 'evidence'), now });
  const provenance = new FileExternalDocumentProvenanceStore(join(root, 'provenance'), now);
  let status: 'ACTIVE' | 'REVOKED' | 'UNAVAILABLE' = 'ACTIVE';
  const adapter = createSyntheticErpAdapter({ authenticatedTenantId: tenantId, connectionId: 'synthetic-connection',
    l1, provenance, now, connectionStatus: async () => status });
  const text = await readFile(new URL('../../evidence-intelligence/examples/invoice.txt', import.meta.url), 'utf8');
  const bill: SyntheticErpBill = { billId: 'bill-1', revision: 'revision-1', recordedAmount: { amount: '1.00', currency: 'USD' },
    beneficiaryReference: 'erp-vendor-reference', attachment: { attachmentId: 'attachment-1', bytes: Buffer.from(text), channel: 'EMAIL', mimeType: 'text/plain' } };
  return { root, l1, provenance, adapter, text, bill, setStatus(value: typeof status) { status = value; } };
}

function imported(result: SyntheticErpImportResult) {
  expect(result.kind).toBe('DOCUMENT_IMPORTED');
  if (result.kind !== 'DOCUMENT_IMPORTED') throw new Error('Expected imported document');
  return result.document;
}

describe('external documentary provenance', () => {
  it('imports a synthetic ERP PDF and keeps accounting claims outside the verified envelope', async () => {
    const { l1, adapter, bill, provenance } = await setup();
    const bytes = await readFile(new URL('../../evidence-intelligence/test/fixtures/corpus/01.pdf', import.meta.url));
    const result = await adapter.importBill({ ...bill, attachment: { attachmentId: 'attachment-1', bytes, channel: 'PDF', mimeType: 'application/pdf' } });
    const document = imported(result);
    const ready = await l1.reader.loadReady('tenant-a', document.envelopes[0]!.envelopeId);
    expect(L1_CONTRACT_VERSION).toBe('3.0.0');
    expect(ready.envelope.schemaVersion).toBe('3.0.0');
    expect(ready.envelope.source.channel).toBe('PDF');
    expect(ready.envelope.normalization.usdEquivalent).toEqual({ amount: '2200.00', currency: 'USD' });
    expect(result.accountingRecord.recordedAmount).toEqual({ amount: '1.00', currency: 'USD' });
    expect(ready.envelope).not.toHaveProperty('provider');
    expect(ready.envelope).not.toHaveProperty('externalEntityId');
    expect(ready.envelope).not.toHaveProperty('outcome');
    expect(JSON.stringify(ready.envelope)).not.toContain('erp-vendor-reference');
    expect(document.binding).toMatchObject({ ...reference, tenantId: 'tenant-a', sourceId: ready.envelope.source.sourceId,
      sourceHashSha256: integrationHash(bytes) });
    expect(await provenance.history('tenant-a', objectReference)).toEqual([document.binding]);
  }, 15000);

  it('reuses the original binding and persisted references on identical delivery after restart', async () => {
    const { root, l1, adapter, bill } = await setup();
    const process = vi.spyOn(l1, 'process');
    const first = imported(await adapter.importBill(bill));
    const duplicate = imported(await adapter.importBill(bill));
    expect(duplicate).toEqual(first);
    expect(process).toHaveBeenCalledTimes(1);
    const restarted = await setup('tenant-a', root);
    const reprocess = vi.spyOn(restarted.l1, 'process');
    expect(imported(await restarted.adapter.importBill(bill))).toEqual(first);
    expect(reprocess).not.toHaveBeenCalled();
  });

  it('preserves documentary idempotency under concurrent identical deliveries', async () => {
    const { adapter, bill, provenance } = await setup();
    const results = await Promise.all([adapter.importBill(bill), adapter.importBill(bill)]);
    expect(imported(results[0]!)).toEqual(imported(results[1]!));
    expect(await provenance.history('tenant-a', objectReference)).toHaveLength(1);
  });

  it('retains changed attachments as distinct revisions without changing historical evidence or replay', async () => {
    const { adapter, bill, l1, provenance, root, text, setStatus } = await setup();
    const first = imported(await adapter.importBill(bill));
    const changed = { ...bill, revision: 'revision-2', attachment: { ...bill.attachment!, bytes: Buffer.from(text.replaceAll('8000000', '9000000')) } };
    const second = imported(await adapter.importBill(changed));
    expect(first.binding.sourceId).not.toBe(second.binding.sourceId);
    expect(first.binding.sourceHashSha256).not.toBe(second.binding.sourceHashSha256);
    const original = await l1.reader.loadReady('tenant-a', first.envelopes[0]!.envelopeId);
    const updated = await l1.reader.loadReady('tenant-a', second.envelopes[0]!.envelopeId);
    expect(original.envelope.normalization.usdEquivalent?.amount).toBe('2000.00');
    expect(updated.envelope.normalization.usdEquivalent?.amount).toBe('2250.00');
    expect(await readFile(join(root, 'evidence', original.envelope.source.storageKey), 'utf8')).toBe(text);
    expect(await provenance.history('tenant-a', objectReference)).toHaveLength(2);
    setStatus('REVOKED');
    expect((await l1.replay('tenant-a', original.envelope.envelopeId)).invoice).toEqual(original.envelope.invoice);
    expect((await l1.reader.loadReady('tenant-a', original.envelope.envelopeId)).envelope).toEqual(original.envelope);
  });

  it('rejects different bytes under the same immutable provider revision', async () => {
    const { adapter, bill, text, provenance } = await setup();
    const original = imported(await adapter.importBill(bill));
    await expect(adapter.importBill({ ...bill, attachment: { ...bill.attachment!, bytes: Buffer.from(`${text}\nChanged source`) } }))
      .rejects.toThrow('EXTERNAL_REVISION_CONTENT_CONFLICT');
    expect(await provenance.history('tenant-a', objectReference)).toEqual([original.binding]);
    expect(await adapter.intake.load(original.binding.bindingId)).toEqual(original);
  });

  it('uses content snapshots when the provider has no revision and makes no business duplicate decision', async () => {
    const { adapter, bill, text, l1 } = await setup();
    const { revision: _revision, ...unversioned } = bill;
    const first = imported(await adapter.importBill(unversioned));
    const second = imported(await adapter.importBill({ ...unversioned, attachment: { ...bill.attachment!, bytes: Buffer.from(`${text}\nForwarded copy`) } }));
    expect(second.binding.sourceId).not.toBe(first.binding.sourceId);
    const a = await l1.reader.loadReady('tenant-a', first.envelopes[0]!.envelopeId);
    const b = await l1.reader.loadReady('tenant-a', second.envelopes[0]!.envelopeId);
    expect(a.envelope.invoice.invoice.number).toMatchObject({ state: 'OBSERVED', value: 'SYN-CO-001' });
    expect(b.envelope.invoice.invoice.number).toMatchObject({ state: 'OBSERVED', value: 'SYN-CO-001' });
    expect(b.envelope.evidence[0]?.sourceId).not.toBe(a.envelope.evidence[0]?.sourceId);
    expect(b.envelope).not.toHaveProperty('duplicate');
  });

  it('keeps separate attachments and metadata updates under the same external bill', async () => {
    const { adapter, bill, provenance, text } = await setup();
    const first = imported(await adapter.importBill(bill));
    const second = imported(await adapter.importBill({ ...bill, attachment: { ...bill.attachment!, attachmentId: 'attachment-2', bytes: Buffer.from(`${text}\nSecond attachment`) } }));
    const metadata = imported(await adapter.importBill({ ...bill, updatedAt: '2026-10-18T11:00:00Z' }));
    expect(first.binding.sourceId).not.toBe(second.binding.sourceId);
    expect(metadata.binding.sourceId).toBe(first.binding.sourceId);
    expect(metadata.binding.bindingId).not.toBe(first.binding.bindingId);
    expect(await provenance.history('tenant-a', objectReference)).toHaveLength(3);
  });

  it('isolates identical provider and bill IDs across tenants in both stores', async () => {
    const a = await setup();
    const b = await setup('tenant-b', a.root);
    const first = imported(await a.adapter.importBill(a.bill));
    const second = imported(await b.adapter.importBill(b.bill));
    expect(second.binding.sourceId).not.toBe(first.binding.sourceId);
    expect(second.binding.bindingId).not.toBe(first.binding.bindingId);
    await expect(b.adapter.intake.load(first.binding.bindingId)).rejects.toThrow('EXTERNAL_BINDING_NOT_FOUND');
    await expect(b.l1.reader.loadReady('tenant-b', first.envelopes[0]!.envelopeId)).rejects.toThrow('ENVELOPE_NOT_FOUND');
    expect(await b.provenance.history('tenant-b', objectReference)).toEqual([second.binding]);
    const foreignTenantReference = { ...reference, tenantId: 'tenant-b' };
    await expect(a.adapter.intake.ingest({ externalReference: foreignTenantReference, documentBytes: a.bill.attachment!.bytes,
      channel: 'EMAIL', mimeType: 'text/plain' })).rejects.toThrow('INVALID_EXTERNAL_REFERENCE');
  });

  it('keeps a bill without an attachment as accounting context and rejects forged evidence fields', async () => {
    const { adapter, bill, l1 } = await setup();
    const register = vi.spyOn(l1, 'register');
    const { attachment: _attachment, ...withoutAttachment } = bill;
    const result = await adapter.importBill(withoutAttachment);
    expect(result).toMatchObject({ kind: 'DOCUMENT_REQUIRED', accountingRecord: withoutAttachment });
    expect(result).not.toHaveProperty('document');
    expect(register).not.toHaveBeenCalled();
    const forgedRecord = { ...withoutAttachment, verification: { status: 'ACCEPTED' }, processingStatus: 'READY_FOR_POLICY_EVALUATION' };
    await expect(adapter.importBill(forgedRecord))
      .rejects.toThrow('INVALID_SYNTHETIC_ERP_RECORD');
  });

  it('does not fill missing documentary account evidence from the ERP beneficiary reference', async () => {
    const { adapter, bill, text, l1 } = await setup();
    const document = imported(await adapter.importBill({ ...bill, attachment: { ...bill.attachment!, bytes: Buffer.from(text.replace('Account: SYN-ACCOUNT-001\n', '')) } }));
    const envelope = await l1.reader.load('tenant-a', document.envelopes[0]!.envelopeId);
    expect(envelope.invoice?.beneficiary.paymentAccount.state).toBe('MISSING');
    expect(envelope.processingStatus).toBe('REVIEW_REQUIRED');
    await expect(l1.reader.loadReady('tenant-a', envelope.envelopeId)).rejects.toThrow('ENVELOPE_NOT_READY');
  });

  it.each(['REVOKED', 'UNAVAILABLE'] as const)('rejects %s connections on both new and cached intake', async status => {
    const { adapter, bill, l1, setStatus } = await setup();
    const document = imported(await adapter.importBill(bill));
    const register = vi.spyOn(l1, 'register');
    setStatus(status);
    await expect(adapter.importBill(bill)).rejects.toThrow(`EXTERNAL_CONNECTION_${status}`);
    await expect(adapter.intake.load(document.binding.bindingId)).rejects.toThrow(`EXTERNAL_CONNECTION_${status}`);
    expect(register).not.toHaveBeenCalled();
    expect((await l1.reader.loadReady('tenant-a', document.envelopes[0]!.envelopeId)).envelope.processingStatus).toBe('READY_FOR_POLICY_EVALUATION');
  });

  it('rejects unsupported, empty and oversized content before L1 registration', async () => {
    const { adapter, l1 } = await setup();
    const register = vi.spyOn(l1, 'register');
    for (const bytes of [new Uint8Array(), new Uint8Array(20_000_001)]) {
      await expect(adapter.intake.ingest({ externalReference: reference, documentBytes: bytes, channel: 'PDF', mimeType: 'application/pdf' }))
        .rejects.toThrow('EXTERNAL_DOCUMENT_SIZE_LIMIT');
    }
    await expect(adapter.intake.ingest({ externalReference: reference, documentBytes: Buffer.from('{"Bill":{}}'), channel: 'PDF', mimeType: 'application/pdf' }))
      .rejects.toThrow('UNSUPPORTED_EXTERNAL_DOCUMENT');
    await expect(adapter.intake.ingest({ externalReference: reference, documentBytes: Buffer.from('%PDF-fake'), channel: 'EMAIL', mimeType: 'text/plain' }))
      .rejects.toThrow('UNSUPPORTED_EXTERNAL_DOCUMENT');
    expect(register).not.toHaveBeenCalled();
  });

  it('keeps provider errors and credentials out of operational failures', async () => {
    const { l1, provenance, bill } = await setup();
    const intake = createExternalDocumentIntake({ authenticatedTenantId: 'tenant-a', l1, provenance,
      resolveConnection: async () => { throw new Error('Bearer secret-example account SYN-ACCOUNT-PRIVATE'); } });
    await expect(intake.ingest({ externalReference: reference, documentBytes: bill.attachment!.bytes, channel: 'EMAIL', mimeType: 'text/plain' }))
      .rejects.toThrow(/^EXTERNAL_CONNECTION_UNAVAILABLE$/);
    const credentialBearingReference = { ...reference, accessToken: 'secret-example' };
    await expect(intake.ingest({ externalReference: credentialBearingReference, documentBytes: bill.attachment!.bytes,
      channel: 'EMAIL', mimeType: 'text/plain' })).rejects.toThrow(/^INVALID_EXTERNAL_REFERENCE$/);
  });

  it('does not let an unrelated connection or provider bypass scoped connection resolution', async () => {
    const { adapter, bill, l1 } = await setup();
    const register = vi.spyOn(l1, 'register');
    for (const externalReference of [{ ...reference, connectionId: 'other-connection' }, { ...reference, provider: 'BLINKA' as const }]) {
      await expect(adapter.intake.ingest({ externalReference, documentBytes: bill.attachment!.bytes, channel: 'EMAIL', mimeType: 'text/plain' }))
        .rejects.toThrow('EXTERNAL_CONNECTION_UNAVAILABLE');
    }
    expect(register).not.toHaveBeenCalled();
  });

  it('rejects a stored receipt redirected to another valid ready envelope', async () => {
    const { adapter, bill, root, text } = await setup();
    const first = imported(await adapter.importBill(bill));
    const second = imported(await adapter.importBill({ ...bill, revision: 'revision-2', attachment: { ...bill.attachment!, bytes: Buffer.from(`${text}\nRevision`) } }));
    const receiptPath = join(root, 'provenance', integrationHash('tenant-a'), 'receipts', `${first.binding.bindingId}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    await writeFile(receiptPath, JSON.stringify({ ...receipt, envelopes: second.envelopes }));
    await expect(adapter.intake.load(first.binding.bindingId)).rejects.toThrow('IMPORTED_EVIDENCE_BINDING_MISMATCH');
  });

  it('detects source corruption when resolving a cached imported result', async () => {
    const { adapter, bill, root, l1 } = await setup();
    const document = imported(await adapter.importBill(bill));
    const ready = await l1.reader.loadReady('tenant-a', document.envelopes[0]!.envelopeId);
    await writeFile(join(root, 'evidence', ready.envelope.source.storageKey), 'tampered');
    await expect(adapter.intake.load(document.binding.bindingId)).rejects.toThrow('IMPORTED_EVIDENCE_UNAVAILABLE');
    await expect(l1.reader.loadReady('tenant-a', ready.envelope.envelopeId)).rejects.toThrow('ARTIFACT_HASH_MISMATCH');
  });

  it('detects overwritten external metadata instead of silently changing provenance', async () => {
    const { adapter, bill, root, provenance } = await setup();
    const document = imported(await adapter.importBill(bill));
    const path = join(root, 'provenance', integrationHash('tenant-a'), 'bindings', `${document.binding.bindingId}.json`);
    await writeFile(path, JSON.stringify({ ...document.binding, externalEntityId: 'another-bill' }));
    await expect(provenance.load('tenant-a', document.binding.bindingId)).rejects.toThrow('INTEGRATION_BINDING_MISMATCH');
  });
});
