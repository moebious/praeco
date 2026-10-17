import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setup, sample } from './helpers.js';
import { createL1, accountAuditReference } from '../src/service.js';
import type { ImmutablePersistencePort, ExtractionPort } from '../src/ports.js';
import { LabelledTextExtractor } from '../src/extraction.js';
import { L1Error } from '../src/integrity.js';

describe('original handoff reconciliation', () => {
  it('preserves every canonical contract token from the original handoff', async () => {
    function tokens(source: string) {
      // This fixed declaration-only contract has no regex literals or comment
      // delimiters inside strings. Preserve literal contents and punctuation.
      return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
        .match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s]/g);
    }
    const current = await readFile(new URL('../src/contracts.ts', import.meta.url), 'utf8');
    const original = await readFile(new URL('../../../docs/reference/l1-original-handoff/contracts/l1.contracts.ts', import.meta.url), 'utf8');
    expect(tokens(current)).toEqual(tokens(original));
  });

  it('retains supplemental chat without manufacturing an invoice or calling extraction', async () => {
    let calls = 0;
    const extractor: ExtractionPort = { provider: 'SHOULD_NOT_RUN', version: 'test', configuration: {}, async extract() { calls++; throw new Error('not invoice'); } };
    const { root, runtime } = await setup({ extractor });
    const input = { tenantId: 'a', bytes: Buffer.from('Supplemental context\nReference: ARG-2026-10\nThe USD 1950 invoice includes a proposed USD 450 bonus over a USD 1500 base. This message is not an approved amendment.'), channel: 'CHAT' as const, mimeType: 'text/plain', originMessageId: 'chat-argentina' };
    const source = await runtime.register(input);
    expect(await runtime.process(source)).toEqual([]);
    expect(calls).toBe(0);
    const afterRestart = createL1({ storageRoot: root });
    expect(await afterRestart.register(input)).toEqual(source);
    await writeFile(join(root, source.storageKey), 'altered context');
    await expect(afterRestart.process(source)).rejects.toThrow('ARTIFACT_HASH_MISMATCH');
  });

  it('does not discard a malformed invoice just because an extractor returns no drafts', async () => {
    const extractor: ExtractionPort = { provider: 'EMPTY', version: 'test', configuration: {}, async extract() { return { drafts: [], raw: {}, sourceDisposition: 'SUPPLEMENTAL_CONTEXT' }; } };
    const { runtime } = await setup({ extractor });
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from('Supplemental context\nInvoice number: BROKEN\nTotal due: unknown'), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(envelope?.processingStatus).toBe('REVIEW_REQUIRED');
    expect(envelope?.errors[0]?.code).toBe('UNCERTAIN_DOCUMENT_KIND');
  });

  it('replays retained extraction and original rates after restart, without parser/provider calls', async () => {
    const { root, runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    const [original] = await runtime.process(source);
    const noProvider = createL1({ storageRoot: root, rates: [], extractor: {
      provider: 'MUST_NOT_RUN', version: 'test', configuration: {}, async extract() { throw new Error('provider was called'); },
    } });
    const replay = await noProvider.replay('a', original!.envelopeId);
    expect(replay.invoice).toEqual(original?.invoice);
    expect(replay.normalization).toEqual(original?.normalization);
    expect(replay.evidence).toEqual(original?.evidence);
    expect(replay.verification?.checks).toEqual(original?.verification?.checks);
    expect(replay.verification?.status).toBe(original?.verification?.status);
    expect(replay.envelopeId).not.toBe(original?.envelopeId);
    expect(replay.verification?.reportId).not.toBe(original?.verification?.reportId);
    expect((await noProvider.reader.loadReady('a', replay.envelopeId)).envelope).toEqual(replay);
    expect(await noProvider.reader.loadRun('a', replay.pipelineRunId)).toMatchObject({ replayOf: original?.envelopeId, status: 'COMPLETED' });
  });

  it('replays non-ready conflicts without silently repairing or accepting them', async () => {
    const { runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from((await sample()) + '\nTotal due: 9000000'), channel: 'CHAT', mimeType: 'text/plain' });
    const [original] = await runtime.process(source);
    const replay = await runtime.replay('a', original!.envelopeId);
    expect(replay.processingStatus).toBe('REVIEW_REQUIRED');
    expect(replay.invoice).toEqual(original?.invoice);
  });

  it('rejects replay of a corrupt parsed snapshot', async () => {
    const { root, runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    const [original] = await runtime.process(source);
    const parsed = original!.artifacts.find(a => a.kind === 'PARSED_TEXT')!;
    await writeFile(join(root, parsed.storageKey), 'changed parser output');
    await expect(runtime.replay('a', original!.envelopeId)).rejects.toThrow('ARTIFACT_HASH_MISMATCH');
  });

  it('runs against an immutable persistence port without a filesystem/backend dependency', async () => {
    const data = new Map<string, Uint8Array>();
    const persistence: ImmutablePersistencePort = {
      async put(key, bytes) {
        const prior = data.get(key);
        if (prior && !Buffer.from(prior).equals(Buffer.from(bytes))) throw new L1Error('IMMUTABLE_RECORD_CONFLICT', 'INTAKE');
        data.set(key, new Uint8Array(bytes));
      },
      async get(key) { const bytes = data.get(key); return bytes ? new Uint8Array(bytes) : null; },
    };
    const { runtime } = await setup({ persistence });
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(envelope?.processingStatus).toBe('READY_FOR_POLICY_EVALUATION');
    expect((await runtime.reader.loadReady('a', envelope!.envelopeId)).envelope.source).toEqual(source);
    expect(data.size).toBeGreaterThan(5);
    const context = await runtime.register({ tenantId: 'a', bytes: Buffer.from('Supplemental context\nReference: ABC\nA pending conversation about supporting evidence.'), channel: 'CHAT', mimeType: 'text/plain' });
    expect(await runtime.process(context)).toEqual([]);
    expect([...data.values()].map(b => Buffer.from(b).toString('utf8')).some(t => t.includes('"sourceDisposition":"SUPPLEMENTAL_CONTEXT"'))).toBe(true);
  });

  it('keeps a missing invoice number explicit rather than fabricating an identity', async () => {
    const { runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from((await sample()).replace(/^Invoice number:.*\n/m, '')), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(envelope?.invoice?.invoice.number).toEqual({ state: 'MISSING', value: null });
    expect(envelope?.processingStatus).toBe('REVIEW_REQUIRED');
  });

  it('preserves native message IDs and UTF-8 byte offsets with accented names', async () => {
    const { runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from((await sample()).replace('Synthetic Bogota Studio', 'Synthetic Bogotá Café')), channel: 'EMAIL', mimeType: 'text/plain', originMessageId: 'message-utf8' });
    const [envelope] = await runtime.process(source);
    expect(envelope?.processingStatus).toBe('READY_FOR_POLICY_EVALUATION');
    expect(envelope?.evidence.every(e => e.locator.kind === 'MESSAGE_SPAN' && e.locator.messageId === 'message-utf8')).toBe(true);
    expect((await runtime.replay('a', envelope!.envelopeId)).invoice).toEqual(envelope?.invoice);
  });

  it('grounds explicit Spanish DD/MM/YYYY dates without replacing the source quote', async () => {
    const { runtime } = await setup();
    const body = (await sample()).replace('Issue date: 2026-10-01', 'Fecha emisión: 01/10/2026').replace('Due date: 2026-10-31', 'Fecha vencimiento: 31/10/2026');
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(body), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(envelope?.processingStatus).toBe('READY_FOR_POLICY_EVALUATION');
    expect(envelope?.invoice?.invoice.dueDate).toMatchObject({ state: 'OBSERVED', value: '2026-10-31' });
    expect(envelope?.evidence.some(e => e.quotedText === '31/10/2026')).toBe(true);
  });

  it('does not let normalization suppress observed extraction provenance', async () => {
    const base = new LabelledTextExtractor();
    const { runtime } = await setup({ extractor: base });
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(envelope?.invoice?.financials.totalDue).toMatchObject({ state: 'OBSERVED', value: { amount: '8000000', currency: 'COP' } });
    expect(envelope?.normalization?.usdEquivalent?.amount).toBe('2000.00');
    expect(envelope?.provenance.extraction.configurationDigestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('grounds line items and checks complete quantity/price/subtotal relationships', async () => {
    const { runtime } = await setup();
    const body = (await sample()) + '\nLine 1 description: Engineering services\nLine 1 quantity: 2\nLine 1 unit price: 4000000\nLine 1 total: 8000000\n';
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(body), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(envelope?.processingStatus).toBe('READY_FOR_POLICY_EVALUATION');
    expect(envelope?.invoice?.commercial.lineItemsCompleteness).toBe('COMPLETE');
    expect(envelope?.invoice?.commercial.lineItems[0]?.quantity).toMatchObject({ state: 'OBSERVED', value: '2' });
    const bad = await runtime.register({ tenantId: 'a', bytes: Buffer.from(body.replace('Line 1 quantity: 2', 'Line 1 quantity: 3')), channel: 'CHAT', mimeType: 'text/plain' });
    expect((await runtime.process(bad))[0]?.processingStatus).toBe('REVIEW_REQUIRED');
  });

  it('offers keyed account audit references without exposing account identifiers', async () => {
    const { runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    const reference = accountAuditReference(envelope!, Buffer.alloc(32, 3));
    expect(reference).toEqual(accountAuditReference(envelope!, Buffer.alloc(32, 3)));
    expect(reference?.fingerprint).not.toBe(accountAuditReference(envelope!, Buffer.alloc(32, 4))?.fingerprint);
    expect(JSON.stringify(reference)).not.toContain('SYN-ACCOUNT');
    expect(() => accountAuditReference(envelope!, Buffer.alloc(5))).toThrow('ACCOUNT_FINGERPRINT_KEY_REQUIRED');
  });
});
