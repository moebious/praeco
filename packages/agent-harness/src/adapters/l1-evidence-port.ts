import type {
  IntakeChannel,
  L1ProcessingResult,
  L1Runtime,
  ReadyEvidence,
} from '@praeco/evidence-intelligence';
import type {
  EvidencePort,
  EvidenceRunReference,
  L1EnvelopeId,
  TrustedExecutionContext,
  TrustedPrincipal,
} from '../types.js';
import { HarnessError } from '../state-machine.js';

export interface L1EvidencePortAdapterOptions {
  l1: Pick<L1Runtime, 'register' | 'processWithReceipt' | 'reader'>;
}

/**
 * Adapter implementing EvidencePort on top of the authoritative @praeco/evidence-intelligence L1 runtime.
 * Guarantees that:
 * 1. Sources are registered immutably with SHA-256 hashes.
 * 2. Processing receipts clearly separate SUPPLEMENTAL_CONTEXT from INVOICE_OR_UNCERTAIN.
 * 3. Supplemental documents return empty envelopeIds and are never marked ready for financial intent.
 * 4. All reads enforce strict tenant scoping.
 */
export class L1EvidencePortAdapter implements EvidencePort {
  private readonly l1: Pick<L1Runtime, 'register' | 'processWithReceipt' | 'reader'>;

  constructor(options: L1EvidencePortAdapterOptions) {
    this.l1 = options.l1;
  }

  public async ingestSource(
    params: {
      bytes: Uint8Array;
      channel: IntakeChannel;
      mimeType: string;
      displayName?: string;
      originMessageId?: string;
    },
    context: TrustedExecutionContext
  ): Promise<EvidenceRunReference> {
    const tenantId = context.principal.tenantId;

    // 1. Register immutable source in L1
    const source = await this.l1.register({
      tenantId,
      bytes: params.bytes,
      channel: params.channel,
      mimeType: params.mimeType,
      displayName: params.displayName,
      originMessageId: params.originMessageId,
    });

    // 2. Process with authoritative receipt
    const receipt: L1ProcessingResult = await this.l1.processWithReceipt(source);

    // 3. Strict disposition branch
    if (receipt.sourceDisposition === 'SUPPLEMENTAL_CONTEXT') {
      return {
        sourceId: source.sourceId,
        sourceHashSha256: source.sourceHashSha256,
        pipelineRunId: receipt.pipelineRunId,
        sourceDisposition: 'SUPPLEMENTAL_CONTEXT',
        envelopeIds: [],
      };
    }

    const envelopeIds = receipt.envelopes.map((e) => e.envelopeId) as [
      L1EnvelopeId,
      ...L1EnvelopeId[],
    ];

    return {
      sourceId: source.sourceId,
      sourceHashSha256: source.sourceHashSha256,
      pipelineRunId: receipt.pipelineRunId,
      sourceDisposition: 'INVOICE_OR_UNCERTAIN',
      envelopeIds,
    };
  }

  public async loadRun(
    reference: EvidenceRunReference,
    principal: TrustedPrincipal
  ): Promise<EvidenceRunReference> {
    const storedRun = (await this.l1.reader.loadRun(
      principal.tenantId,
      reference.pipelineRunId
    )) as { sourceId?: string; sourceHashSha256?: string };

    if (
      storedRun.sourceId !== reference.sourceId ||
      storedRun.sourceHashSha256 !== reference.sourceHashSha256
    ) {
      throw new HarnessError(
        'EVIDENCE_RUN_CORRUPTED',
        `Evidence run ${reference.pipelineRunId} source integrity verification failed`
      );
    }

    return reference;
  }

  public async loadReady(
    envelopeId: L1EnvelopeId,
    principal: TrustedPrincipal
  ): Promise<ReadyEvidence> {
    const ready = await this.l1.reader.loadReady(principal.tenantId, envelopeId);
    if (ready.envelope.source.tenantId !== principal.tenantId) {
      throw new HarnessError(
        'TENANT_ISOLATION_VIOLATION',
        `Envelope ${envelopeId} does not belong to tenant ${principal.tenantId}`
      );
    }
    return ready;
  }
}
