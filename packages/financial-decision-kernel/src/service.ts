import { randomUUID } from 'node:crypto';
import type {
  FinancialDecisionCommand,
  FinancialDecisionRecord,
  FinancialEvaluation,
  HumanApprovalCommand,
  ReadyInvoiceEnvelope,
  TrustedActorContext,
  TrustedFinancialContext,
} from './types.js';
import type { TransactionalFinancialStore } from './store.js';
import { evaluatePayable } from './kernel.js';
import { canonicalJson, digest } from './hashing.js';
import { decimal, toUsdExact } from './decimal.js';
import { buildCanonicalPayableKey } from './tax-id.js';
import { deriveBudgetPeriod } from './period.js';

export interface EnvelopeResolver {
  resolveEnvelopes(tenantId: string, envelopeIds: readonly string[]): Promise<readonly ReadyInvoiceEnvelope[]>;
}

export class FinancialAuthorizationService {
  constructor(
    /** Public read access is intentional: the store exposes auditable state for trusted callers (dashboard aggregation). */
    public readonly store: TransactionalFinancialStore,
    private readonly envelopeResolver: EnvelopeResolver,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  public async preview(
    command: FinancialDecisionCommand,
    actor: TrustedActorContext
  ): Promise<FinancialEvaluation> {
    if (actor.tenantId !== this.store.tenantId) {
      throw new Error('TENANT_ID_MISMATCH');
    }

    const envelopes = await this.envelopeResolver.resolveEnvelopes(
      actor.tenantId,
      command.proposal.envelopeIds
    );

    const context = this.buildContextSnapshot(command.agentGrantRef, command.workerId, actor.principalId);
    return evaluatePayable(envelopes, context, 'PROPOSE_PAYABLE');
  }

  public async decideAndCommit(
    command: FinancialDecisionCommand,
    actor: TrustedActorContext
  ): Promise<FinancialDecisionRecord> {
    if (actor.tenantId !== this.store.tenantId) {
      throw new Error('TENANT_ID_MISMATCH');
    }

    return this.store.withTransaction(async () => {
      // 1. Idempotency verification (ADR-003)
      const payloadDigest = digest(canonicalJson(command));
      const existingReceipt = this.store.receipts.get(command.idempotencyKey);
      if (existingReceipt) {
        if (existingReceipt.payloadDigest !== payloadDigest) {
          throw new Error('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
        }
        const recorded = this.store.decisions.get(existingReceipt.decisionId);
        if (recorded) return recorded;
      }

      // 2. Load verified envelopes through trusted resolver
      const envelopes = await this.envelopeResolver.resolveEnvelopes(
        actor.tenantId,
        command.proposal.envelopeIds
      );

      // 3. Evaluate gates
      const context = this.buildContextSnapshot(command.agentGrantRef, command.workerId, actor.principalId);
      const evalResult = evaluatePayable(envelopes, context, 'REQUEST_SIMULATED_AUTHORIZATION');

      const decisionId = `dec-${randomUUID()}`;
      const payableId = `pay-${randomUUID()}`;
      const occurredAt = this.now();

      let commitmentId: string | null = null;
      let approvalRequestId: string | null = null;

      // Extract canonical information
      const firstEnv = envelopes[0];
      const inv = firstEnv?.invoice;
      const payable = firstEnv?.normalization.candidatePayable;
      const unroundedUsd = payable ? toUsdExact(payable.amount, payable.currency) : decimal(0);

      const period = inv ? deriveBudgetPeriod(inv).period : '2026-10';
      const taxId = inv?.beneficiary.taxId.value ?? 'UNKNOWN';
      const invNum = inv?.invoice.number.value ?? 'UNKNOWN';
      const canonicalKey = inv
        ? buildCanonicalPayableKey(actor.tenantId, taxId, invNum)
        : `unknown:${decisionId}`;

      // 4. Handle outcome mutations atomically
      if (evalResult.outcome === 'AUTHORIZED_SIMULATED') {
        // Concurrency race guard on unique obligation constraint (L2-2)
        const priorObligation = this.store.obligations.get(canonicalKey);
        if (priorObligation) {
          // Race loser
          const loserEval: FinancialEvaluation = {
            ...evalResult,
            outcome: 'BLOCKED',
            explanation: 'Cobro duplicado detectado al intentar comprometer fondos.',
            gateChecks: evalResult.gateChecks.map(c =>
              c.gate === 'G2'
                ? {
                    ...c,
                    status: 'FAIL',
                    code: 'G2_DUPLICATE',
                    explanation: 'Conflicto de concurrencia: la obligación ya fue autorizada por otra transacción.',
                  }
                : c
            ),
          };
          const decisionRecord: FinancialDecisionRecord = {
            ...loserEval,
            decisionId,
            tenantId: actor.tenantId,
            payableId,
            occurredAt,
            commitmentId: null,
            approvalRequestId: null,
          };
          this.store.decisions.set(decisionId, decisionRecord);
          this.store.receipts.set(command.idempotencyKey, {
            tenantId: actor.tenantId,
            idempotencyKey: command.idempotencyKey,
            payloadDigest,
            decisionId,
            recordedAt: occurredAt,
          });
          return decisionRecord;
        }

        // Debit budget
        const budget = this.store.budgets.get(period) ?? Array.from(this.store.budgets.values()).find(b => b.period === period);
        if (budget) {
          budget.committedUsd = decimal(budget.committedUsd).plus(unroundedUsd).toString();
          budget.revision += 1;
        }

        // Commit obligation
        this.store.obligations.set(canonicalKey, {
          obligationId: `ob-${randomUUID()}`,
          tenantId: actor.tenantId,
          canonicalKey,
          intentDigestSha256: evalResult.financialContextDigest,
          status: 'COMMITTED',
          committedUsd: unroundedUsd.toString(),
          authorizedAt: occurredAt,
        });

        commitmentId = `cmt-${randomUUID()}`;
        this.store.commitments.set(commitmentId, {
          commitmentId,
          tenantId: actor.tenantId,
          canonicalPayableKey: canonicalKey,
          budgetId: budget?.budgetId ?? 'UNKNOWN',
          unroundedUsd: unroundedUsd.toString(),
          decisionId,
          committedAt: occurredAt,
        });

        this.store.ledgerEvents.push({
          eventId: `evt-${randomUUID()}`,
          tenantId: actor.tenantId,
          eventType: 'SIMULATED_AUTHORIZATION_COMMITTED',
          payload: { decisionId, canonicalKey, unroundedUsd: unroundedUsd.toString() },
          occurredAt,
        });
      } else if (evalResult.outcome === 'PENDING_HUMAN_APPROVAL') {
        approvalRequestId = `appr-${randomUUID()}`;
        const expiresAt = new Date(Date.parse(occurredAt) + 24 * 60 * 60 * 1000).toISOString();
        const budget = Array.from(this.store.budgets.values()).find(b => b.period === period);

        this.store.approvalRequests.set(approvalRequestId, {
          approvalRequestId,
          tenantId: actor.tenantId,
          payableCaseId: command.proposal.payableCaseId,
          canonicalPayableKey: canonicalKey,
          intentDigestSha256: evalResult.financialContextDigest,
          envelopeIds: command.proposal.envelopeIds,
          unroundedUsd: unroundedUsd.toString(),
          budgetId: budget?.budgetId ?? 'UNKNOWN',
          budgetLimitRevision: budget?.revision ?? 1,
          originatingWorkerGrantRef: command.agentGrantRef,
          policyRevisionId: evalResult.policyRevisionId,
          status: 'PENDING',
          createdAt: occurredAt,
          expiresAt,
          resolvedAt: null,
          resolvedByPrincipalId: null,
          decisionId,
        });

        this.store.ledgerEvents.push({
          eventId: `evt-${randomUUID()}`,
          tenantId: actor.tenantId,
          eventType: 'APPROVAL_REQUESTED',
          payload: { approvalRequestId, canonicalKey, unroundedUsd: unroundedUsd.toString() },
          occurredAt,
        });
      }

      const decisionRecord: FinancialDecisionRecord = {
        ...evalResult,
        decisionId,
        tenantId: actor.tenantId,
        payableId,
        occurredAt,
        commitmentId,
        approvalRequestId,
      };

      this.store.decisions.set(decisionId, decisionRecord);
      this.store.receipts.set(command.idempotencyKey, {
        tenantId: actor.tenantId,
        idempotencyKey: command.idempotencyKey,
        payloadDigest,
        decisionId,
        recordedAt: occurredAt,
      });

      return decisionRecord;
    });
  }

  public async resolveApproval(
    command: HumanApprovalCommand,
    actor: TrustedActorContext
  ): Promise<FinancialDecisionRecord> {
    if (!actor.roles.includes('FinanceAdmin')) {
      throw new Error('UNAUTHORIZED_ROLE: Only FinanceAdmin may resolve approvals');
    }

    if (actor.tenantId !== this.store.tenantId) {
      throw new Error('TENANT_ID_MISMATCH');
    }

    return this.store.withTransaction(async () => {
      // 1. Idempotency check
      const payloadDigest = digest(canonicalJson(command));
      const existingReceipt = this.store.receipts.get(command.idempotencyKey);
      if (existingReceipt) {
        if (existingReceipt.payloadDigest !== payloadDigest) {
          throw new Error('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
        }
        const recorded = this.store.decisions.get(existingReceipt.decisionId);
        if (recorded) return recorded;
      }

      // 2. Load approval request
      const request = this.store.approvalRequests.get(command.approvalRequestId);
      if (!request) {
        throw new Error('APPROVAL_REQUEST_NOT_FOUND');
      }

      if (request.status !== 'PENDING') {
        throw new Error(`APPROVAL_ALREADY_RESOLVED: ${request.status}`);
      }

      if (request.tenantId !== actor.tenantId) {
        throw new Error('APPROVAL_TENANT_MISMATCH: approval request belongs to a different tenant');
      }

      const currentTime = this.now();

      // 3. Expiry check on read (ADR-003 / P-4: createdAt + 24h)
      if (Date.parse(currentTime) > Date.parse(request.expiresAt)) {
        request.status = 'EXPIRED';
        throw new Error('APPROVAL_EXPIRED');
      }

      const decisionId = `dec-${randomUUID()}`;
      const payableId = `pay-${randomUUID()}`;

      if (command.action === 'REJECT') {
        request.status = 'REJECTED';
        request.resolvedAt = currentTime;
        request.resolvedByPrincipalId = actor.principalId;

        const record: FinancialDecisionRecord = {
          outcome: 'BLOCKED',
          explanation: 'Pago rechazado por el administrador financiero (FinanceAdmin).',
          gateChecks: [],
          financialContextDigest: digest({ rejectedApprovalRequestId: request.approvalRequestId }),
          policyRevisionId: this.store.policy.policyRevisionId,
          grantRevisionId: 'grant-human-override',
          decisionId,
          tenantId: actor.tenantId,
          payableId,
          occurredAt: currentTime,
          commitmentId: null,
          approvalRequestId: request.approvalRequestId,
        };

        this.store.decisions.set(decisionId, record);
        this.store.receipts.set(command.idempotencyKey, {
          tenantId: actor.tenantId,
          idempotencyKey: command.idempotencyKey,
          payloadDigest,
          decisionId,
          recordedAt: currentTime,
        });

        return record;
      }

      // 4. Action is APPROVE: re-resolve trusted evidence and re-evaluate all hard gates (G1-G5)
      const envelopes = await this.envelopeResolver.resolveEnvelopes(
        actor.tenantId,
        request.envelopeIds
      );

      const grantRef = request.originatingWorkerGrantRef;
      const workerGrant = this.store.grants.get(grantRef);
      if (!workerGrant) {
        throw new Error(`APPROVAL_STALE: Originating worker capability grant (${grantRef}) revoked or missing`);
      }
      const context = this.buildContextSnapshot(grantRef);

      // Re-evaluate
      const freshEval = evaluatePayable(envelopes, context, 'REQUEST_SIMULATED_AUTHORIZATION');

      // Check for hard failures across ALL gates: a human approval must never
      // bypass a gate that began failing during the wait, including a lost or
      // revoked grant action at G6 (a hard failure, not an eligible excess).
      const hardFailures = freshEval.gateChecks.filter(c => c.status === 'FAIL');
      if (hardFailures.length > 0) {
        // Late budget consumption or changed state blocked it!
        const record: FinancialDecisionRecord = {
          ...freshEval,
          outcome: 'BLOCKED',
          explanation: `Aprobación no autorizada: reevaluación falló en controles (${hardFailures[0]!.code}): ${hardFailures[0]!.explanation}`,
          decisionId,
          tenantId: actor.tenantId,
          payableId,
          occurredAt: currentTime,
          commitmentId: null,
          approvalRequestId: request.approvalRequestId,
        };
        this.store.decisions.set(decisionId, record);
        return record;
      }

      // Staleness checks on approval binding
      const period = deriveBudgetPeriod(envelopes[0]!.invoice).period;
      const budget = Array.from(this.store.budgets.values()).find(b => b.period === period);
      if (!budget || budget.budgetId !== request.budgetId) {
        throw new Error('APPROVAL_STALE: Budget identity or structure changed');
      }
      if (budget.revision < request.budgetLimitRevision) {
        throw new Error('APPROVAL_STALE: Budget limit revision changed');
      }
      if (request.policyRevisionId && freshEval.policyRevisionId !== request.policyRevisionId) {
        throw new Error('APPROVAL_STALE: Company policy revision changed since approval request was created');
      }
      if (freshEval.financialContextDigest !== request.intentDigestSha256) {
        throw new Error('APPROVAL_STALE: Invoice intent or commercial terms changed since approval request was created');
      }

      // All gates pass: consume one-off threshold exception
      request.status = 'APPROVED';
      request.resolvedAt = currentTime;
      request.resolvedByPrincipalId = actor.principalId;

      const unroundedUsd = decimal(request.unroundedUsd);
      budget.committedUsd = decimal(budget.committedUsd).plus(unroundedUsd).toString();
      budget.revision += 1;

      // Commit obligation
      this.store.obligations.set(request.canonicalPayableKey, {
        obligationId: `ob-${randomUUID()}`,
        tenantId: actor.tenantId,
        canonicalKey: request.canonicalPayableKey,
        intentDigestSha256: request.intentDigestSha256,
        status: 'COMMITTED',
        committedUsd: unroundedUsd.toString(),
        authorizedAt: currentTime,
      });

      const commitmentId = `cmt-${randomUUID()}`;
      this.store.commitments.set(commitmentId, {
        commitmentId,
        tenantId: actor.tenantId,
        canonicalPayableKey: request.canonicalPayableKey,
        budgetId: budget.budgetId,
        unroundedUsd: unroundedUsd.toString(),
        decisionId,
        committedAt: currentTime,
      });

      const record: FinancialDecisionRecord = {
        outcome: 'AUTHORIZED_SIMULATED',
        explanation: 'Pago simulado autorizado con excepción aprobada por FinanceAdmin.',
        gateChecks: freshEval.gateChecks.map(c =>
          c.gate === 'G6'
            ? {
                ...c,
                status: 'PASS',
                code: 'HUMAN_APPROVAL_GRANTED',
                explanation: `Aprobación humana otorgada por ${actor.principalId}.`,
              }
            : c
        ),
        financialContextDigest: freshEval.financialContextDigest,
        policyRevisionId: this.store.policy.policyRevisionId,
        grantRevisionId: workerGrant?.grantRevisionId ?? 'human-approved',
        decisionId,
        tenantId: actor.tenantId,
        payableId,
        occurredAt: currentTime,
        commitmentId,
        approvalRequestId: request.approvalRequestId,
      };

      this.store.decisions.set(decisionId, record);
      this.store.receipts.set(command.idempotencyKey, {
        tenantId: actor.tenantId,
        idempotencyKey: command.idempotencyKey,
        payloadDigest,
        decisionId,
        recordedAt: currentTime,
      });

      this.store.ledgerEvents.push({
        eventId: `evt-${randomUUID()}`,
        tenantId: actor.tenantId,
        eventType: 'APPROVAL_RESOLVED',
        payload: { approvalRequestId: request.approvalRequestId, decisionId, action: 'APPROVE' },
        occurredAt: currentTime,
      });

      return record;
    });
  }

  private buildContextSnapshot(
    grantId: string,
    expectedWorkerId?: string,
    expectedPrincipalId?: string
  ): TrustedFinancialContext {
    const workerGrant = this.store.grants.get(grantId);
    if (!workerGrant) {
      throw new Error(`UNKNOWN_AGENT_GRANT: ${grantId}`);
    }
    if (expectedWorkerId !== undefined && workerGrant.workerId !== expectedWorkerId) {
      throw new Error(`GRANT_WORKER_MISMATCH: grant ${grantId} does not authorize worker ${expectedWorkerId}`);
    }
    if (expectedPrincipalId !== undefined && workerGrant.workerId !== expectedPrincipalId) {
      throw new Error(`GRANT_PRINCIPAL_MISMATCH: acting principal ${expectedPrincipalId} is not the worker bound to grant ${grantId}`);
    }

    return {
      tenantId: this.store.tenantId,
      policy: this.store.policy,
      workerGrant,
      vendors: Array.from(this.store.vendors.values()),
      contracts: Array.from(this.store.contracts.values()),
      budgets: Array.from(this.store.budgets.values()),
      obligations: Array.from(this.store.obligations.values()),
    };
  }
}
