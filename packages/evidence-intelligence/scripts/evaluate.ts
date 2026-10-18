import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createL1 } from '../src/service.js';
const root = new URL('../test/fixtures/corpus/', import.meta.url);
const manifest = z.object({ annotationStatus: z.string(), cases: z.array(z.object({ file: z.string(),
  channel: z.enum(['PDF', 'IMAGE', 'EMAIL', 'CHAT']), mimeType: z.string(), expectedStatuses: z.array(z.string()), expectedUsd: z.array(z.string().nullable()) })) })
  .parse(JSON.parse(await readFile(new URL('ground-truth.json', root), 'utf8')));
const storageRoot = resolve('.cache/l1-evaluation');
const runtime = createL1({ storageRoot });
const durations: number[] = [];
let correctDocuments = 0, unsafeReady = 0, readyEnvelopes = 0, expectedReady = 0, correctUsd = 0, totalEnvelopes = 0, verifiedCitations = 0;
for (const input of manifest.cases) {
  const start = performance.now();
  const source = await runtime.register({ tenantId: 'synthetic-evaluation', bytes: await readFile(new URL(input.file, root)), channel: input.channel, mimeType: input.mimeType });
  const outputs = await runtime.process(source);
  durations.push(performance.now() - start);
  if (JSON.stringify(outputs.map(e => e.processingStatus)) === JSON.stringify(input.expectedStatuses)) correctDocuments++;
  expectedReady += input.expectedStatuses.filter(s => s === 'READY_FOR_POLICY_EVALUATION').length;
  for (const [index, envelope] of outputs.entries()) {
    totalEnvelopes++;
    if ((envelope.normalization?.usdEquivalent?.amount ?? null) === input.expectedUsd[index]) correctUsd++;
    if (envelope.processingStatus === 'READY_FOR_POLICY_EVALUATION') {
      readyEnvelopes++;
      if (input.expectedStatuses[index] !== 'READY_FOR_POLICY_EVALUATION') unsafeReady++;
      const trusted = await runtime.reader.loadReady(source.tenantId, envelope.envelopeId);
      verifiedCitations += trusted.envelope.evidence.length;
    }
  }
}
durations.sort((a, b) => a - b);
const percentile = (p: number) => Number(durations[Math.max(0, Math.ceil(durations.length * p) - 1)]!.toFixed(2));
const report = {
  mode: 'offline-labelled-synthetic', observedAt: new Date().toISOString(), documents: manifest.cases.length, totalEnvelopes,
  correctDocumentStatuses: correctDocuments, unsafeReady, readyEnvelopes, expectedReadyEnvelopes: expectedReady,
  normalizationExpectationMatches: correctUsd, verifiedCitationReferences: verifiedCitations,
  latencyMs: { p50: percentile(0.5), p95: percentile(0.95), includes: 'registration, local parsing, verification and persistence; not hosted provider latency' },
  fullCriticalFieldAccuracy: null, independentHumanAnnotation: manifest.annotationStatus,
  providerReportedCredits: null, hostedCostUsd: null, liveProviderSmoke: 'NOT_RUN',
  limitations: ['No production accuracy claim', 'Four raster inputs explicitly non-ready without hosted parser', 'Independent human per-field labels pending', 'L2 financial decisions are outside this evaluation'],
};
await mkdir(storageRoot, { recursive: true });
await writeFile(resolve(storageRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (unsafeReady || correctDocuments !== manifest.cases.length) process.exitCode = 1;
