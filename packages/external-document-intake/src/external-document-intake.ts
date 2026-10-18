import type { DocumentSource, IntakeChannel, L1Runtime } from '@praeco/evidence-intelligence';
import { ExternalDocumentReferenceSchema, ExternalDocumentIntakeError, IntegrationIdSchema,
  externalObjectIdentity, integrationHash, parseIntegration } from './external-document-provenance.js';
import type { ExternalDocumentBinding, ExternalDocumentProvenanceStore, ExternalDocumentReceipt, ExternalDocumentReference } from './external-document-provenance.js';

export interface ExternalDocumentInput {
  externalReference: ExternalDocumentReference;
  documentBytes: Uint8Array;
  channel: IntakeChannel;
  mimeType: string;
}
export interface ExternalDocumentResult {
  binding: ExternalDocumentBinding;
  envelopes: ExternalDocumentReceipt['envelopes'];
}
export interface ExternalDocumentIntakeOptions {
  authenticatedTenantId: string;
  l1: Pick<L1Runtime, 'register' | 'process' | 'reader'>;
  provenance: ExternalDocumentProvenanceStore;
  resolveConnection(input: { tenantId: string; provider: ExternalDocumentReference['provider']; connectionId: string }): Promise<'ACTIVE' | 'REVOKED' | 'UNAVAILABLE' | 'NOT_FOUND'>;
  now?: () => string;
}

export function createExternalDocumentIntake(options: ExternalDocumentIntakeOptions) {
  const tenantId = parseIntegration(IntegrationIdSchema, options.authenticatedTenantId, 'INVALID_TENANT_CONTEXT');
  const now = options.now ?? (() => new Date().toISOString());

  async function checkConnection(reference: ExternalDocumentReference): Promise<void> {
    let status: string;
    try { status = await options.resolveConnection({ tenantId, provider: reference.provider, connectionId: reference.connectionId }); }
    catch { throw new ExternalDocumentIntakeError('EXTERNAL_CONNECTION_UNAVAILABLE'); }
    if (status !== 'ACTIVE') throw new ExternalDocumentIntakeError(status === 'REVOKED' ? 'EXTERNAL_CONNECTION_REVOKED' : 'EXTERNAL_CONNECTION_UNAVAILABLE');
  }
  async function result(binding: ExternalDocumentBinding, receipt: ExternalDocumentReceipt): Promise<ExternalDocumentResult> {
    for (const reference of receipt.envelopes) {
      let envelope;
      try { envelope = await options.l1.reader.load(tenantId, reference.envelopeId); }
      catch { throw new ExternalDocumentIntakeError('IMPORTED_EVIDENCE_UNAVAILABLE'); }
      if (envelope.source.tenantId !== tenantId || envelope.source.sourceId !== binding.sourceId
        || envelope.source.sourceHashSha256 !== binding.sourceHashSha256 || envelope.pipelineRunId !== reference.pipelineRunId
        || envelope.processingStatus !== reference.processingStatus) throw new ExternalDocumentIntakeError('IMPORTED_EVIDENCE_BINDING_MISMATCH');
    }
    return { binding, envelopes: receipt.envelopes };
  }

  return {
    async ingest(input: ExternalDocumentInput): Promise<ExternalDocumentResult> {
      const reference = parseIntegration(ExternalDocumentReferenceSchema, input.externalReference, 'INVALID_EXTERNAL_REFERENCE');
      const bytes = validateDocument(input);
      await checkConnection(reference);
      const hash = integrationHash(bytes);
      const revision = reference.externalRevision === undefined ? ['CONTENT', hash] : ['PROVIDER', reference.externalRevision];
      const snapshotId = integrationHash(JSON.stringify([...externalObjectIdentity(reference), reference.externalAttachmentId ?? null,
        revision, input.channel, input.mimeType]));
      let source: DocumentSource;
      try {
        source = await options.l1.register({ tenantId, bytes, channel: input.channel, mimeType: input.mimeType, originMessageId: `external-${snapshotId}` });
      } catch (error) {
        const conflict = error instanceof Error && 'code' in error && error.code === 'IMMUTABLE_RECORD_CONFLICT';
        throw new ExternalDocumentIntakeError(conflict ? 'EXTERNAL_REVISION_CONTENT_CONFLICT' : 'DOCUMENT_REGISTRATION_FAILED');
      }
      if (source.tenantId !== tenantId || source.sourceHashSha256 !== hash || source.channel !== input.channel || source.mimeType !== input.mimeType)
        throw new ExternalDocumentIntakeError('IMPORTED_SOURCE_BINDING_MISMATCH');
      const binding = await options.provenance.capture({ ...reference, tenantId, sourceId: source.sourceId, sourceHashSha256: hash });
      const prior = await options.provenance.loadReceipt(tenantId, binding.bindingId);
      if (prior) return result(binding, prior);
      let envelopes;
      try { envelopes = await options.l1.process(source); }
      catch { throw new ExternalDocumentIntakeError('DOCUMENT_PROCESSING_FAILED'); }
      const candidate: ExternalDocumentReceipt = { bindingId: binding.bindingId, sourceId: source.sourceId,
        sourceHashSha256: hash, completedAt: now(), envelopes: envelopes.map(envelope => ({ envelopeId: envelope.envelopeId,
          pipelineRunId: envelope.pipelineRunId, processingStatus: envelope.processingStatus })) };
      await result(binding, candidate);
      const receipt = await options.provenance.saveReceipt(tenantId, candidate);
      return result(binding, receipt);
    },
    async load(bindingId: string): Promise<ExternalDocumentResult> {
      const binding = await options.provenance.load(tenantId, bindingId);
      await checkConnection(binding);
      const receipt = await options.provenance.loadReceipt(tenantId, bindingId);
      if (!receipt) throw new ExternalDocumentIntakeError('EXTERNAL_DOCUMENT_NOT_PROCESSED');
      return result(binding, receipt);
    },
  };
}

function validateDocument(input: ExternalDocumentInput): Uint8Array {
  if (!(input.documentBytes instanceof Uint8Array) || input.documentBytes.byteLength === 0 || input.documentBytes.byteLength > 20_000_000)
    throw new ExternalDocumentIntakeError('EXTERNAL_DOCUMENT_SIZE_LIMIT');
  const bytes = Buffer.from(input.documentBytes);
  const pdf = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (input.channel === 'PDF' && input.mimeType === 'application/pdf' && pdf) return bytes;
  if (input.channel === 'IMAGE' && ((input.mimeType === 'image/png' && png) || (input.mimeType === 'image/jpeg' && jpeg))) return bytes;
  if ((input.channel === 'EMAIL' || input.channel === 'CHAT') && input.mimeType === 'text/plain' && !pdf && !png && !jpeg) {
    try {
      if (!new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\u0000')) return bytes;
    } catch { throw new ExternalDocumentIntakeError('UNSUPPORTED_EXTERNAL_DOCUMENT'); }
  }
  throw new ExternalDocumentIntakeError('UNSUPPORTED_EXTERNAL_DOCUMENT');
}

export type ExternalDocumentIntake = ReturnType<typeof createExternalDocumentIntake>;
