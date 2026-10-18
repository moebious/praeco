import type { EvidenceReader } from '@praeco/evidence-intelligence';
import type { EnvelopeResolver } from './service.js';
import type { ReadyInvoiceEnvelope } from './types.js';

/**
 * Slice E — Trusted L1 Evidence Reader Adapter.
 * Resolves verified envelopes through L1's authoritative reader.loadReady(tenantId, envelopeId),
 * ensuring evidence integrity, artifact checks, and normalization bindings are validated
 * before financial policy evaluation.
 */
export class L1EvidenceReaderAdapter implements EnvelopeResolver {
  constructor(private readonly reader: EvidenceReader) {}

  public async resolveEnvelopes(
    tenantId: string,
    envelopeIds: readonly string[]
  ): Promise<readonly ReadyInvoiceEnvelope[]> {
    const readyEnvelopes: ReadyInvoiceEnvelope[] = [];
    for (const envelopeId of envelopeIds) {
      const readyEvidence = await this.reader.loadReady(tenantId, envelopeId);
      readyEnvelopes.push(readyEvidence.envelope as ReadyInvoiceEnvelope);
    }
    return readyEnvelopes;
  }
}
