import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { setup } from './helpers.js';
import type { InvoiceEnvelope } from '../src/contracts.js';

const root = new URL('./fixtures/demo-day/', import.meta.url);
// Test-only oracle. Runtime receives raw input bytes and trusted FX configuration, never this object.
const Expected = z.object({ fxFixtures: z.array(z.object({ rateId: z.string(), baseCurrency: z.literal('USD'), quoteCurrency: z.string(), quotePerBase: z.string(),
  effectiveAt: z.string(), source: z.literal('HACKATHON_FIXED'), rounding: z.literal('HALF_EVEN'), outputScale: z.literal(2) })),
  scenarios: z.array(z.object({ id: z.string(), l1GroundTruth: z.object({ invoiceNumber: z.string(), totalDue: z.object({ amount: z.string(), currency: z.string() }),
    expectedUsdEquivalent: z.object({ amount: z.string(), currency: z.string() }), fxRateId: z.string().nullable(), expectedProcessingStatus: z.string() }),
    l3PayableCase: z.object({ sourceIds: z.array(z.string()) }), l2EvaluationSnapshot: z.unknown(), expectedL2: z.unknown() })).length(8) });
const expected = Expected.parse(JSON.parse(await readFile(new URL('original-manifest.json', root), 'utf8')));
const inputs = z.object({ sources: z.array(z.object({ scenarioId: z.string(), sourceAlias: z.string(), file: z.string(), channel: z.enum(['PDF', 'EMAIL', 'CHAT']), mimeType: z.string(), purpose: z.enum(['PRIMARY_INVOICE', 'SUPPLEMENTAL_CONTEXT']) })) })
  .parse(JSON.parse(await readFile(new URL('sources/index.json', root), 'utf8')));

describe('original eight scenarios: L1 facts only, L2 decisions pending', () => {
  it.each(expected.scenarios)('$id extraction and source separation', async scenario => {
    const { runtime } = await setup({ rates: expected.fxFixtures });
    const selected = inputs.sources.filter(s => s.scenarioId === scenario.id);
    expect(selected.map(s => s.sourceAlias).sort()).toEqual([...scenario.l3PayableCase.sourceIds].sort());
    const envelopes: InvoiceEnvelope[] = [], sourceIds: string[] = [], hashes: string[] = [];
    for (const input of selected) {
      const source = await runtime.register({ tenantId: 'synthetic-demo', bytes: await readFile(new URL(`sources/${input.file}`, root)), channel: input.channel, mimeType: input.mimeType,
        ...(input.channel === 'PDF' ? {} : { originMessageId: input.sourceAlias }) });
      sourceIds.push(source.sourceId); hashes.push(source.sourceHashSha256);
      const result = await runtime.process(source);
      if (input.purpose === 'SUPPLEMENTAL_CONTEXT') expect(result).toEqual([]);
      else envelopes.push(...result);
    }
    expect(new Set(sourceIds).size).toBe(selected.length); expect(new Set(hashes).size).toBe(selected.length);
    expect(envelopes).toHaveLength(1);
    const envelope = envelopes[0]!;
    expect(envelope.processingStatus).toBe(scenario.l1GroundTruth.expectedProcessingStatus);
    expect(envelope.invoice?.invoice.number).toMatchObject({ state: 'OBSERVED', value: scenario.l1GroundTruth.invoiceNumber });
    expect(envelope.invoice?.financials.totalDue).toMatchObject({ state: 'OBSERVED', value: scenario.l1GroundTruth.totalDue });
    expect(envelope.normalization?.usdEquivalent).toEqual(scenario.l1GroundTruth.expectedUsdEquivalent);
    expect(envelope.normalization?.fx?.rateId ?? null).toBe(scenario.l1GroundTruth.fxRateId);
    expect(envelope.evidence.every(e => e.sourceId === envelope.source.sourceId && e.sourceHashSha256 === envelope.source.sourceHashSha256)).toBe(true);
    const replay = await runtime.replay(envelope.source.tenantId, envelope.envelopeId);
    expect(replay.normalization).toEqual(envelope.normalization);
    expect(replay.verification?.checks).toEqual(envelope.verification?.checks);
    expect('outcome' in envelope).toBe(false);
  }, 30_000);
});
