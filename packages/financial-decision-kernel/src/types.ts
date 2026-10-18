import type { InvoiceEnvelope, PaymentAccountClaim } from '@praeco/evidence-intelligence';

export type FinancialOutcome =
  | 'AUTHORIZED_SIMULATED'
  | 'BLOCKED'
  | 'PENDING_HUMAN_APPROVAL';

export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6';

export type GateStatus = 'PASS' | 'FAIL' | 'REVIEW_ELIGIBLE' | 'NOT_EVALUABLE';

export type ContractMatchMode = 'EXACT' | 'RECURRING_TOLERANCE' | 'CEILING';

export interface GateCheckResult {
  gate: GateId;
  status: GateStatus;
  code: string;
  explanation: string;
  evidenceRefs: readonly string[];
  authoritativeRecordRefs: readonly string[];
  facts?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface PayableProposal {
  payableCaseId: string;
  envelopeIds: readonly string[];
  externalAccountingRef?: string;
}

export interface FinancialDecisionCommand {
  proposal: PayableProposal;
  idempotencyKey: string;
  workerId: string;
  agentGrantRef: string;
}

export interface FinancialEvaluation {
  outcome: FinancialOutcome;
  explanation: string;
  gateChecks: readonly GateCheckResult[];
  financialContextDigest: string;
  policyRevisionId: string;
  grantRevisionId: string;
}

export interface FinancialDecisionRecord extends FinancialEvaluation {
  decisionId: string;
  tenantId: string;
  payableId: string;
  occurredAt: string;
  commitmentId: string | null;
  approvalRequestId: string | null;
}

export interface HumanApprovalCommand {
  approvalRequestId: string;
  idempotencyKey: string;
  action: 'APPROVE' | 'REJECT';
}

export interface TrustedActorContext {
  tenantId: string;
  principalId: string;
  roles: readonly string[];
}

export interface VendorDirectoryEntry {
  vendorId: string;
  legalName: string;
  taxId: string;
  isAllowlisted: boolean;
  paymentAccountFingerprint: string;
  accountClaim?: PaymentAccountClaim;
}

export interface ContractDirectoryEntry {
  contractId: string;
  vendorId: string;
  mode: ContractMatchMode;
  amount: string;
  currency: string;
  maxPositiveVariancePct?: string;
  effectiveFrom: string;
  effectiveTo?: string;
}

export interface BudgetDirectoryEntry {
  budgetId: string;
  tenantId: string;
  period: string; // YYYY-MM
  limitUsd: string;
  committedUsd: string;
  revision: number;
}

export interface PolicyConfig {
  policyRevisionId: string;
  tenantId: string;
  maxAutoApproveUsd: string;
  budgetCurrency: string;
  effectivePeriod?: string;
  defaultRecurringTolerancePct?: string;
}

export interface WorkerCapabilityGrant {
  grantId: string;
  grantRevisionId: string;
  tenantId: string;
  workerId: string;
  perPayableLimitUsd: string;
  allowedActions: readonly ('PROPOSE_PAYABLE' | 'REQUEST_SIMULATED_AUTHORIZATION')[];
}

export interface CommittedObligation {
  obligationId: string;
  tenantId: string;
  canonicalKey: string; // tenantId:vendorTaxId:invoiceNumber
  intentDigestSha256: string;
  status: 'COMMITTED';
  committedUsd: string;
  authorizedAt: string;
}

export interface TrustedFinancialContext {
  tenantId: string;
  policy: PolicyConfig;
  workerGrant: WorkerCapabilityGrant;
  vendors: readonly VendorDirectoryEntry[];
  contracts: readonly ContractDirectoryEntry[];
  budgets: readonly BudgetDirectoryEntry[];
  obligations: readonly CommittedObligation[];
  hmacKey?: Uint8Array | string;
}

export type ReadyInvoiceEnvelope = Extract<
  InvoiceEnvelope,
  { processingStatus: 'READY_FOR_POLICY_EVALUATION' }
>;
