import {
  LabelledTextExtractor,
  L1Error,
  type Candidate,
  type DocumentSegment,
  type DocumentSource,
  type ExtractionDraft,
  type ExtractionPort,
  type ExtractionResult,
  type InvoiceLineItem,
  type InvoicePayload,
  type ObservedField,
  type ParsedDocument,
} from '@praeco/evidence-intelligence';
import type { PacketCategory } from './contract.js';
import type { ClassifiedPacket } from './validate.js';

/** Packet category mapped onto the frozen L1 DocumentSegment category vocabulary. */
export const CATEGORY_TO_DOCUMENT_SEGMENT: Readonly<Record<PacketCategory, DocumentSegment['category']>> = Object.freeze({
  invoice: 'INVOICE',
  contract: 'CONTRACT',
  supplemental_context: 'OTHER',
  other: 'UNKNOWN',
});

export interface SegmentClassificationInput {
  source: DocumentSource;
  bytes: Uint8Array;
  parsed: ParsedDocument;
}

/**
 * Port that supplies the verified packet classification for a source, or
 * null when no classification is available (in which case the extractor
 * delegates to the base single-document behavior and unknown packet
 * boundaries keep failing closed exactly as before).
 */
export interface SegmentClassificationSource {
  classify(input: SegmentClassificationInput): Promise<ClassifiedPacket | null>;
}

/** Deterministic offline source for tests and demos: content-addressed by source hash. */
export class StaticSegmentClassificationSource implements SegmentClassificationSource {
  private readonly bySourceHash = new Map<string, ClassifiedPacket>();

  public constructor(packets: ReadonlyArray<{ sourceHashSha256: string; packet: ClassifiedPacket }>) {
    for (const entry of packets) {
      this.bySourceHash.set(entry.sourceHashSha256, entry.packet);
    }
  }

  public async classify(input: SegmentClassificationInput): Promise<ClassifiedPacket | null> {
    return this.bySourceHash.get(input.source.sourceHashSha256) ?? null;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function candidatesOf<T>(field: ObservedField<T>): readonly Candidate<T>[] {
  if (field.state === 'OBSERVED') return [{ value: field.value, evidenceIds: field.evidenceIds }];
  if (field.state === 'MISSING') return [];
  return field.candidates;
}

function mergeTwo<T>(a: ObservedField<T>, b: ObservedField<T>): ObservedField<T> {
  if (a.state === 'MISSING') return b;
  if (b.state === 'MISSING') return a;
  if (a.state === 'OBSERVED' && b.state === 'OBSERVED') {
    if (sameValue(a.value, b.value)) {
      return { state: 'OBSERVED', value: a.value, evidenceIds: [...a.evidenceIds, ...b.evidenceIds] };
    }
    return {
      state: 'CONFLICTING',
      value: null,
      candidates: [
        { value: a.value, evidenceIds: a.evidenceIds },
        { value: b.value, evidenceIds: b.evidenceIds },
      ],
    };
  }
  // Any AMBIGUOUS/CONFLICTING involvement widens to CONFLICTING with all candidates.
  const candidates = [...candidatesOf(a), ...candidatesOf(b)];
  if (candidates.length === 0) {
    // Unreachable in practice: both sides would have to be MISSING, which is
    // handled above. Fail closed defensively anyway.
    return { state: 'CONFLICTING', value: null, candidates: [{ value: null as never, evidenceIds: [] }] };
  }
  return { state: 'CONFLICTING', value: null, candidates: [candidates[0]!, ...candidates.slice(1)] };
}

function mergeFields<T>(fields: readonly ObservedField<T>[]): ObservedField<T> {
  return fields.reduce((acc, field) => mergeTwo(acc, field));
}

function mergeInvoicePayloads(invoices: readonly InvoicePayload[]): InvoicePayload {
  const merged = (pick: (invoice: InvoicePayload) => ObservedField<unknown>) =>
    mergeFields(invoices.map(pick) as readonly ObservedField<unknown>[]) as never;

  const documentType: InvoicePayload['documentType'] = invoices.some(i => i.documentType === 'CUENTA_DE_COBRO')
    ? 'CUENTA_DE_COBRO'
    : 'INVOICE';

  return {
    documentType,
    invoice: {
      number: merged(i => i.invoice.number),
      issueDate: merged(i => i.invoice.issueDate),
      dueDate: merged(i => i.invoice.dueDate),
      billingPeriod: merged(i => i.invoice.billingPeriod),
    },
    beneficiary: {
      legalName: merged(i => i.beneficiary.legalName),
      taxId: merged(i => i.beneficiary.taxId),
      paymentAccount: merged(i => i.beneficiary.paymentAccount),
    },
    commercial: {
      contractReference: merged(i => i.commercial.contractReference),
      purchaseOrderReference: merged(i => i.commercial.purchaseOrderReference),
      conceptSummary: merged(i => i.commercial.conceptSummary),
      lineItems: [],
      lineItemsCompleteness: 'NOT_PRESENT',
    },
    financials: {
      currency: merged(i => i.financials.currency),
      subtotal: merged(i => i.financials.subtotal),
      taxes: merged(i => i.financials.taxes),
      discounts: merged(i => i.financials.discounts),
      totalDue: merged(i => i.financials.totalDue),
      amountAlreadyPaid: merged(i => i.financials.amountAlreadyPaid),
      outstandingBalance: merged(i => i.financials.outstandingBalance),
    },
  };
}

function mergeLineItems(
  invoices: readonly InvoicePayload[],
  issues: Set<string>
): { items: InvoiceLineItem[]; completeness: InvoicePayload['commercial']['lineItemsCompleteness'] } {
  const populated = invoices.filter(invoice => invoice.commercial.lineItems.length > 0);
  if (populated.length === 0) return { items: [], completeness: 'NOT_PRESENT' };
  if (populated.length > 1) {
    // Page-local numbering cannot disambiguate continuation items from
    // restatements across pages: never guess, fail closed to review.
    issues.add('UNCERTAIN_LINE_ITEM_BOUNDARIES');
    return { items: [], completeness: 'UNKNOWN' };
  }
  // A single page carries the items; the base extractor already validated
  // its local 1..K numbering and built the citations.
  const items = populated[0]!.commercial.lineItems.map(item => ({
    lineNumber: item.lineNumber,
    description: mergeFields([item.description]),
    quantity: mergeFields([item.quantity]),
    unitPrice: mergeFields([item.unitPrice]),
    lineTotal: mergeFields([item.lineTotal]),
  }));
  const completeness = items.every(item =>
    [item.description, item.quantity, item.unitPrice, item.lineTotal].every(field => field.state === 'OBSERVED')
  )
    ? 'COMPLETE'
    : 'PARTIAL';
  return { items, completeness };
}

export interface SegmentedExtractorOptions {
  /** Supplies verified packet segments; null delegates to the base extractor. */
  classification: SegmentClassificationSource;
  /** Single-invoice extractor applied per page; defaults to the labelled-text extractor. */
  base?: ExtractionPort;
}

/**
 * ExtractionPort that groups parsed pages into DocJev-verified segments before
 * extraction. Only invoice-category segments become extraction candidates;
 * contracts and supplemental context stay context (no invoice draft). A
 * review-flagged invoice segment still produces a draft, but it carries the
 * DOCJEV_REVIEW_REQUIRED issue so the verifier can never mark it READY.
 * Citations keep the original page numbers and artifacts of every page in
 * the segment, so continuation pages merge without renumbering evidence.
 *
 * This adapter never changes L1 readiness semantics: it only proposes how
 * pages group into candidate invoices, and every uncertain case fails closed.
 */
export class SegmentedLabelledTextExtractor implements ExtractionPort {
  public readonly provider = 'DOCJEV_SEGMENTED_LABELLED_TEXT';
  public readonly version = '1.0.0';
  public readonly configuration: Readonly<Record<string, unknown>>;
  private readonly classification: SegmentClassificationSource;
  private readonly base: ExtractionPort;

  public constructor(options: SegmentedExtractorOptions) {
    this.classification = options.classification;
    this.base = options.base ?? new LabelledTextExtractor();
    this.configuration = Object.freeze({
      base: this.base.provider,
      categoryMap: 'docjev-v1',
      reviewPolicy: 'segment-review-required-issue-v1',
    });
  }

  public async extract(input: {
    source: DocumentSource;
    bytes: Uint8Array;
    parsed: ParsedDocument;
  }): Promise<ExtractionResult> {
    const packet = await this.classification.classify({
      source: input.source,
      bytes: input.bytes,
      parsed: input.parsed,
    });
    if (!packet) {
      // No verified classification: keep the conservative base behavior, so
      // unrecognized multi-page packets still fail closed.
      return this.base.extract(input);
    }
    if (packet.pageCount !== input.parsed.pages.length) {
      throw new L1Error('UNCERTAIN_PACKET_BOUNDARIES', 'CLASSIFY');
    }

    const drafts: ExtractionDraft[] = [];
    for (const segment of packet.segments) {
      if (segment.category !== 'invoice') {
        // Contracts, supplemental context and unknown pages never become
        // invoice candidates; they remain context attached to the source.
        continue;
      }
      const startPage = segment.pages[0]!;
      const endPage = segment.pages[segment.pages.length - 1]!;
      const documentSegment: DocumentSegment = {
        segmentId: segment.segmentId,
        sourceId: input.source.sourceId,
        startPage,
        endPage,
        category: CATEGORY_TO_DOCUMENT_SEGMENT.invoice,
        classifiedBy: 'DOCJEV',
      };

      const pages = input.parsed.pages.filter(page => page.page >= startPage && page.page <= endPage);
      const pageDrafts: ExtractionDraft[] = [];
      for (const page of pages) {
        const perPage = await this.base.extract({
          source: input.source,
          bytes: input.bytes,
          parsed: { ...input.parsed, pages: [page], raw: null },
        });
        pageDrafts.push(...perPage.drafts);
      }

      const invoices = pageDrafts.map(draft => draft.invoice);
      const invoice = mergeInvoicePayloads(invoices);
      const issues = new Set<string>();
      for (const draft of pageDrafts) {
        for (const issue of draft.issues ?? []) issues.add(issue);
      }
      const { items, completeness } = mergeLineItems(invoices, issues);
      invoice.commercial.lineItems = items;
      invoice.commercial.lineItemsCompleteness = completeness;
      if (completeness === 'PARTIAL') issues.add('LINE_ITEMS_PARTIAL');
      if (segment.needsReview || packet.reviewRequired) issues.add('DOCJEV_REVIEW_REQUIRED');

      const evidence = [
        ...new Map(pageDrafts.flatMap(draft => draft.evidence).map(item => [item.evidenceId, item])).values(),
      ].map(item => ({ ...item, segmentId: documentSegment.segmentId }));

      drafts.push({ invoice, evidence, segment: documentSegment, issues: [...issues] });
    }

    return {
      drafts,
      raw: {
        adapter: this.provider,
        classification: {
          sourceSha256: packet.sourceSha256,
          reviewRequired: packet.reviewRequired,
          segments: packet.segments.map(segment => ({
            segmentId: segment.segmentId,
            category: segment.category,
            pages: segment.pages,
            needsReview: segment.needsReview,
          })),
        },
      },
    };
  }
}
