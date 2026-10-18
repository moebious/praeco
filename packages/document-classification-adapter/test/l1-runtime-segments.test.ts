import { describe, expect, it, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createL1 } from '@praeco/evidence-intelligence';
import {
  SegmentedLabelledTextExtractor,
  StaticSegmentClassificationSource,
  validateSplitResult,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const INVOICE_A = [
  'SYNTHETIC INVOICE — NOT A REAL COMPANY OR PAYMENT',
  'Invoice number: SYN-A-2026',
  'Issue date: 2026-10-01',
  'Due date: 2026-10-31',
  'Beneficiary: Synthetic Alpha',
  'Tax ID: SYN-TAX-A',
  'Payment rail: BANK',
  'Account: SYN-ACCOUNT-A',
  'Contract: SYN-CONTRACT-A',
  'Description: Synthetic engineering services',
  'Currency: USD',
  'Subtotal: 1200',
  'Taxes: 0',
  'Discounts: 0',
  'Total due: 1200',
  'Already paid: 0',
  'Outstanding balance: 1200',
].join('\n');

const CONTRACT = [
  'SERVICE CONTRACT 72',
  'Agreement between Demo Company and Synthetic Alpha.',
  'This contract does not request any payment.',
].join('\n');

const INVOICE_B = INVOICE_A
  .replace('SYN-A-2026', 'SYN-B-2026')
  .replace('Synthetic Alpha', 'Synthetic Beta')
  .replace('SYN-TAX-A', 'SYN-TAX-B')
  .replace('SYN-ACCOUNT-A', 'SYN-ACCOUNT-B')
  .replace('SYN-CONTRACT-A', 'SYN-CONTRACT-B');

function packetOf(segments: Array<{ category: string; pages: number[]; needsReview?: boolean }>, pageCount: number) {
  return validateSplitResult(
    {
      schema_version: '1',
      task: 'split',
      segments: segments.map((segment, index) => ({
        id: `segment-${String(index + 1).padStart(3, '0')}`,
        category: segment.category,
        pages: segment.pages,
        needs_review: segment.needsReview ?? false,
        review_reasons: [],
      })),
      warnings: [],
      document: { page_count: pageCount, source_sha256: SHA_A, canonical_sha256: SHA_B },
      engine: 'jev',
      model: 'jev-1.14',
      metrics: { decision_ms: 250, decision_cost_usd: 0.00005 },
    },
    { expectedPageCount: pageCount }
  );
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

describe('segmented packets through the real L1 runtime', () => {
  it('produces one READY envelope per verified invoice segment with DOCJEV provenance', async () => {
    const packetBytes = Buffer.from([INVOICE_A, CONTRACT, INVOICE_B].join('\f'));
    const classification = packetOf(
      [
        { category: 'invoice', pages: [1] },
        { category: 'contract', pages: [2] },
        { category: 'invoice', pages: [3] },
      ],
      3
    );
    const root = await mkdtemp(join(tmpdir(), 'praeco-l1-segments-'));
    roots.push(root);
    const runtime = createL1({
      storageRoot: root,
      now: () => '2026-10-17T12:00:00Z',
      extractor: new SegmentedLabelledTextExtractor({
        classification: new StaticSegmentClassificationSource([
          { sourceHashSha256: sha256(packetBytes), packet: classification },
        ]),
      }),
    });

    const source = await runtime.register({ tenantId: 'tenant-a', bytes: packetBytes, channel: 'CHAT', mimeType: 'text/plain' });
    const receipt = await runtime.processWithReceipt(source);

    expect(receipt.sourceDisposition).toBe('INVOICE_OR_UNCERTAIN');
    expect(receipt.envelopes).toHaveLength(2);

    const [envelopeA, envelopeB] = receipt.envelopes;
    expect(envelopeA!.processingStatus).toBe('READY_FOR_POLICY_EVALUATION');
    expect(envelopeB!.processingStatus).toBe('READY_FOR_POLICY_EVALUATION');
    expect(envelopeA!.segment).toMatchObject({ startPage: 1, endPage: 1, classifiedBy: 'DOCJEV' });
    expect(envelopeB!.segment).toMatchObject({ startPage: 3, endPage: 3, classifiedBy: 'DOCJEV' });
    expect(envelopeA!.provenance.classification.provider).toBe('DOCJEV');
    expect(envelopeB!.provenance.classification.provider).toBe('DOCJEV');
    expect(envelopeA!.evidence.every(item => item.segmentId === envelopeA!.segment!.segmentId)).toBe(true);
    expect(envelopeA!.source.sourceHashSha256).toBe(source.sourceHashSha256);

    const ready = await runtime.reader.loadReady('tenant-a', envelopeA!.envelopeId);
    expect(ready.envelope.segment!.classifiedBy).toBe('DOCJEV');
  });

  it('routes review-flagged invoice segments to REVIEW_REQUIRED, never READY', async () => {
    const packetBytes = Buffer.from([INVOICE_A, CONTRACT].join('\f'));
    const classification = packetOf(
      [
        { category: 'invoice', pages: [1], needsReview: true },
        { category: 'contract', pages: [2] },
      ],
      2
    );
    const root = await mkdtemp(join(tmpdir(), 'praeco-l1-segments-'));
    roots.push(root);
    const runtime = createL1({
      storageRoot: root,
      now: () => '2026-10-17T12:00:00Z',
      extractor: new SegmentedLabelledTextExtractor({
        classification: new StaticSegmentClassificationSource([
          { sourceHashSha256: sha256(packetBytes), packet: classification },
        ]),
      }),
    });

    const source = await runtime.register({ tenantId: 'tenant-a', bytes: packetBytes, channel: 'CHAT', mimeType: 'text/plain' });
    const receipt = await runtime.processWithReceipt(source);

    expect(receipt.envelopes).toHaveLength(1);
    expect(receipt.envelopes[0]!.processingStatus).toBe('REVIEW_REQUIRED');
    await expect(runtime.reader.loadReady('tenant-a', receipt.envelopes[0]!.envelopeId)).rejects.toThrow();
  });

  it('fails closed to review when a classified packet contains no invoice segments', async () => {
    const packetBytes = Buffer.from([CONTRACT, CONTRACT].join('\f'));
    const classification = packetOf(
      [
        { category: 'contract', pages: [1] },
        { category: 'contract', pages: [2] },
      ],
      2
    );
    const root = await mkdtemp(join(tmpdir(), 'praeco-l1-segments-'));
    roots.push(root);
    const runtime = createL1({
      storageRoot: root,
      now: () => '2026-10-17T12:00:00Z',
      extractor: new SegmentedLabelledTextExtractor({
        classification: new StaticSegmentClassificationSource([
          { sourceHashSha256: sha256(packetBytes), packet: classification },
        ]),
      }),
    });

    const source = await runtime.register({ tenantId: 'tenant-a', bytes: packetBytes, channel: 'CHAT', mimeType: 'text/plain' });
    const receipt = await runtime.processWithReceipt(source);

    expect(receipt.envelopes).toHaveLength(1);
    expect(receipt.envelopes[0]!.processingStatus).toBe('REVIEW_REQUIRED');
    expect(receipt.envelopes[0]!.errors[0]?.code).toBe('UNCERTAIN_DOCUMENT_KIND');
  });
});
