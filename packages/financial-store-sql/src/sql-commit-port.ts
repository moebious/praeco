import type {
  AuthoritativeCommitCommand,
  AuthoritativeCommitPort,
  AuthoritativeCommitResult,
  FinancialDecisionRecord,
} from '@praeco/financial-decision-kernel';
import type { SqlFinancialStore } from './sql-store.js';

function isCommittedDecisionRecord(
  value: unknown,
  expectedDecisionId: string
): value is FinancialDecisionRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.outcome === 'AUTHORIZED_SIMULATED' &&
    record.decisionId === expectedDecisionId &&
    typeof record.tenantId === 'string' &&
    typeof record.payableId === 'string' &&
    typeof record.occurredAt === 'string' &&
    typeof record.financialContextDigest === 'string' &&
    typeof record.intentDigestSha256 === 'string' &&
    typeof record.policyRevisionId === 'string' &&
    typeof record.grantRevisionId === 'string' &&
    Array.isArray(record.gateChecks) &&
    (typeof record.commitmentId === 'string' || record.commitmentId === null) &&
    (typeof record.approvalRequestId === 'string' || record.approvalRequestId === null)
  );
}

/**
 * Adapter mapping the kernel's AuthoritativeCommitPort onto the SQL store's
 * transaction boundary. Every result carries the authoritative committed
 * total for the command's budget row so the in-memory mirror can sync
 * exactly, and idempotent replays include the persisted decision record.
 */
export class SqlCommitPort implements AuthoritativeCommitPort {
  public constructor(private readonly store: SqlFinancialStore) {}

  public async commitAuthorizedPayable(
    command: AuthoritativeCommitCommand
  ): Promise<AuthoritativeCommitResult> {
    const result = await this.store.commitPayable({
      tenantId: command.tenantId,
      decisionId: command.decisionId,
      commitmentId: command.commitmentId,
      canonicalKey: command.canonicalKey,
      intentDigestSha256: command.intentDigestSha256,
      amountUsd: command.amountUsd,
      budgetId: command.budgetId,
      idempotencyKey: command.idempotencyKey,
      payloadDigest: command.payloadDigest,
      decisionRecord: command.decisionRecord,
      occurredAt: command.occurredAt,
    });

    const budgetCommittedUsd = await this.budgetCommitted(command.tenantId, command.budgetId);

    if (result.status === 'COMMITTED') {
      return { status: 'COMMITTED', decisionId: result.decisionId, budgetCommittedUsd };
    }
    if (result.status === 'IDEMPOTENT_REPLAY') {
      const record = await this.store.getDecisionRecord(result.decisionId);
      if (!isCommittedDecisionRecord(record, result.decisionId)) {
        throw new Error('IDEMPOTENT_DECISION_RECORD_INVALID');
      }
      return {
        status: 'IDEMPOTENT_REPLAY',
        decisionId: result.decisionId,
        decisionRecord: record,
        budgetCommittedUsd,
      };
    }
    if (result.status === 'DUPLICATE_OBLIGATION') {
      return { status: 'DUPLICATE_OBLIGATION', canonicalKey: result.canonicalKey, budgetCommittedUsd };
    }
    if (result.status === 'CONFLICTING_OBLIGATION') {
      return { status: 'CONFLICTING_OBLIGATION', canonicalKey: result.canonicalKey, budgetCommittedUsd };
    }
    return { status: 'INSUFFICIENT_BUDGET', availableUsd: result.availableUsd, budgetCommittedUsd };
  }

  private async budgetCommitted(tenantId: string, budgetId: string): Promise<string | null> {
    try {
      return await this.store.getCommittedUsd(tenantId, budgetId);
    } catch {
      return null;
    }
  }
}
