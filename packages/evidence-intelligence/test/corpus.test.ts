import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { setup } from './helpers.js';

const root = new URL('./fixtures/corpus/', import.meta.url);
const Manifest = z.object({ mode: z.literal('offline-labelled-adapter'), cases: z.array(z.object({
  id: z.string(), file: z.string(), channel: z.enum(['PDF', 'IMAGE', 'EMAIL', 'CHAT']), mimeType: z.string(), category: z.string(),
  expectedStatuses: z.array(z.string()), expectedUsd: z.array(z.string().nullable()), annotation: z.string(),
})).length(30) });
const manifest = Manifest.parse(JSON.parse(await readFile(new URL('ground-truth.json', root), 'utf8')));

describe('30 distinct synthetic documents: offline evidence acceptance', () => {
  it.each(manifest.cases)('$id ($category)', async fixture => {
    const { runtime } = await setup();
    // Only bytes, tenant, channel and MIME enter runtime. Expectations, labels and filenames do not.
    const source = await runtime.register({ tenantId: 'synthetic-corpus', bytes: await readFile(new URL(fixture.file, root)), channel: fixture.channel, mimeType: fixture.mimeType });
    const envelopes = await runtime.process(source);
    expect(envelopes.map(e => e.processingStatus)).toEqual(fixture.expectedStatuses);
    expect(envelopes.map(e => e.normalization?.usdEquivalent?.amount ?? null)).toEqual(fixture.expectedUsd);
    for (const envelope of envelopes) {
      if (envelope.processingStatus === 'READY_FOR_POLICY_EVALUATION') {
        const loaded = await runtime.reader.loadReady(source.tenantId, envelope.envelopeId);
        expect(loaded.envelope.verification.status).toBe('ACCEPTED');
        expect(loaded.envelope.verification.checks.every(c => c.status === 'PASS' || c.severity === 'INFO')).toBe(true);
      } else await expect(runtime.reader.loadReady(source.tenantId, envelope.envelopeId)).rejects.toThrow('ENVELOPE_NOT_READY');
      if (envelope.segment) {
        expect(envelope.evidence.every(e => e.segmentId === envelope.segment?.segmentId)).toBe(true);
        expect(envelope.segment.startPage).toBe(envelope.segment.endPage);
      }
    }
  }, 30_000);
});
