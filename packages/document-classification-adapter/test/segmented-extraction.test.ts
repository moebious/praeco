import { describe, expect, it } from 'vitest';
import type { DocumentSource, ParsedDocument } from '@praeco/evidence-intelligence';
import { L1Error } from '@praeco/evidence-intelligence';
import {
  SegmentedLabelledTextExtractor,
  StaticSegmentClassificationSource,
  validateSplitResult,
  type ClassifiedPacket,
  type SegmentClassificationSource,
} from '../src/index.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function packetFor(segments: Array<{ category: string; pages: number[]; needsReview?: boolean }>): ClassifiedPacket {
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
      document: { page_count: segments.reduce((acc, s) => acc + s.pages.length, 0), source_sha256: SHA_A, canonical_sha256: SHA_B },
      engine: 'jev',
      model: 'jev-1.14',
      metrics: { decision_ms: 250, decision_cost_usd: 0.00005 },
    },
    { expectedPageCount: segments.reduce((acc, s) => acc + s.pages.length, 0) }
  );
}

const INVOICE_A_PAGE_1 = [
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
  'Line 1 description: Milestone one',
  'Line 1 quantity: 1',
  'Line 1 unit price: 600',
  'Line 1 total: 600',
  'Line 2 description: Milestone two',
  'Line 2 quantity: 1',
  'Line 2 unit price: 600',
  'Line 2 total: 600',
].join('\n');

const INVOICE_A_CONTINUATION = [
  'CONTINUATION OF INVOICE SYN-A-2026',
  'Currency: USD',
  'Total due: 1200',
].join('\n');

const CONTRACT_PAGE = [
  'SERVICE CONTRACT 72',
  'Agreement between Demo Company and Synthetic Alpha.',
  'Effective 2026-01-01. Terms and obligations only.',
  'This contract does not request any payment.',
].join('\n');

const INVOICE_B_PAGE_1 = INVOICE_A_PAGE_1
  .replace('SYN-A-2026', 'SYN-B-2026')
  .replace('Synthetic Alpha', 'Synthetic Beta')
  .replace('SYN-TAX-A', 'SYN-TAX-B')
  .replace('SYN-ACCOUNT-A', 'SYN-ACCOUNT-B')
  .replace('SYN-CONTRACT-A', 'SYN-CONTRACT-B');

const INVOICE_B_CONTINUATION = INVOICE_A_CONTINUATION.replace(/SYN-A-2026/g, 'SYN-B-2026');

const source: DocumentSource = {
  tenantId: 'tenant-a',
  sourceId: 'src-1',
  sourceHashSha256: SHA_A,
  storageKey: 'sources/src-1',
  channel: 'CHAT',
  mimeType: 'text/plain',
  byteLength: 1024,
  receivedAt: '2026-10-18T00:00:00Z',
};

function parsedOf(texts: string[]): ParsedDocument {
  return {
    pages: texts.map((text, index) => ({
      page: index + 1,
      text,
      artifact: {
        artifactId: `artifact-${index + 1}`,
        kind: 'PARSED_TEXT' as const,
        sha256: 'c'.repeat(64),
        storageKey: `parsed/${index + 1}`,
      },
    })),
    assurance: 'NATIVE_TEXT',
    parser: { provider: 'DIRECT_TEXT', version: 'utf8-v1' },
    raw: null,
  };
}

function extractorFor(classification: SegmentClassificationSource) {
  return new SegmentedLabelledTextExtractor({ classification });
}

function classify(texts: string[], segments: Array<{ category: string; pages: number[]; needsReview?: boolean }>) {
  const packet = packetFor(segments);
  const byHash = new StaticSegmentClassificationSource([{ sourceHashSha256: source.sourceHashSha256, packet }]);
  return extractorFor(byHash).extract({ source, bytes: new Uint8Array(), parsed: parsedOf(texts) });
}

describe('segmented extraction over DocJev-verified packets', () => {
  it('extracts only invoice segments from a mixed packet with original-page citations', async () => {
    const result = await classify(
      [INVOICE_A_PAGE_1, CONTRACT_PAGE, INVOICE_B_PAGE_1],
      [
        { category: 'invoice', pages: [1] },
        { category: 'contract', pages: [2] },
        { category: 'invoice', pages: [3] },
      ]
    );
    expect(result.drafts).toHaveLength(2);

    const [first, second] = result.drafts;
    expect(first!.segment).toMatchObject({ segmentId: 'segment-001', startPage: 1, endPage: 1, category: 'INVOICE', classifiedBy: 'DOCJEV' });
    expect(second!.segment).toMatchObject({ segmentId: 'segment-003', startPage: 3, endPage: 3 });
    expect(first!.invoice.invoice.number).toMatchObject({ state: 'OBSERVED', value: 'SYN-A-2026' });
    expect(second!.invoice.invoice.number).toMatchObject({ state: 'OBSERVED', value: 'SYN-B-2026' });
    expect(first!.evidence.every(item => item.segmentId === 'segment-001')).toBe(true);
    expect(second!.evidence.every(item => item.segmentId === 'segment-003')).toBe(true);
    // Citations still point at the ORIGINAL page artifacts.
    expect(first!.evidence.every(item => item.locator.kind === 'TEXT_SPAN' && item.locator.artifactId === 'artifact-1')).toBe(true);
    expect(second!.evidence.every(item => item.locator.kind === 'TEXT_SPAN' && item.locator.artifactId === 'artifact-3')).toBe(true);
  });

  it('merges continuation pages into one invoice with complete line items and merged evidence', async () => {
    const result = await classify(
      [INVOICE_A_PAGE_1, INVOICE_A_CONTINUATION, INVOICE_B_PAGE_1, INVOICE_B_CONTINUATION],
      [
        { category: 'invoice', pages: [1, 2] },
        { category: 'invoice', pages: [3, 4] },
      ]
    );
    expect(result.drafts).toHaveLength(2);

    const [invoiceA] = result.drafts;
    expect(invoiceA!.segment).toMatchObject({ startPage: 1, endPage: 2, classifiedBy: 'DOCJEV' });
    expect(invoiceA!.invoice.commercial.lineItems).toHaveLength(2);
    expect(invoiceA!.invoice.commercial.lineItemsCompleteness).toBe('COMPLETE');
    expect(invoiceA!.invoice.commercial.lineItems.map(item => item.lineNumber)).toEqual([1, 2]);

    // The restated total carries amount AND currency citations from BOTH pages.
    const totalDue = invoiceA!.invoice.financials.totalDue;
    expect(totalDue.state).toBe('OBSERVED');
    if (totalDue.state === 'OBSERVED') {
      expect(totalDue.evidenceIds).toHaveLength(4);
      const cited = invoiceA!.evidence.filter(item => totalDue.evidenceIds.includes(item.evidenceId));
      const artifacts = cited.map(item => (item.locator.kind === 'TEXT_SPAN' ? item.locator.artifactId : null));
      expect(artifacts).toEqual(expect.arrayContaining(['artifact-1', 'artifact-2']));
    }
  });

  it('fails closed on contradictory restatements across continuation pages', async () => {
    const contradictory = INVOICE_A_CONTINUATION.replace('Total due: 1200', 'Total due: 999');
    const result = await classify(
      [INVOICE_A_PAGE_1, contradictory],
      [{ category: 'invoice', pages: [1, 2] }]
    );
    const [draft] = result.drafts;
    expect(draft!.invoice.financials.totalDue.state).toBe('CONFLICTING');
    if (draft!.invoice.financials.totalDue.state === 'CONFLICTING') {
      expect(draft!.invoice.financials.totalDue.candidates).toHaveLength(2);
    }
  });

  it('rejects line-item numbering gaps within a segment page', async () => {
    // A continuation page numbering items locally as 2 (not 1..K) fails the
    // per-page boundary check inside the base extractor.
    const gapped = INVOICE_A_CONTINUATION + '\nLine 2 description: Milestone two\nLine 2 total: 600';
    await expect(
      classify([INVOICE_A_PAGE_1, gapped], [{ category: 'invoice', pages: [1, 2] }])
    ).rejects.toThrow('UNCERTAIN_LINE_ITEM_BOUNDARIES');
  });

  it('fails closed to review when line items appear on multiple pages of one segment', async () => {
    // Page-local numbering cannot tell continuation items from restatements
    // across pages: the segment must go to review instead of guessing.
    const restated = INVOICE_A_CONTINUATION + '\n' + [
      'Line 1 description: Milestone one',
      'Line 1 quantity: 1',
      'Line 1 unit price: 600',
      'Line 1 total: 600',
    ].join('\n');
    const result = await classify(
      [INVOICE_A_PAGE_1, restated],
      [{ category: 'invoice', pages: [1, 2] }]
    );
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.issues).toContain('UNCERTAIN_LINE_ITEM_BOUNDARIES');
    expect(result.drafts[0]!.invoice.commercial.lineItems).toHaveLength(0);
    expect(result.drafts[0]!.invoice.commercial.lineItemsCompleteness).toBe('UNKNOWN');
  });

  it('flags review-required invoice segments so the verifier can never mark them ready', async () => {
    const result = await classify(
      [INVOICE_A_PAGE_1, CONTRACT_PAGE],
      [
        { category: 'invoice', pages: [1], needsReview: true },
        { category: 'contract', pages: [2] },
      ]
    );
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.issues).toContain('DOCJEV_REVIEW_REQUIRED');
  });

  it('keeps the conservative fail-closed base path when no classification exists', async () => {
    const extractor = extractorFor(new StaticSegmentClassificationSource([]));
    // Unlabelled multi-page content without a verified classification must
    // still fail exactly as the base extractor does.
    await expect(
      extractor.extract({ source, bytes: new Uint8Array(), parsed: parsedOf(['page one text', 'page two text']) })
    ).rejects.toThrow('UNCERTAIN_PACKET_BOUNDARIES');
  });

  it('rejects a classification that disagrees with the parsed page count', async () => {
    const packet = packetFor([{ category: 'invoice', pages: [1, 2, 3] }]);
    const extractor = extractorFor(new StaticSegmentClassificationSource([{ sourceHashSha256: source.sourceHashSha256, packet }]));
    await expect(
      extractor.extract({ source, bytes: new Uint8Array(), parsed: parsedOf(['a', 'b']) })
    ).rejects.toThrow(L1Error);
  });
});
