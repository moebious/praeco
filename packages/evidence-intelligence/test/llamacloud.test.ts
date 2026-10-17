import { describe, expect, it } from 'vitest';
import { setup, sample } from './helpers.js';
import { LlamaCloudAdapter } from '../src/llamacloud.js';

const fieldLabels = {
  invoice_number: 'Invoice number', issue_date: 'Issue date', due_date: 'Due date', period_start: 'Period start', period_end: 'Period end',
  legal_name: 'Beneficiary', tax_id: 'Tax ID', account_identifier: 'Account', payment_rail: 'Payment rail', contract_reference: 'Contract',
  purchase_order: 'Purchase order', concept: 'Description', currency: 'Currency', subtotal: 'Subtotal', taxes: 'Taxes', discounts: 'Discounts',
  total_due: 'Total due', already_paid: 'Already paid', outstanding: 'Outstanding balance',
};
function extractionResponse(text: string, withCitations = true) {
  const pairs = Object.entries(fieldLabels).map(([field, label]) => {
    const line = text.split('\n').find(line => line.startsWith(`${label}:`));
    return { field, line, value: line ? line.slice(label.length + 1).trim() : null };
  });
  return { id: 'ext-synthetic', status: 'COMPLETED',
    extract_result: { invoices: [Object.fromEntries(pairs.map(p => [p.field, p.value]))] },
    extract_metadata: { field_metadata: { document_metadata: { invoices: [Object.fromEntries(pairs.map(p => [p.field,
      { citation: withCitations && p.line ? [{ page: 1, matching_text: p.line }] : [] }]))] } } },
    configuration: { version: 'synthetic-wire-test' }, usage: { credits: 0 },
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function transport(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => handler(new URL(String(input)), init ?? {});
}

describe('LlamaCloud wire adapters (mocked HTTP, no live credentials)', () => {
  it('uploads original bytes, requests citations and maps actual Extract v2 metadata into verified evidence', async () => {
    const content = await sample(); let postedSchema = false, sawMetadataExpansion = false;
    const { runtime } = await setup({ llamaCloud: { apiKey: 'test-only-not-a-real-key', pollIntervalMs: 0, fetch: transport(async (url, init) => {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-only-not-a-real-key');
      if (url.pathname === '/api/v1/beta/files') {
        expect(init.body).toBeInstanceOf(FormData);
        const form = init.body as FormData; expect(form.get('purpose')).toBe('extract');
        expect(await (form.get('file') as Blob).text()).toBe(content);
        return json({ id: 'dfl-synthetic' });
      }
      if (url.pathname === '/api/v2/extract') {
        const body = JSON.parse(String(init.body)); expect(body.file_input).toBe('dfl-synthetic');
        expect(body.configuration.cite_sources).toBe(true); expect(body.configuration.data_schema.properties.invoices).toBeDefined();
        postedSchema = true; return json({ id: 'ext-synthetic', status: 'PENDING' });
      }
      sawMetadataExpansion = url.searchParams.getAll('expand').includes('extract_metadata');
      return json(extractionResponse(content));
    }) } });
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(content), channel: 'EMAIL', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(envelope?.processingStatus).toBe('READY_FOR_POLICY_EVALUATION');
    expect(envelope?.provenance.extraction.provider).toBe('LLAMAEXTRACT');
    expect(postedSchema && sawMetadataExpansion).toBe(true);
    expect(envelope?.artifacts.filter(a => a.kind === 'EXTRACTION_RAW').length).toBeGreaterThanOrEqual(4);
  });
  it('cannot become ready when provider citations are absent', async () => {
    const content = await sample();
    const { runtime } = await setup({ llamaCloud: { apiKey: 'test', pollIntervalMs: 0, fetch: transport((url) => {
      if (url.pathname === '/api/v1/beta/files') return json({ id: 'dfl-synthetic' });
      if (url.pathname === '/api/v2/extract') return json({ id: 'ext-synthetic', status: 'PENDING' });
      return json(extractionResponse(content, false));
    }) } });
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(content), channel: 'CHAT', mimeType: 'text/plain' });
    expect((await runtime.process(source))[0]?.processingStatus).toBe('REVIEW_REQUIRED');
  });
  it('uses nested Parse job status and the returned original-page markdown', async () => {
    let polls = 0;
    const events: unknown[] = [];
    const adapter = new LlamaCloudAdapter({ apiKey: 'test', pollIntervalMs: 0, parseVersion: 'test-pinned', onEvent: async e => { events.push(e); },
      fetch: transport(url => {
        if (url.pathname === '/api/v1/beta/files') return json({ id: 'dfl-synthetic' });
        if (url.pathname === '/api/v2/parse') return json({ id: 'pjb-synthetic', status: 'PENDING' });
        polls++;
        return polls === 1 ? json({ status: 'COMPLETED', job: { status: 'RUNNING' } })
          : json({ job: { status: 'COMPLETED' }, markdown: { pages: [{ markdown: 'Synthetic scanned invoice' }] } });
      }) });
    const { runtime } = await setup();
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from('registered-test-bytes'), channel: 'IMAGE', mimeType: 'image/png' });
    const parsed = await adapter.parse(source, Buffer.from('registered-test-bytes'));
    expect(polls).toBe(2); expect(parsed.pages).toEqual(['Synthetic scanned invoice']);
    expect(parsed.version).toBe('api-v2:test-pinned'); expect(events.length).toBe(3);
  });
  it.each(['FAILED', 'CANCELLED', 'UNRECOGNIZED'])('fails closed on provider state %s without leaking response details', async status => {
    const { runtime } = await setup({ llamaCloud: { apiKey: 'test', pollIntervalMs: 0, fetch: transport(url => {
      if (url.pathname === '/api/v1/beta/files') return json({ id: 'dfl-synthetic' });
      if (url.pathname === '/api/v2/extract') return json({ id: 'ext-synthetic', status: 'PENDING' });
      return json({ status, error_message: 'do-not-log-account-123' });
    }) } });
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(envelope?.processingStatus).toBe('PROCESSING_FAILED');
    expect(JSON.stringify(envelope)).not.toContain('do-not-log-account-123');
  });
  it('bounds polling and retries rate-limited reads without repeating job creation', async () => {
    let creates = 0, polls = 0;
    const { runtime } = await setup({ llamaCloud: { apiKey: 'test', maxPolls: 3, pollIntervalMs: 0, fetch: transport(url => {
      if (url.pathname === '/api/v1/beta/files') return json({ id: 'dfl-synthetic' });
      if (url.pathname === '/api/v2/extract') { creates++; return json({ id: 'ext-synthetic', status: 'PENDING' }); }
      polls++; return polls === 1 ? json({ error: 'limited' }, 429) : json({ status: 'RUNNING' });
    }) } });
    const source = await runtime.register({ tenantId: 'a', bytes: Buffer.from(await sample()), channel: 'CHAT', mimeType: 'text/plain' });
    const [envelope] = await runtime.process(source);
    expect(creates).toBe(1); expect(polls).toBe(3);
    expect(envelope?.errors[0]?.code).toBe('LLAMACLOUD_POLL_LIMIT'); expect(envelope?.errors[0]?.retryable).toBe(true);
  });
});
