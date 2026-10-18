import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClassificationError,
  classifyDocumentPacket,
  invokeDocJevSplit,
  validateSplitResult,
  type ClassifiedPacket,
} from '../src/index.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function validSplit(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema_version: '1',
    task: 'split',
    segments: [
      { id: 'segment-001', category: 'invoice', pages: [1, 2], needs_review: false, review_reasons: [] },
      { id: 'segment-002', category: 'invoice', pages: [3, 4], needs_review: false, review_reasons: [] },
    ],
    warnings: [],
    document: {
      schema_version: '1',
      source_name: 'synthetic.pdf',
      source_sha256: SHA_A,
      canonical_path: '/tmp/synthetic.pdf',
      canonical_sha256: SHA_B,
      page_count: 4,
    },
    engine: 'jev',
    model: 'jev-1.14',
    metrics: { decision_ms: 291.023, decision_cost_usd: 5.4558e-05, requests: [] },
    ...overrides,
  };
}

/** Writes a stand-in "python" shell script that ignores CLI args and runs the given behavior. */
function standinInterpreter(behavior: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'praeco-bridge-'));
  const script = join(dir, 'standin-python.sh');
  writeFileSync(script, `#!/bin/sh\n${behavior}\n`, 'utf8');
  chmodSync(script, 0o755);
  return script;
}

const VALID_THREE_PAGE_JSON = JSON.stringify(
  validSplit({
    segments: [
      { id: 'segment-001', category: 'invoice', pages: [1, 2], needs_review: false, review_reasons: [] },
      { id: 'segment-002', category: 'contract', pages: [3], needs_review: false, review_reasons: [] },
    ],
    document: { page_count: 3, source_sha256: SHA_A, canonical_sha256: SHA_B },
  })
);

describe('typed validation of DocJev split results', () => {
  it('returns a typed packet with provenance and review flags for a valid result', () => {
    const packet = validateSplitResult(validSplit(), { expectedPageCount: 4 });
    expect(packet.pageCount).toBe(4);
    expect(packet.sourceSha256).toBe(SHA_A);
    expect(packet.canonicalSha256).toBe(SHA_B);
    expect(packet.reviewRequired).toBe(false);
    expect(packet.segments.map(s => s.category)).toEqual(['invoice', 'invoice']);
    expect(packet.segments[0]!.pages).toEqual([1, 2]);
    // Provider probabilities never reach the typed output.
    expect(JSON.stringify(packet)).not.toContain('probability');
    expect(packet.decisionCostUsd).toBeCloseTo(5.4558e-05, 10);
  });

  it('marks the packet review-only when a segment needs review, uses other, or warnings exist', () => {
    const flagged = validateSplitResult(
      validSplit({
        segments: [
          { id: 'segment-001', category: 'invoice', pages: [1], needs_review: true, review_reasons: [{ code: 'boundary_near_threshold', page: 1 }] },
          { id: 'segment-002', category: 'other', pages: [2], needs_review: false, review_reasons: [{ code: 'other_category', page: 2 }] },
          { id: 'segment-003', category: 'invoice', pages: [3, 4], needs_review: false, review_reasons: [] },
        ],
      }),
      { expectedPageCount: 4 }
    );
    expect(flagged.reviewRequired).toBe(true);
    expect(flagged.segments[0]!.needsReview).toBe(true);
    expect(flagged.segments[0]!.reviewReasonCodes).toEqual(['boundary_near_threshold']);
    expect(flagged.segments[1]!.needsReview).toBe(true);

    const warned = validateSplitResult(
      validSplit({ warnings: ['Page 3: category change overrode a continuation decision.'] }),
      { expectedPageCount: 4 }
    );
    expect(warned.reviewRequired).toBe(true);
  });

  it('fails closed on coverage gaps, overlaps and out-of-range pages', () => {
    const cases: unknown[] = [
      validSplit({
        segments: [
          { id: 's1', category: 'invoice', pages: [1], needs_review: false, review_reasons: [] },
          { id: 's2', category: 'invoice', pages: [3, 4], needs_review: false, review_reasons: [] },
        ],
      }),
      validSplit({
        segments: [
          { id: 's1', category: 'invoice', pages: [1, 2], needs_review: false, review_reasons: [] },
          { id: 's2', category: 'invoice', pages: [2, 3, 4], needs_review: false, review_reasons: [] },
        ],
      }),
      validSplit({
        segments: [
          { id: 's1', category: 'invoice', pages: [1, 2], needs_review: false, review_reasons: [] },
          { id: 's2', category: 'invoice', pages: [3, 5], needs_review: false, review_reasons: [] },
        ],
      }),
    ];
    for (const raw of cases) {
      expect(() => validateSplitResult(raw, { expectedPageCount: 4 })).toThrow(ClassificationError);
      expect(() => validateSplitResult(raw, { expectedPageCount: 4 })).toThrow('COVERAGE_INVALID');
    }
  });

  it('fails closed on unknown categories, schema drift, page-count mismatch and source mismatch', () => {
    expect(() =>
      validateSplitResult(
        validSplit({
          segments: [
            { id: 's1', category: 'pay_now', pages: [1, 2], needs_review: false, review_reasons: [] },
            { id: 's2', category: 'invoice', pages: [3, 4], needs_review: false, review_reasons: [] },
          ],
        }),
        { expectedPageCount: 4 }
      )
    ).toThrow('UNKNOWN_CATEGORY');

    expect(() => validateSplitResult(validSplit({ task: 'classify' }), { expectedPageCount: 4 })).toThrow('SCHEMA_INVALID');
    expect(() =>
      validateSplitResult(validSplit({ document: { page_count: 4, source_sha256: 'not-a-hash', canonical_sha256: SHA_B } }), {
        expectedPageCount: 4,
      })
    ).toThrow('SCHEMA_INVALID');

    expect(() => validateSplitResult(validSplit(), { expectedPageCount: 5 })).toThrow('PAGE_COUNT_MISMATCH');
    expect(() => validateSplitResult(validSplit(), { expectedPageCount: 4, expectedSourceSha256: SHA_B })).toThrow(
      'SOURCE_HASH_MISMATCH'
    );
  });

  it('tolerates null provider cost metrics and normalizes them to null', () => {
    const packet = validateSplitResult(validSplit({ metrics: { decision_ms: null, decision_cost_usd: null } }), {
      expectedPageCount: 4,
    });
    expect(packet.decisionMs).toBeNull();
    expect(packet.decisionCostUsd).toBeNull();
  });
});

// Let the bridge enforce its 15s process deadline before the test runner aborts.
// The explicit 200ms cancellation case below keeps the runtime bound verified.
describe('bounded DocJev process bridge (scripted stand-ins, offline)', { timeout: 20_000 }, () => {
  const base = { documentPath: 'x.pdf', rulesPath: 'r.yaml' };

  it('maps valid JSON from the bridge into a typed packet via classifyDocumentPacket', async () => {
    const packet: ClassifiedPacket = await classifyDocumentPacket({
      ...base,
      pythonCommand: standinInterpreter("printf '%s' '" + VALID_THREE_PAGE_JSON + "'"),
      model: 'jev-1.14',
      timeoutMs: 15_000,
      expectedPageCount: 3,
      expectedSourceSha256: SHA_A,
    });
    expect(packet.segments.map(s => s.category)).toEqual(['invoice', 'contract']);
    expect(packet.reviewRequired).toBe(false);
    expect(packet.sourceSha256).toBe(SHA_A);
  });

  it('maps non-JSON output to INVALID_JSON', async () => {
    await expect(
      invokeDocJevSplit({ ...base, pythonCommand: standinInterpreter('echo not-json'), timeoutMs: 15_000 })
    ).rejects.toThrow('INVALID_JSON');
  });

  it('maps nonzero exits to sanitized DOCJEV_EXECUTION_FAILED', async () => {
    await expect(
      invokeDocJevSplit({ ...base, pythonCommand: standinInterpreter('exit 3'), timeoutMs: 15_000 })
    ).rejects.toThrow('DOCJEV_EXECUTION_FAILED');
  });

  it('kills long-running processes with DOCJEV_TIMEOUT', async () => {
    const started = Date.now();
    await expect(
      invokeDocJevSplit({ ...base, pythonCommand: standinInterpreter('sleep 30'), timeoutMs: 200 })
    ).rejects.toThrow('DOCJEV_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('caps oversized output with OUTPUT_TOO_LARGE', async () => {
    await expect(
      invokeDocJevSplit({
        ...base,
        pythonCommand: standinInterpreter('yes x | head -c 6291456'),
        timeoutMs: 15_000,
        maxOutputBytes: 1024 * 1024,
      })
    ).rejects.toThrow('OUTPUT_TOO_LARGE');
  });

  it('reports spawn failures as DOCJEV_EXECUTION_FAILED without crashing', async () => {
    await expect(
      invokeDocJevSplit({ ...base, pythonCommand: '/nonexistent/interpreter', timeoutMs: 15_000 })
    ).rejects.toThrow('DOCJEV_EXECUTION_FAILED');
  });
});
