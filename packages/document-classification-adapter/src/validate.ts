import { ClassificationError } from './errors.js';
import { PACKET_CATEGORIES, splitResultSchema, type PacketCategory } from './contract.js';

export interface ValidateSplitOptions {
  /** Page count of the packet the provider was invoked on. */
  expectedPageCount: number;
  /** SHA-256 of the registered original source, when the caller holds it. */
  expectedSourceSha256?: string;
}

export interface ClassifiedSegment {
  segmentId: string;
  category: PacketCategory;
  /** Original page numbers in the source packet, contiguous ascending. */
  pages: readonly number[];
  /** Review-only: never finance-ready downstream. */
  needsReview: boolean;
  reviewReasonCodes: readonly string[];
}

export interface ClassifiedPacket {
  sourceSha256: string;
  canonicalSha256: string;
  pageCount: number;
  segments: readonly ClassifiedSegment[];
  warnings: readonly string[];
  /** True when any segment needs review, uses the 'other' category, or DocJev raised warnings. */
  reviewRequired: boolean;
  engine: string;
  model: string;
  decisionMs: number | null;
  decisionCostUsd: number | null;
}

/**
 * Validates a raw DocJev split result into a typed, provenance-preserving
 * packet decision. Fail-closed: any schema drift, page-coverage gap, overlap,
 * duplication, unknown category, or source mismatch throws ClassificationError.
 *
 * Provider category probabilities are deliberately NOT surfaced: they are not
 * calibrated evidence confidence and must never influence L1 readiness or L2
 * authorization.
 */
export function validateSplitResult(raw: unknown, options: ValidateSplitOptions): ClassifiedPacket {
  const parsed = splitResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ClassificationError('SCHEMA_INVALID', 'provider output does not match the pinned DocJev split contract');
  }
  const result = parsed.data;

  if (result.document.page_count !== options.expectedPageCount) {
    throw new ClassificationError(
      'PAGE_COUNT_MISMATCH',
      `provider reported ${result.document.page_count} pages, caller expected ${options.expectedPageCount}`
    );
  }

  if (options.expectedSourceSha256 && result.document.source_sha256 !== options.expectedSourceSha256) {
    throw new ClassificationError('SOURCE_HASH_MISMATCH', 'classified result does not correspond to the provided source');
  }

  const knownCategories: readonly string[] = PACKET_CATEGORIES;
  const assigned = new Set<number>();
  let reviewRequired = result.warnings.length > 0;

  const segments: ClassifiedSegment[] = result.segments.map(segment => {
    if (!knownCategories.includes(segment.category)) {
      throw new ClassificationError('UNKNOWN_CATEGORY', `segment ${segment.id} carries an unrecognized category`);
    }
    const pages = [...segment.pages].sort((a, b) => a - b);
    for (let i = 1; i < pages.length; i++) {
      if (pages[i] !== pages[i - 1]! + 1) {
        throw new ClassificationError('COVERAGE_INVALID', `segment ${segment.id} pages are not contiguous`);
      }
    }
    for (const page of pages) {
      if (page < 1 || page > options.expectedPageCount) {
        throw new ClassificationError('COVERAGE_INVALID', `segment ${segment.id} references page ${page} outside the packet`);
      }
      if (assigned.has(page)) {
        throw new ClassificationError('COVERAGE_INVALID', `page ${page} belongs to more than one segment`);
      }
      assigned.add(page);
    }
    const needsReview = segment.needs_review || segment.category === 'other';
    if (needsReview) {
      reviewRequired = true;
    }
    return {
      segmentId: segment.id,
      category: segment.category as PacketCategory,
      pages,
      needsReview,
      reviewReasonCodes: segment.review_reasons.map(reason => reason.code),
    };
  });

  for (let page = 1; page <= options.expectedPageCount; page++) {
    if (!assigned.has(page)) {
      throw new ClassificationError('COVERAGE_INVALID', `page ${page} does not belong to any segment`);
    }
  }

  return {
    sourceSha256: result.document.source_sha256,
    canonicalSha256: result.document.canonical_sha256,
    pageCount: result.document.page_count,
    segments,
    warnings: result.warnings,
    reviewRequired,
    engine: result.engine,
    model: result.model,
    decisionMs: result.metrics.decision_ms ?? null,
    decisionCostUsd: result.metrics.decision_cost_usd ?? null,
  };
}
