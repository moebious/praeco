import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createL1, summarize } from './service.js';
import { L1Error } from './integrity.js';

const { values } = parseArgs({ options: { file: { type: 'string' }, tenant: { type: 'string', default: 'synthetic-demo' },
  channel: { type: 'string', default: 'CHAT' }, mime: { type: 'string', default: 'text/plain' },
  storage: { type: 'string', default: process.env.L1_STORAGE_ROOT ?? '.cache/praeco-l1' }, cloud: { type: 'boolean', default: false } }, strict: true });
try {
  const channel = values.channel;
  if (!['PDF', 'IMAGE', 'EMAIL', 'CHAT'].includes(channel)) throw new L1Error('INVALID_CHANNEL', 'INTAKE');
  const file = values.file ?? fileURLToPath(new URL('../examples/invoice.txt', import.meta.url));
  if (values.cloud && !process.env.LLAMA_CLOUD_API_KEY) throw new L1Error('LLAMACLOUD_CREDENTIAL_REQUIRED', 'EXTRACT');
  const runtime = createL1({ storageRoot: values.storage, ...(values.cloud ? { llamaCloud: {
    apiKey: process.env.LLAMA_CLOUD_API_KEY!, ...(process.env.LLAMA_CLOUD_PROJECT_ID ? { projectId: process.env.LLAMA_CLOUD_PROJECT_ID } : {}),
    ...(process.env.LLAMA_PARSE_VERSION ? { parseVersion: process.env.LLAMA_PARSE_VERSION } : {}),
  } } : {}) });
  const source = await runtime.register({ tenantId: values.tenant, bytes: await readFile(file), channel: channel as 'PDF' | 'IMAGE' | 'EMAIL' | 'CHAT', mimeType: values.mime });
  const envelopes = await runtime.process(source);
  console.log(JSON.stringify(envelopes.length ? envelopes.map(summarize)
    : { sourceId: source.sourceId, sourceHashSha256: source.sourceHashSha256, sourceDisposition: 'SUPPLEMENTAL_CONTEXT', envelopes: [] }, null, 2));
  if (envelopes.some(e => e.processingStatus === 'PROCESSING_FAILED')) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof L1Error ? error.code : 'L1_COMMAND_FAILED' })); process.exitCode = 1;
}
