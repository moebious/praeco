import type {
  TransactionalFinancialStore,
  FinancialAuthorizationService,
  FinancialDecisionRecord,
  FinancialEvaluation,
  TrustedActorContext,
} from '@praeco/financial-decision-kernel';
import type {
  ApprovalObservation,
  FinancialCommandObservation,
  FinancialDecisionPort,
  FinancialDecisionReference,
  FinancialIntentReference,
  L2DecisionId,
  TrustedExecutionContext,
  TrustedPrincipal,
} from '../types.js';
import { HarnessError } from '../state-machine.js';
import { ensureHarnessWorkerGrant } from '../l2-grants.js';

export interface ServiceAndStore {
  service: FinancialAuthorizationService;
  store: TransactionalFinancialStore;
}

export interface L2FinancialDecisionAdapterOptions {
  resolveService: (tenantId: string, scenarioId?: string) => ServiceAndStore;
  now?: () => string;
}

/**
 * Adapter implementing FinancialDecisionPort on top of the authoritative
 * @praeco/financial-decision-kernel L2 service and TransactionalFinancialStore.
 *
 * Guarantees:
 * 1. Read-only preview never commits obligations or mutates budgets.
 * 2. decideAndCommit calls L2 kernel and maps authoritative results without inventing verdicts.
 * 3. getCommandResult checks L2 idempotency receipts.
 * 4. getApprovalStatus reads real approval request state with derived 24h expiry check.
 * 5. Strict tenant and actor scoping.
 */
export class L2FinancialDecisionAdapter implements FinancialDecisionPort {
  private readonly resolveService: (tenantId: string, scenarioId?: string) => ServiceAndStore;
  private readonly now: () => string;

  constructor(options: L2FinancialDecisionAdapterOptions) {
    this.resolveService = options.resolveService;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async preview(
    intent: FinancialIntentReference,
    context: TrustedExecutionContext,
    scenarioId?: string
  ): Promise<{ binding: false; resultRef: string; evaluation: FinancialEvaluation }> {
    if (!intent.envelopeIds || intent.envelopeIds.length === 0) {
      throw new HarnessError(
        'NO_READY_INVOICE',
        'Cannot evaluate financial preview without at least one ready invoice envelope'
      );
    }

    const { service, store } = this.resolveService(context.principal.tenantId, scenarioId);
    const agentGrantRef = ensureHarnessWorkerGrant(store, context.workerPrincipalId, [
      'PROPOSE_PAYABLE',
    ]);
    const actor: TrustedActorContext = {
      tenantId: context.principal.tenantId,
      principalId: context.principal.principalId,
      roles: context.principal.roles,
    };

    const evaluation = await service.preview(
      {
        proposal: {
          payableCaseId: intent.caseId,
          envelopeIds: intent.envelopeIds,
        },
        workerId: context.workerPrincipalId,
        agentGrantRef,
        idempotencyKey: `preview-${intent.intentId}`,
      },
      actor
    );

    return {
      binding: false,
      resultRef: intent.intentId,
      evaluation,
    };
  }

  public async decideAndCommit(
    intent: FinancialIntentReference,
    context: TrustedExecutionContext,
    scenarioId?: string
  ): Promise<FinancialDecisionReference> {
    if (!intent.envelopeIds || intent.envelopeIds.length === 0) {
      throw new HarnessError(
        'NO_READY_INVOICE',
        'Cannot submit financial proposal without at least one ready invoice envelope'
      );
    }

    const { service, store } = this.resolveService(context.principal.tenantId, scenarioId);
    const agentGrantRef = ensureHarnessWorkerGrant(store, context.workerPrincipalId, [
      'PROPOSE_PAYABLE',
      'REQUEST_SIMULATED_AUTHORIZATION',
    ]);
    const actor: TrustedActorContext = {
      tenantId: context.principal.tenantId,
      principalId: context.principal.principalId,
      roles: context.principal.roles,
    };

    const record: FinancialDecisionRecord = await service.decideAndCommit(
      {
        proposal: {
          payableCaseId: intent.caseId,
          envelopeIds: intent.envelopeIds,
        },
        workerId: context.workerPrincipalId,
        agentGrantRef,
        idempotencyKey: intent.idempotencyKey,
      },
      actor
    );

    return {
      decisionId: record.decisionId,
      outcome: record.outcome,
      approvalRequestId: record.approvalRequestId ?? undefined,
      gateSummaryRefs: record.gateChecks.map((g) => g.code),
    };
  }

  public async getCommandResult(
    intent: FinancialIntentReference,
    context: TrustedExecutionContext,
    scenarioId?: string
  ): Promise<FinancialCommandObservation> {
    const { store } = this.resolveService(context.principal.tenantId, scenarioId);
    const receipt = store.receipts.get(intent.idempotencyKey);

    if (!receipt || receipt.tenantId !== context.principal.tenantId) {
      return { status: 'NOT_FOUND' };
    }

    const decisionRecord = store.decisions.get(receipt.decisionId);
    if (!decisionRecord) {
      return { status: 'IN_PROGRESS' };
    }

    return {
      status: 'COMPLETED',
      decision: {
        decisionId: decisionRecord.decisionId,
        outcome: decisionRecord.outcome,
        approvalRequestId: decisionRecord.approvalRequestId ?? undefined,
        gateSummaryRefs: decisionRecord.gateChecks.map((g) => g.code),
      },
    };
  }

  public async getDecision(
    decisionId: L2DecisionId,
    principal: TrustedPrincipal,
    scenarioId?: string
  ): Promise<FinancialDecisionReference | null> {
    const { store } = this.resolveService(principal.tenantId, scenarioId);
    const record = store.decisions.get(decisionId);

    if (!record || record.tenantId !== principal.tenantId) {
      return null;
    }

    return {
      decisionId: record.decisionId,
      outcome: record.outcome,
      approvalRequestId: record.approvalRequestId ?? undefined,
      gateSummaryRefs: record.gateChecks.map((g) => g.code),
    };
  }

  public async getApprovalStatus(
    approvalRequestId: string,
    principal: TrustedPrincipal,
    scenarioId?: string
  ): Promise<ApprovalObservation | null> {
    const { store } = this.resolveService(principal.tenantId, scenarioId);
    const req = store.approvalRequests.get(approvalRequestId);

    if (!req || req.tenantId !== principal.tenantId) {
      return null;
    }

    const currentTime = this.now();
    const isExpired = Date.parse(currentTime) > Date.parse(req.expiresAt);

    // Observations are computed from state without mutating it: expiry is
    // derived from expiresAt on every read, and the authoritative EXPIRED
    // transition stays with the L2 write path (resolveApproval).
    if (req.status === 'PENDING') {
      if (isExpired) {
        return { status: 'EXPIRED' };
      }
      return {
        status: 'PENDING',
        expiresAt: req.expiresAt,
      };
    }

    if (req.status === 'APPROVED') {
      return {
        status: 'RESOLVED',
        // The resolving decision, not the original PENDING decision the
        // request was created with (l3-contract: append the resolution
        // reference; resolution produces a new decision ID).
        resolutionDecisionId: req.resolvedDecisionId ?? req.decisionId,
      };
    }

    if (req.status === 'REJECTED') {
      return {
        status: 'REJECTED',
        resolutionDecisionId: req.resolvedDecisionId ?? req.decisionId,
      };
    }

    return { status: 'EXPIRED' };
  }
}
