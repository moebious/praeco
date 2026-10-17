/**
 * BLINKA v3.0 — cross-layer integration sketch for demo cases.
 * NOT an L1 implementation contract; ownership: L3 payable cases, L2 policy inputs.
 */
import type { Sha256Hex } from './l1.contracts';

export interface SourceLink {
  sourceId: string;
  sourceHashSha256: Sha256Hex;
  purpose: 'PRIMARY_INVOICE' | 'SUPPLEMENTAL_CONTEXT';
}

/** L3 creates this only after verifying how sources relate to the payable case. */
export interface PayableCaseReference {
  caseId: string;
  tenantId: string;
  sourceLinks: readonly SourceLink[];
  invoiceEnvelopeIds: readonly string[];
  correlationBasis: readonly string[];
}

/** Demonstration expectations only; L2 owns exact policy evaluation contracts. */
export type ExpectedDemoOutcome =
  | 'AUTHORIZED_SIMULATED'
  | 'PENDING_HUMAN_APPROVAL'
  | 'BLOCKED';
