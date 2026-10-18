import { randomUUID } from 'node:crypto';
import type {
  BudgetDirectoryEntry,
  FinancialDecisionCommand,
  FinancialDecisionRecord,
  FinancialEvaluation,
  HumanApprovalCommand,
  ReadyInvoiceEnvelope,
  TrustedActorContext,
  TrustedFinancialContext,
} from './types.js';
import type { TransactionalFinancialStore, ApprovalRequestRecord } from './store.js';
import type {
  AuthoritativeCommitPort, AuthoritativeCommandLookup, AuthoritativeCommandResult,
} from './commit-port.js';
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
    private readonly now: () => string = () => new Date().toISOString(),
    /**
     * Authoritative commit backend (ADR-003). When set, both ledger commit
     * paths delegate the durable race-safe mutation to the port and the
     * in-memory store mirrors the authoritative outcome. Unset (default), the
     * in-memory ledger remains the demo backend.
     */
    private readonly commitPort?: AuthoritativeCommitPort
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

    const context = this.buildContextSnapshot(command.agentGrantRef, command.workerId);
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
      // Reading a committed outcome is not a new financial action. Recover
      // before evidence/context evaluation, even if local non-commit state
      // was cached before another process committed the command.
      const recovered = await this.recoverCommittedCommand({
        tenantId: actor.tenantId, idempotencyKey: command.idempotencyKey, payloadDigest,
      }, null);
      if (recovered) return recovered;
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
      const context = this.buildContextSnapshot(command.agentGrantRef, command.workerId);
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
        const budget =
          this.store.budgets.get(period) ?? Array.from(this.store.budgets.values()).find(b => b.period === period);

        if (this.commitPort) {
          // Authoritative path (ADR-003): the backend transaction owns
          // idempotency, the obligation claim, the budget debit and the
          // durable records; the in-memory store mirrors the outcome.
          commitmentId = `cmt-${randomUUID()}`;
          const portRecord: FinancialDecisionRecord = {
            ...evalResult,
            decisionId,
            tenantId: actor.tenantId,
            payableId,
            occurredAt,
            commitmentId,
            approvalRequestId: null,
          };
          const portResult = await this.commitPort.commitAuthorizedPayable({
            tenantId: actor.tenantId,
            decisionId,
            commitmentId,
            canonicalKey,
            intentDigestSha256: evalResult.intentDigestSha256,
            amountUsd: unroundedUsd.toString(),
            budgetId: budget?.budgetId ?? 'UNKNOWN',
            idempotencyKey: command.idempotencyKey,
            payloadDigest,
            decisionRecord: portRecord,
            occurredAt,
          });

          if (portResult.status === 'IDEMPOTENT_REPLAY') {
            return this.mirrorRecoveredCommand({
              tenantId: actor.tenantId, idempotencyKey: command.idempotencyKey, payloadDigest,
            }, portResult, null);
          }

          this.syncBudgetMirror(budget, portResult.budgetCommittedUsd);

          if (
            portResult.status === 'DUPLICATE_OBLIGATION' ||
            portResult.status === 'CONFLICTING_OBLIGATION'
          ) {
            return this.recordDuplicateLoser(evalResult, {
              decisionId,
              tenantId: actor.tenantId,
              payableId,
              occurredAt,
              idempotencyKey: command.idempotencyKey,
              payloadDigest,
              conflictingIntent: portResult.status === 'CONFLICTING_OBLIGATION',
            });
          }

          if (portResult.status === 'INSUFFICIENT_BUDGET') {
            return this.recordConcurrentExhaustion(evalResult, {
              decisionId,
              tenantId: actor.tenantId,
              payableId,
              occurredAt,
              idempotencyKey: command.idempotencyKey,
              payloadDigest,
              availableUsd: portResult.availableUsd,
            });
          }

          // COMMITTED: mirror the authoritative outcome in memory.
          this.mirrorAuthorizedCommit({
            canonicalKey,
            intentDigestSha256: evalResult.intentDigestSha256,
            amountUsd: unroundedUsd.toString(),
            commitmentId,
            budgetId: budget?.budgetId ?? 'UNKNOWN',
            decisionId,
            tenantId: actor.tenantId,
            occurredAt,
          });
          if (budget) budget.revision += 1;
        } else {
          // In-memory authoritative path (demo default).
          // Concurrency race guard on unique obligation constraint (L2-2)
          const priorObligation = this.store.obligations.get(canonicalKey);
          if (priorObligation) {
            return this.recordDuplicateLoser(evalResult, {
              decisionId,
              tenantId: actor.tenantId,
              payableId,
              occurredAt,
              idempotencyKey: command.idempotencyKey,
              payloadDigest,
              conflictingIntent: priorObligation.intentDigestSha256 !== evalResult.intentDigestSha256,
            });
          }

          // Debit budget
          if (budget) {
            budget.committedUsd = decimal(budget.committedUsd).plus(unroundedUsd).toString();
            budget.revision += 1;
          }

          // Commit obligation
          this.store.obligations.set(canonicalKey, {
            obligationId: `ob-${randomUUID()}`,
            tenantId: actor.tenantId,
            canonicalKey,
            intentDigestSha256: evalResult.intentDigestSha256,
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
        }
      } else if (evalResult.outcome === 'PENDING_HUMAN_APPROVAL') {
        approvalRequestId = `appr-${randomUUID()}`;
        const expiresAt = new Date(Date.parse(occurredAt) + 24 * 60 * 60 * 1000).toISOString();
        const budget = Array.from(this.store.budgets.values()).find(b => b.period === period);

        this.store.approvalRequests.set(approvalRequestId, {
          approvalRequestId,
          tenantId: actor.tenantId,
          payableCaseId: command.proposal.payableCaseId,
          canonicalPayableKey: canonicalKey,
          intentDigestSha256: evalResult.intentDigestSha256,
          envelopeIds: command.proposal.envelopeIds,
          unroundedUsd: unroundedUsd.toString(),
          budgetId: budget?.budgetId ?? 'UNKNOWN',
          budgetLimitRevision: budget?.limitRevision ?? 1,
          originatingWorkerGrantRef: command.agentGrantRef,
          policyRevisionId: evalResult.policyRevisionId,
          status: 'PENDING',
          createdAt: occurredAt,
          expiresAt,
          resolvedAt: null,
          resolvedByPrincipalId: null,
          decisionId,
          resolvedDecisionId: null,
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
      const localRequest = this.store.approvalRequests.get(command.approvalRequestId);
      if (localRequest && localRequest.tenantId !== actor.tenantId) {
        throw new Error('APPROVAL_TENANT_MISMATCH: approval request belongs to a different tenant');
      }
      const recovered = await this.recoverCommittedCommand({
        tenantId: actor.tenantId, idempotencyKey: command.idempotencyKey, payloadDigest,
      }, command.approvalRequestId);
      if (recovered) {
        if (localRequest) {
          localRequest.status = 'APPROVED';
          localRequest.resolvedAt = recovered.occurredAt;
          localRequest.resolvedDecisionId = recovered.decisionId;
        }
        return recovered;
      }
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
        request.resolvedDecisionId = decisionId;

        const record: FinancialDecisionRecord = {
          outcome: 'BLOCKED',
          explanation: 'Pago rechazado por el administrador financiero (FinanceAdmin).',
          gateChecks: [],
          financialContextDigest: digest({ rejectedApprovalRequestId: request.approvalRequestId }),
          intentDigestSha256: '',
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
        return this.closeApprovalAsBlocked({
          request,
          record,
          actor,
          idempotencyKey: command.idempotencyKey,
          payloadDigest,
          resolvedAt: currentTime,
        });
      }

      // Staleness checks on approval binding
      const period = deriveBudgetPeriod(envelopes[0]!.invoice).period;
      const budget = Array.from(this.store.budgets.values()).find(b => b.period === period);
      if (!budget || budget.budgetId !== request.budgetId) {
        throw new Error('APPROVAL_STALE: Budget identity or structure changed');
      }
      if (budget.limitRevision !== request.budgetLimitRevision) {
        throw new Error('APPROVAL_STALE: Budget limit revision changed');
      }
      if (request.policyRevisionId && freshEval.policyRevisionId !== request.policyRevisionId) {
        throw new Error('APPROVAL_STALE: Company policy revision changed since approval request was created');
      }
      if (freshEval.intentDigestSha256 !== request.intentDigestSha256) {
        throw new Error('APPROVAL_STALE: Invoice intent or commercial terms changed since approval request was created');
      }

      // All gates pass: consume one-off threshold exception
      const unroundedUsd = decimal(request.unroundedUsd);

      if (this.commitPort) {
        // Authoritative path (ADR-003): the approval resolution commits
        // through the backend transaction, so concurrent duplicates or budget
        // exhaustion during the wait cannot slip past the human exception.
        const commitmentId = `cmt-${randomUUID()}`;
        const approvedRecord: FinancialDecisionRecord = {
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
          intentDigestSha256: freshEval.intentDigestSha256,
          policyRevisionId: this.store.policy.policyRevisionId,
          grantRevisionId: workerGrant?.grantRevisionId ?? 'human-approved',
          decisionId,
          tenantId: actor.tenantId,
          payableId,
          occurredAt: currentTime,
          commitmentId,
          approvalRequestId: request.approvalRequestId,
        };
        const portResult = await this.commitPort.commitAuthorizedPayable({
          tenantId: actor.tenantId,
          decisionId,
          commitmentId,
          canonicalKey: request.canonicalPayableKey,
          intentDigestSha256: request.intentDigestSha256,
          amountUsd: unroundedUsd.toString(),
          budgetId: budget.budgetId,
          idempotencyKey: command.idempotencyKey,
          payloadDigest,
          decisionRecord: approvedRecord,
          occurredAt: currentTime,
        });

        if (portResult.status !== 'IDEMPOTENT_REPLAY') {
          this.syncBudgetMirror(budget, portResult.budgetCommittedUsd);
        }

        if (
          portResult.status === 'DUPLICATE_OBLIGATION' ||
          portResult.status === 'CONFLICTING_OBLIGATION' ||
          portResult.status === 'INSUFFICIENT_BUDGET'
        ) {
          // A concurrent transaction claimed the payable or exhausted the
          // budget during the wait. The human APPROVE is consent, not an
          // override (ADR-003): the request closes as APPROVAL_BLOCKED with
          // this immutable BLOCKED resolution decision, so a retry under a new
          // key fails closed instead of minting a second decision.
          const duplicate =
            portResult.status === 'DUPLICATE_OBLIGATION' ||
            portResult.status === 'CONFLICTING_OBLIGATION';
          const conflictingIntent = portResult.status === 'CONFLICTING_OBLIGATION';
          const record: FinancialDecisionRecord = {
            ...freshEval,
            outcome: 'BLOCKED',
            explanation: duplicate
              ? conflictingIntent
                ? 'Aprobación no consumida: existe una obligación concurrente con intención financiera distinta.'
                : 'Aprobación no consumida: la obligación fue autorizada concurrentemente por otra transacción.'
              : 'Aprobación no consumida: el presupuesto fue agotado concurrentemente en el almacén autoritativo.',
            gateChecks: freshEval.gateChecks.map(c =>
              duplicate
                ? c.gate === 'G2'
                  ? {
                      ...c,
                      status: 'FAIL',
                      code: conflictingIntent ? 'G2_CONFLICT' : 'G2_DUPLICATE',
                      explanation: conflictingIntent
                        ? 'Conflicto de concurrencia: la obligación existente tiene una intención financiera distinta.'
                        : 'Conflicto de concurrencia: la obligación ya fue autorizada por otra transacción.',
                    }
                  : c
                : c.gate === 'G5'
                  ? {
                      ...c,
                      status: 'FAIL',
                      code: 'BUDGET_EXHAUSTED',
                      explanation: 'Presupuesto agotado de forma concurrente en el almacén autoritativo.',
                    }
                  : c
            ),
            decisionId,
            tenantId: actor.tenantId,
            payableId,
            occurredAt: currentTime,
            commitmentId: null,
            approvalRequestId: request.approvalRequestId,
          };
          return this.closeApprovalAsBlocked({
            request,
            record,
            actor,
            idempotencyKey: command.idempotencyKey,
            payloadDigest,
            resolvedAt: currentTime,
          });
        }

        if (portResult.status === 'IDEMPOTENT_REPLAY') {
          const replayed = this.mirrorRecoveredCommand({
            tenantId: actor.tenantId, idempotencyKey: command.idempotencyKey, payloadDigest,
          }, portResult, command.approvalRequestId);
          request.status = 'APPROVED';
          request.resolvedAt = replayed.occurredAt;
          request.resolvedDecisionId = replayed.decisionId;
          return replayed;
        }

        // COMMITTED: consume the approval and mirror the outcome in memory.
        request.status = 'APPROVED';
        request.resolvedAt = currentTime;
        request.resolvedByPrincipalId = actor.principalId;
        request.resolvedDecisionId = decisionId;
        this.mirrorAuthorizedCommit({
          canonicalKey: request.canonicalPayableKey,
          intentDigestSha256: request.intentDigestSha256,
          amountUsd: unroundedUsd.toString(),
          commitmentId,
          budgetId: budget.budgetId,
          decisionId,
          tenantId: actor.tenantId,
          occurredAt: currentTime,
        });
        budget.revision += 1;
        this.store.decisions.set(decisionId, approvedRecord);
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
        return approvedRecord;
      }

      // In-memory authoritative path (demo default).
      request.status = 'APPROVED';
      request.resolvedAt = currentTime;
      request.resolvedByPrincipalId = actor.principalId;
      request.resolvedDecisionId = decisionId;

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
        intentDigestSha256: freshEval.intentDigestSha256,
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

  private async recoverCommittedCommand(
    query: AuthoritativeCommandLookup,
    approvalRequestId: string | null
  ): Promise<FinancialDecisionRecord | null> {
    if (!this.commitPort) return null;
    const result = await this.commitPort.lookupCommandResult(query);
    if (!result) return null;
    return this.mirrorRecoveredCommand(query, result, approvalRequestId);
  }

  private mirrorRecoveredCommand(
    query: AuthoritativeCommandLookup,
    result: AuthoritativeCommandResult,
    approvalRequestId: string | null
  ): FinancialDecisionRecord {
    const record = result.decisionRecord;
    if (
      record.tenantId !== query.tenantId || record.outcome !== 'AUTHORIZED_SIMULATED' ||
      !record.commitmentId || record.approvalRequestId !== approvalRequestId
    ) {
      throw new Error('IDEMPOTENT_DECISION_RECORD_INVALID');
    }
    const budget = Array.from(this.store.budgets.values()).find(b => b.budgetId === result.budgetId);
    this.syncBudgetMirror(budget, result.budgetCommittedUsd);
    this.mirrorAuthorizedCommit({
      canonicalKey: result.canonicalKey,
      intentDigestSha256: record.intentDigestSha256,
      amountUsd: result.amountUsd,
      commitmentId: record.commitmentId,
      budgetId: result.budgetId,
      decisionId: record.decisionId,
      tenantId: record.tenantId,
      occurredAt: record.occurredAt,
    });
    this.store.decisions.set(record.decisionId, record);
    this.store.receipts.set(query.idempotencyKey, {
      ...query, decisionId: record.decisionId,
      recordedAt: record.occurredAt, recoveredAt: this.now(),
    });
    return record;
  }

  /** Syncs the in-memory budget mirror to the authoritative committed total. */
  private syncBudgetMirror(budget: BudgetDirectoryEntry | undefined, committedUsd: string | null): void {
    if (budget && committedUsd !== null) {
      budget.committedUsd = committedUsd;
    }
  }

  /** Mirrors an authoritative commit into the in-memory read paths. */
  private mirrorAuthorizedCommit(input: {
    canonicalKey: string;
    intentDigestSha256: string;
    amountUsd: string;
    commitmentId: string;
    budgetId: string;
    decisionId: string;
    tenantId: string;
    occurredAt: string;
  }): void {
    const alreadyMirrored = this.store.commitments.has(input.commitmentId);
    this.store.obligations.set(input.canonicalKey, {
      obligationId: this.store.obligations.get(input.canonicalKey)?.obligationId ?? `ob-${randomUUID()}`,
      tenantId: input.tenantId,
      canonicalKey: input.canonicalKey,
      intentDigestSha256: input.intentDigestSha256,
      status: 'COMMITTED',
      committedUsd: input.amountUsd,
      authorizedAt: input.occurredAt,
    });
    this.store.commitments.set(input.commitmentId, {
      commitmentId: input.commitmentId,
      tenantId: input.tenantId,
      canonicalPayableKey: input.canonicalKey,
      budgetId: input.budgetId,
      unroundedUsd: input.amountUsd,
      decisionId: input.decisionId,
      committedAt: input.occurredAt,
    });
    if (!alreadyMirrored) {
      this.store.ledgerEvents.push({
        eventId: `evt-${randomUUID()}`,
        tenantId: input.tenantId,
        eventType: 'SIMULATED_AUTHORIZATION_COMMITTED',
        payload: { decisionId: input.decisionId, canonicalKey: input.canonicalKey, unroundedUsd: input.amountUsd },
        occurredAt: input.occurredAt,
      });
    }
  }

  /** Records the duplicate race loser and its idempotency receipt. */
  private recordDuplicateLoser(
    evalResult: FinancialEvaluation,
    ids: {
      decisionId: string;
      tenantId: string;
      payableId: string;
      occurredAt: string;
      idempotencyKey: string;
      payloadDigest: string;
      conflictingIntent?: boolean;
    }
  ): FinancialDecisionRecord {
    const conflictingIntent = ids.conflictingIntent ?? false;
    const loserEval: FinancialEvaluation = {
      ...evalResult,
      outcome: 'BLOCKED',
      explanation: conflictingIntent
        ? 'Intención financiera conflictiva detectada al intentar comprometer fondos.'
        : 'Cobro duplicado detectado al intentar comprometer fondos.',
      gateChecks: evalResult.gateChecks.map(c =>
        c.gate === 'G2'
          ? {
              ...c,
              status: 'FAIL',
              code: conflictingIntent ? 'G2_CONFLICT' : 'G2_DUPLICATE',
              explanation: conflictingIntent
                ? 'Conflicto de concurrencia: la obligación existente tiene una intención financiera distinta.'
                : 'Conflicto de concurrencia: la obligación ya fue autorizada por otra transacción.',
            }
          : c
      ),
    };
    const decisionRecord: FinancialDecisionRecord = {
      ...loserEval,
      decisionId: ids.decisionId,
      tenantId: ids.tenantId,
      payableId: ids.payableId,
      occurredAt: ids.occurredAt,
      commitmentId: null,
      approvalRequestId: null,
    };
    this.store.decisions.set(ids.decisionId, decisionRecord);
    this.store.receipts.set(ids.idempotencyKey, {
      tenantId: ids.tenantId,
      idempotencyKey: ids.idempotencyKey,
      payloadDigest: ids.payloadDigest,
      decisionId: ids.decisionId,
      recordedAt: ids.occurredAt,
    });
    return decisionRecord;
  }

  /** Records a BLOCKED decision when the authoritative backend reports the
   *  budget was concurrently exhausted after the gates passed. */
  private recordConcurrentExhaustion(
    evalResult: FinancialEvaluation,
    ids: {
      decisionId: string;
      tenantId: string;
      payableId: string;
      occurredAt: string;
      idempotencyKey: string;
      payloadDigest: string;
      availableUsd: string;
    }
  ): FinancialDecisionRecord {
    const blockedEval: FinancialEvaluation = {
      ...evalResult,
      outcome: 'BLOCKED',
      explanation: 'Pago bloqueado: presupuesto agotado de forma concurrente en el almacén autoritativo.',
      gateChecks: evalResult.gateChecks.map(c =>
        c.gate === 'G5'
          ? {
              ...c,
              status: 'FAIL',
              code: 'BUDGET_EXHAUSTED',
              explanation: `Presupuesto agotado concurrentemente (disponible: USD ${ids.availableUsd}).`,
            }
          : c
      ),
    };
    const decisionRecord: FinancialDecisionRecord = {
      ...blockedEval,
      decisionId: ids.decisionId,
      tenantId: ids.tenantId,
      payableId: ids.payableId,
      occurredAt: ids.occurredAt,
      commitmentId: null,
      approvalRequestId: null,
    };
    this.store.decisions.set(ids.decisionId, decisionRecord);
    this.store.receipts.set(ids.idempotencyKey, {
      tenantId: ids.tenantId,
      idempotencyKey: ids.idempotencyKey,
      payloadDigest: ids.payloadDigest,
      decisionId: ids.decisionId,
      recordedAt: ids.occurredAt,
    });
    return decisionRecord;
  }

  /**
   * Closes an approval request whose human APPROVE could not authorize.
   *
   * The request reaches the terminal lifecycle state `APPROVAL_BLOCKED` (a
   * request lifecycle state, not a fourth L2 verdict), the immutable BLOCKED
   * resolution decision is recorded with its idempotency receipt, and
   * `APPROVAL_RESOLVED` is emitted. This is what makes the cycle close:
   * without it the request stayed `PENDING`, a retry with the same key minted a
   * second BLOCKED decision, and the L3 reconciler never resumed the stranded
   * assignment (l3-contract: if L2 emitted a resolution decision, use that
   * actual outcome, which may be BLOCKED).
   */
  private closeApprovalAsBlocked(input: {
    request: ApprovalRequestRecord;
    record: FinancialDecisionRecord;
    actor: TrustedActorContext;
    idempotencyKey: string;
    payloadDigest: string;
    resolvedAt: string;
  }): FinancialDecisionRecord {
    const { request, record, actor, resolvedAt } = input;

    request.status = 'APPROVAL_BLOCKED';
    request.resolvedAt = resolvedAt;
    request.resolvedByPrincipalId = actor.principalId;
    request.resolvedDecisionId = record.decisionId;

    this.store.decisions.set(record.decisionId, record);
    this.store.receipts.set(input.idempotencyKey, {
      tenantId: actor.tenantId,
      idempotencyKey: input.idempotencyKey,
      payloadDigest: input.payloadDigest,
      decisionId: record.decisionId,
      recordedAt: resolvedAt,
    });
    this.store.ledgerEvents.push({
      eventId: `evt-${randomUUID()}`,
      tenantId: actor.tenantId,
      eventType: 'APPROVAL_RESOLVED',
      payload: {
        approvalRequestId: request.approvalRequestId,
        decisionId: record.decisionId,
        action: 'APPROVE',
        outcome: 'BLOCKED',
      },
      occurredAt: resolvedAt,
    });

    return record;
  }

  private buildContextSnapshot(
    grantId: string,
    expectedWorkerId?: string
  ): TrustedFinancialContext {
    const workerGrant = this.store.grants.get(grantId);
    if (!workerGrant) {
      throw new Error(`UNKNOWN_AGENT_GRANT: ${grantId}`);
    }
    // The grant must belong to the worker named on the command. The acting
    // principal may differ: L3 delegates narrow autonomy to workers, so a
    // business principal can be the authenticated actor while the worker
    // executes under its own grant (actor tenant binding is checked at entry).
    if (expectedWorkerId !== undefined && workerGrant.workerId !== expectedWorkerId) {
      throw new Error(`GRANT_WORKER_MISMATCH: grant ${grantId} does not authorize worker ${expectedWorkerId}`);
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
