import type { ReadyInvoiceEnvelope } from './types.js';
import { buildCanonicalPayableKey } from './tax-id.js';
import { digest } from './hashing.js';

export interface CanonicalClaimResult {
  canonicalEnvelope: ReadyInvoiceEnvelope;
  corroboratingDuplicates: readonly ReadyInvoiceEnvelope[];
}

export type MultiEnvelopeResolution =
  | { success: true; claim: CanonicalClaimResult }
  | { success: false; code: 'AMBIGUOUS_PAYABLE_CLAIM'; explanation: string };

/**
 * Resolves one canonical payable claim from multiple envelopes under L2-3:
 * - Multiple READY envelopes with identical canonical key and identical intent digest
 *   constitute one obligation: select the deterministic representative (earliest registered source)
 *   and record others as corroborating duplicates.
 * - Same key with conflicting intent digest fails closed (AMBIGUOUS_PAYABLE_CLAIM).
 */
export function resolveCanonicalClaim(
  tenantId: string,
  envelopes: readonly ReadyInvoiceEnvelope[]
): MultiEnvelopeResolution {
  if (envelopes.length === 0) {
    return {
      success: false,
      code: 'AMBIGUOUS_PAYABLE_CLAIM',
      explanation: 'No se suministraron sobres de factura verificados.',
    };
  }

  if (envelopes.length === 1) {
    return {
      success: true,
      claim: {
        canonicalEnvelope: envelopes[0]!,
        corroboratingDuplicates: [],
      },
    };
  }

  // Multiple envelopes: check for identical canonical key and intent digest
  const first = envelopes[0]!;
  const firstTaxId = first.invoice.beneficiary.taxId.value;
  const firstInvNum = first.invoice.invoice.number.value;

  if (!firstTaxId || !firstInvNum) {
    return {
      success: false,
      code: 'AMBIGUOUS_PAYABLE_CLAIM',
      explanation: 'Faltan identificadores clave en uno de los sobres.',
    };
  }

  const expectedKey = buildCanonicalPayableKey(tenantId, firstTaxId, firstInvNum);
  const expectedDigest = digest(first.invoice);

  for (let i = 1; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    const taxId = env.invoice.beneficiary.taxId.value;
    const invNum = env.invoice.invoice.number.value;

    if (!taxId || !invNum) {
      return {
        success: false,
        code: 'AMBIGUOUS_PAYABLE_CLAIM',
        explanation: 'Faltan identificadores clave en uno de los sobres concurrentes.',
      };
    }

    const key = buildCanonicalPayableKey(tenantId, taxId, invNum);
    const d = digest(env.invoice);

    if (key !== expectedKey || d !== expectedDigest) {
      return {
        success: false,
        code: 'AMBIGUOUS_PAYABLE_CLAIM',
        explanation: 'Múltiples sobres de factura bajo el mismo caso presentan datos contradictorios o claves diferentes.',
      };
    }
  }

  // All identical: sort deterministically by receivedAt ascending, tiebreak envelopeId
  const sorted = [...envelopes].sort((a, b) => {
    const timeA = Date.parse(a.source.receivedAt);
    const timeB = Date.parse(b.source.receivedAt);
    if (timeA !== timeB) return timeA - timeB;
    return a.envelopeId.localeCompare(b.envelopeId);
  });

  return {
    success: true,
    claim: {
      canonicalEnvelope: sorted[0]!,
      corroboratingDuplicates: sorted.slice(1),
    },
  };
}
