import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, sample } from './helpers.js';
import { LabelledTextExtractor } from '../src/extraction.js';
import type { ExtractionPort } from '../src/document-processing-ports.js';
import { canonicalJson, digest, sha256 } from '../src/integrity.js';
import { parseEnvelope } from '../src/schemas.js';
import { summarize, compareUsdRatio, createL1 } from '../src/service.js';

describe('registered sources and trusted read boundary', () => {
  it('processes source-backed facts, persists evidence and resolves after a restart', async () => {
    const { root, runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(envelope?.processingStatus).toBe('READY_FOR_POLICY_EVALUATION');
    const ready = await createL1({ storageRoot: root }).reader.loadReady('a', envelope!.envelopeId);
    expect(ready.envelope.normalization.usdEquivalent).toEqual({ amount: '2000.00', currency: 'USD' });
    expect(ready.integrityDigestSha256).toBe(digest(envelope));
    expect(ready.usdRatio).toEqual({ numerator: '8000000', denominator: '4000' });
    expect(JSON.stringify(summarize(ready.envelope))).not.toContain('SYN-ACCOUNT');
    expect(ready.envelope.artifacts.map(a => a.kind)).toEqual(expect.arrayContaining(['ORIGINAL', 'PARSED_TEXT', 'EXTRACTION_RAW', 'VERIFICATION_REPORT']));
  });
  it('makes concurrent technical registration idempotent without conflating tenants', async () => {
    const { runtime } = await setup();
    const input = { tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'EMAIL' as const, mimeType: 'text/plain', originMessageId: 'message-1' };
    const [a, same] = await Promise.all([runtime.register(input), runtime.register(input)]);
    expect(a).toEqual(same);
    const b = await runtime.register({ ...input, tenantId: 'b' });
    expect(b.sourceId).not.toBe(a.sourceId);
    await expect(runtime.register({ ...input, bytes: Buffer.from((await sample()) + 'changed') })).rejects.toThrow('IMMUTABLE_RECORD_CONFLICT');
    const [envelope] = await runtime.process(a);
    await expect(runtime.reader.loadReady('b', envelope!.envelopeId)).rejects.toThrow('ENVELOPE_NOT_FOUND');
  });
  it('rejects a source descriptor edited after registration', async () => {
    const { runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    await expect(runtime.process({ ...source, storageKey: '/etc/passwd' })).rejects.toThrow('SOURCE_BINDING_MISMATCH');
    await expect(runtime.process({ ...source, tenantId: 'b' })).rejects.toThrow('SOURCE_NOT_REGISTERED');
  });
  it('detects original byte tampering before reusing or processing evidence', async () => {
    const { root, runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    await writeFile(join(root, source.storageKey), 'tampered source');
    await expect(runtime.process(source)).rejects.toThrow('ARTIFACT_HASH_MISMATCH');
    await expect(runtime.reader.loadReady('a', envelope!.envelopeId)).rejects.toThrow('ARTIFACT_HASH_MISMATCH');
  });
  it('detects normalized-value tampering and does not trust an in-memory accepted object', async () => {
    const { root, runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    const changed = structuredClone(envelope!);
    changed.normalization!.usdEquivalent!.amount = '1.00';
    expect((await runtime.reader.loadReady('a', envelope!.envelopeId)).envelope.normalization.usdEquivalent?.amount).toBe('2000.00');
    await writeFile(join(root, 'objects', sha256('a'), digest(envelope)), canonicalJson(changed));
    await expect(runtime.reader.loadReady('a', envelope!.envelopeId)).rejects.toThrow('ARTIFACT_HASH_MISMATCH');
    await expect(runtime.reader.loadReady('a', 'invented-accepted-report')).rejects.toThrow('ENVELOPE_NOT_FOUND');
  });
  it('does not claim that L1 technical replay is business duplicate detection', async () => {
    const { runtime } = await setup();
    for (const suffix of ['', '\nForwarded through another channel']) {
      const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from((await sample()) + suffix), channel: 'CHAT', mimeType: 'text/plain' });
      expect((await runtime.process(source))[0]?.processingStatus).toBe('READY_FOR_POLICY_EVALUATION');
    }
  });
  it('compares exact FX ratios without rounding a boundary down', () => {
    expect(compareUsdRatio({ numerator: '50000.01', denominator: '20' }, '2500')).toBe(1);
    expect(compareUsdRatio({ numerator: '50000', denominator: '20' }, '2500')).toBe(0);
    expect(compareUsdRatio({ numerator: '49999.99', denominator: '20' }, '2500')).toBe(-1);
    expect(() => compareUsdRatio({ numerator: '1', denominator: '0' }, '1')).toThrow();
  });
  it('enforces semantic readiness beyond a TypeScript discriminant', async () => {
    const { runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(() => parseEnvelope({ ...envelope, evidence: [] })).toThrow();
    expect(() => parseEnvelope({ ...envelope, normalization: { ...envelope!.normalization, candidatePayable: null } })).toThrow();
    expect(() => parseEnvelope({ ...envelope, errors: [{ code: 'FAIL', stage: 'VERIFY', retryable: false, message: 'FAIL' }] })).toThrow();
    const missingCritical = structuredClone(envelope!);
    missingCritical.invoice!.invoice.dueDate = { state: 'MISSING', value: null };
    expect(() => parseEnvelope(missingCritical)).toThrow();
  });
  it('routes uncertain multi-page boundaries for review without merging invoices', async () => {
    const { runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from((await sample()) + '\fUnclassified attachment without an invoice marker'), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(envelope?.processingStatus).toBe('REVIEW_REQUIRED');
    expect(envelope?.errors[0]?.code).toBe('UNCERTAIN_PACKET_BOUNDARIES');
  });
  it('checks actual content against the declared channel instead of the filename', async () => {
    const { runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from('%PDF-invalid'), channel: 'CHAT', mimeType: 'text/plain', displayName: 'invoice.txt' });
    expect((await runtime.process(source))[0]?.errors[0]?.code).toBe('UNSUPPORTED_NATIVE_CONTENT');
  });
});

describe('untrusted adapter and citation output', () => {
  const base = new LabelledTextExtractor();
  const mutate = (change: (output: Awaited<ReturnType<ExtractionPort['extract']>>) => void): ExtractionPort => ({
    provider: 'UNTRUSTED_TEST_ADAPTER', version: 'test', configuration: {},
    async extract(input) { const result = await base.extract(input); change(result); return result; },
  });
  it.each(['amount', 'source', 'span', 'quote', 'artifact', 'page', 'duplicate'] as const)('rejects %s tampering', async mutation => {
    const extractor = mutate(result => {
      const draft = result.drafts[0]!, evidence = draft.evidence[0]!;
      if (mutation === 'amount' && draft.invoice.financials.totalDue.state === 'OBSERVED') draft.invoice.financials.totalDue.value.amount = '1';
      if (mutation === 'source') evidence.sourceHashSha256 = '0'.repeat(64);
      if (mutation === 'quote') evidence.quotedText = 'fabricated';
      if (mutation === 'span' && evidence.locator.kind === 'TEXT_SPAN') evidence.locator.endUtf8Byte = 900000;
      if (mutation === 'artifact' && evidence.locator.kind === 'TEXT_SPAN') evidence.locator.artifactId = 'other-source';
      if (mutation === 'page') evidence.locator = { kind: 'PAGE_REGION', page: 999, box: { x: 0, y: 0, width: 0.1, height: 0.1 } };
      if (mutation === 'duplicate') draft.evidence = [...draft.evidence, evidence];
    });
    const { runtime } = await setup({ extractor });
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(envelope?.processingStatus).toBe('REJECTED');
    await expect(runtime.reader.loadReady('a', envelope!.envelopeId)).rejects.toThrow('ENVELOPE_NOT_READY');
  });
  it('rejects UTF-8 offsets inside an accented character', async () => {
    const extractor = mutate(result => {
      const draft = result.drafts[0]!;
      const name = draft.invoice.beneficiary.legalName;
      if (name.state !== 'OBSERVED') throw new Error('Expected labelled fixture');
      const evidence = draft.evidence.find(e => e.evidenceId === name.evidenceIds[0])!;
      if (evidence.locator.kind !== 'TEXT_SPAN') throw new Error('Expected text span');
      // Prefix ends at the first byte of é in the observed value.
      evidence.locator.startUtf8Byte += Buffer.byteLength('Synthetic Caf') + 1;
    });
    const { runtime } = await setup({ extractor });
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from((await sample()).replace('Synthetic Bogota Studio', 'Synthetic Café Studio')), channel: 'CHAT', mimeType: 'text/plain' });
    expect((await runtime.process(source))[0]?.processingStatus).toBe('REJECTED');
  });
  it('retains auditable operational failures without leaking provider exception text', async () => {
    const { runtime } = await setup({ extractor: { provider: 'FAIL', version: 'test', configuration: {}, async extract() { throw new Error('secret-account-number'); } } });
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(envelope?.processingStatus).toBe('PROCESSING_FAILED');
    expect(JSON.stringify(envelope)).not.toContain('secret-account-number');
    expect(envelope?.artifacts.some(a => a.kind === 'PARSED_TEXT')).toBe(true);
  });
});
