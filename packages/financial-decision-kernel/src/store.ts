import type {
  BudgetDirectoryEntry,
  CommittedObligation,
  ContractDirectoryEntry,
  FinancialDecisionRecord,
  PolicyConfig,
  VendorDirectoryEntry,
  WorkerCapabilityGrant,
} from './types.js';

export interface ApprovalRequestRecord {
  approvalRequestId: string;
  tenantId: string;
  payableCaseId: string;
  canonicalPayableKey: string;
  intentDigestSha256: string;
  envelopeIds: readonly string[];
  unroundedUsd: string;
  budgetId: string;
  budgetLimitRevision: number;
  originatingWorkerGrantRef: string;
  policyRevisionId: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  createdAt: string; // ISOInstant
  expiresAt: string; // createdAt + 24h
  resolvedAt: string | null;
  resolvedByPrincipalId: string | null;
  decisionId: string;
}

export interface CommandReceiptRecord {
  tenantId: string;
  idempotencyKey: string;
  payloadDigest: string;
  decisionId: string;
  recordedAt: string;
}

export interface CommitmentRecord {
  commitmentId: string;
  tenantId: string;
  canonicalPayableKey: string;
  budgetId: string;
  unroundedUsd: string;
  decisionId: string;
  committedAt: string;
}

export interface LedgerEvent {
  eventId: string;
  tenantId: string;
  eventType:
    | 'SIMULATED_AUTHORIZATION_COMMITTED'
    | 'BUDGET_DEBITED'
    | 'APPROVAL_REQUESTED'
    | 'APPROVAL_RESOLVED';
  payload: Record<string, unknown>;
  occurredAt: string;
}

export class TransactionalFinancialStore {
  public readonly vendors = new Map<string, VendorDirectoryEntry>();
  public readonly contracts = new Map<string, ContractDirectoryEntry>();
  public readonly budgets = new Map<string, BudgetDirectoryEntry>();
  public policy: PolicyConfig;
  public readonly grants = new Map<string, WorkerCapabilityGrant>();
  public readonly obligations = new Map<string, CommittedObligation>();
  public readonly decisions = new Map<string, FinancialDecisionRecord>();
  public readonly approvalRequests = new Map<string, ApprovalRequestRecord>();
  public readonly receipts = new Map<string, CommandReceiptRecord>();
  public readonly commitments = new Map<string, CommitmentRecord>();
  public readonly ledgerEvents: LedgerEvent[] = [];

  // Async lock / serialization mutex for ACID transactions
  private txMutex = Promise.resolve();

  constructor(public readonly tenantId: string, policy?: PolicyConfig) {
    this.policy = policy ?? {
      policyRevisionId: 'default-policy-v1',
      tenantId,
      maxAutoApproveUsd: '2500.00',
      budgetCurrency: 'USD',
      defaultRecurringTolerancePct: '5.00',
    };
  }

  /**
   * Runs an operation inside a serializable transaction lock,
   * guaranteeing no interleaved reads or writes to shared budgets or obligations.
   */
  public async withTransaction<T>(fn: () => Promise<T> | T): Promise<T> {
    let release: () => void = () => {};
    const nextMutex = new Promise<void>(resolve => {
      release = resolve;
    });
    const currentMutex = this.txMutex;
    this.txMutex = currentMutex.then(() => nextMutex);

    await currentMutex;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
