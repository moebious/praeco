/** Explicitly opt-in, billable provider smoke. Expected values stay outside runtime. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createL1, summarize } from '../src/service.js';
import { DEMO_RATES } from '../src/money.js';
import { Decimal } from 'decimal.js';

if (process.env.L1_RUN_LIVE_SMOKE !== '1' || !process.env.LLAMA_CLOUD_API_KEY) {
  console.error('Live smoke not run. Requires L1_RUN_LIVE_SMOKE=1 and a locally configured LLAMA_CLOUD_API_KEY; provider credits may be consumed.');
  process.exitCode = 2;
} else {
  const storageRoot = resolve('.cache/l1-live-smoke');
  const fixtures = [
    { name: 'digital-usd', url: new URL('../test/fixtures/demo-day/sources/01.pdf', import.meta.url), channel: 'PDF' as const, mimeType: 'application/pdf', invoice: 'BOG-2026-10', amount: '2200.00', currency: 'USD', usd: '2200.00' },
    { name: 'cop-cuenta', url: new URL('../test/fixtures/corpus/05.pdf', import.meta.url), channel: 'PDF' as const, mimeType: 'application/pdf', invoice: 'SYN-005', amount: '2400000', currency: 'COP', usd: '600.00' },
    { name: 'scan', url: new URL('../test/fixtures/corpus/10.png', import.meta.url), channel: 'IMAGE' as const, mimeType: 'image/png', invoice: 'SYN-010', amount: '2200', currency: 'USD', usd: '2200.00' },
  ];
  const usage: unknown[] = [];
  const runtime = createL1({ storageRoot, rates: DEMO_RATES, llamaCloud: { apiKey: process.env.LLAMA_CLOUD_API_KEY,
    ...(process.env.LLAMA_CLOUD_PROJECT_ID ? { projectId: process.env.LLAMA_CLOUD_PROJECT_ID } : {}),
    ...(process.env.LLAMA_PARSE_VERSION ? { parseVersion: process.env.LLAMA_PARSE_VERSION } : {}),
    onEvent: async event => {
      if (event && typeof event === 'object' && 'result' in event && event.result && typeof event.result === 'object' && 'usage' in event.result) usage.push(event.result.usage);
    },
  } });
  const results = [];
  for (const input of fixtures) {
    const start = performance.now();
    const source = await runtime.register({ tenantId: 'synthetic-live-smoke', bytes: await readFile(input.url), channel: input.channel, mimeType: input.mimeType });
    const [envelope] = await runtime.process(source);
    const number = envelope?.invoice?.invoice.number, total = envelope?.invoice?.financials.totalDue;
    const fieldsMatch = number?.state === 'OBSERVED' && number.value === input.invoice && total?.state === 'OBSERVED'
      && new Decimal(total.value.amount).eq(input.amount) && total.value.currency === input.currency && envelope?.normalization?.usdEquivalent?.amount === input.usd;
    const dispositionMatches = envelope?.processingStatus === (input.name === 'scan' ? 'REVIEW_REQUIRED' : 'READY_FOR_POLICY_EVALUATION');
    results.push({ name: input.name, fieldsMatch, dispositionMatches, elapsedMs: Number((performance.now() - start).toFixed(2)), ...(envelope ? summarize(envelope) : { processingStatus: 'NO_ENVELOPE' }) });
  }
  const report = { mode: 'live-provider-smoke', observedAt: new Date().toISOString(), results, providerReportedUsage: usage,
    costUsd: null, independentHumanAnnotation: 'PENDING', productionVerified: false };
  await mkdir(storageRoot, { recursive: true });
  await writeFile(resolve(storageRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (results.some(r => !r.fieldsMatch || !r.dispositionMatches)) process.exitCode = 1;
}
