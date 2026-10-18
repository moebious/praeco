import { describe, expect, it, vi } from 'vitest';
import {
  buildScenarios,
  createScenarioStore,
  decimal,
  FinancialAuthorizationService,
  DEMO_TENANT_ID,
  type ReadyInvoiceEnvelope,
  type TrustedActorContext,
} from '@praeco/financial-decision-kernel';
import { SqlCommitPort } from '../src/sql-commit-port.js';
import type { CommitPayableCommand, StoredCommandResult } from '../src/sql-store.js';

const committedAt = '2026-10-18T10:00:00.000Z';
const recoveredAt = '2026-10-18T11:00:00.000Z';
const worker: TrustedActorContext = {
  tenantId: DEMO_TENANT_ID, principalId: 'worker-agent-demo', roles: ['WorkerAgent'],
};
const admin: TrustedActorContext = { ...worker, principalId: 'synthetic-admin', roles: ['FinanceAdmin'] };

/** Storage-only stand-in: the real service and SqlCommitPort perform recovery. */
class DeterministicSqlStore {
  readonly commands = new Map<string, CommitPayableCommand>();
  readonly budgets = new Map<string, string>();

  private key(tenantId: string, key: string) { return JSON.stringify([tenantId, key]); }

  async commitPayable(command: CommitPayableCommand) {
    const previous = this.commands.get(this.key(command.tenantId, command.idempotencyKey));
    if (previous) {
      if (previous.payloadDigest !== command.payloadDigest) throw new Error('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
      return { status: 'IDEMPOTENT_REPLAY' as const, decisionId: previous.decisionId };
    }
    this.commands.set(this.key(command.tenantId, command.idempotencyKey), structuredClone(command));
    const key = this.key(command.tenantId, command.budgetId);
    const total = decimal(this.budgets.get(key) ?? '0').plus(command.amountUsd).toFixed(2);
    this.budgets.set(key, total);
    return { status: 'COMMITTED' as const, decisionId: command.decisionId, remainingUsd: decimal('5000').minus(total).toString() };
  }

  async getCommittedUsd(tenantId: string, budgetId: string) {
    return this.budgets.get(this.key(tenantId, budgetId)) ?? '0.00';
  }

  async getCommandResult(tenantId: string, idempotencyKey: string, payloadDigest: string): Promise<StoredCommandResult | null> {
    const command = this.commands.get(this.key(tenantId, idempotencyKey));
    if (!command) return null;
    if (command.payloadDigest !== payloadDigest) throw new Error('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
    return {
      decisionId: command.decisionId,
      commitmentId: command.commitmentId,
      decisionRecord: structuredClone(command.decisionRecord),
      canonicalKey: command.canonicalKey,
      amountUsd: command.amountUsd,
      budgetId: command.budgetId,
      budgetCommittedUsd: await this.getCommittedUsd(tenantId, command.budgetId),
    };
  }
}

function invoice(id: string, scenarioIndex = 0) {
  const scenario = buildScenarios()[scenarioIndex]!;
  const envelope = structuredClone(scenario.envelope);
  envelope.envelopeId = `env-recovery-${id}`;
  envelope.invoice.invoice.number.value = `RECOVERY-${id}`;
  return { envelope, scenarioId: scenario.id };
}

function commandFor(envelope: ReadyInvoiceEnvelope) {
  return {
    proposal: { payableCaseId: `case-${envelope.envelopeId}`, envelopeIds: [envelope.envelopeId] },
    idempotencyKey: `idem-${envelope.envelopeId}`,
    workerId: 'worker-agent-demo',
    agentGrantRef: 'grant-synthetic-worker',
  };
}

function serviceFor(db: DeterministicSqlStore, envelopes: ReadyInvoiceEnvelope[], time = committedAt, scenarioIndex = 0) {
  const store = createScenarioStore(buildScenarios()[scenarioIndex]!.id);
  const resolveEnvelopes = vi.fn(async (_tenantId: string, ids: readonly string[]) =>
    ids.map(id => {
      const envelope = envelopes.find(candidate => candidate.envelopeId === id);
      if (!envelope) throw new Error('EVIDENCE_UNAVAILABLE');
      return envelope;
    })
  );
  const port = new SqlCommitPort(db);
  const service = new FinancialAuthorizationService(store, { resolveEnvelopes }, () => time, port);
  return { service, store, resolveEnvelopes };
}

describe('durable successful-command recovery through the SQL adapter', () => {
  it('recovers invoice A after another commit updates the retrying service budget mirror', async () => {
    const db = new DeterministicSqlStore();
    const a = invoice('a').envelope;
    const b = invoice('b').envelope;
    const original = await serviceFor(db, [a]).service.decideAndCommit(commandFor(a), worker);
    const retrying = serviceFor(db, [a, b], recoveredAt);
    await retrying.service.decideAndCommit(commandFor(b), worker);
    expect([...retrying.store.budgets.values()][0]?.committedUsd).toBe('4400.00');
    retrying.resolveEnvelopes.mockClear();
    const commit = vi.spyOn(db, 'commitPayable');
    const lookup = vi.spyOn(db, 'getCommandResult');

    const result = await retrying.service.decideAndCommit(commandFor(a), worker);
    expect(result).toEqual(original);
    expect(lookup).toHaveBeenCalledOnce();
    expect(retrying.resolveEnvelopes).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(db.commands.size).toBe(2);
    expect(retrying.store.receipts.get(commandFor(a).idempotencyKey)?.decisionId).toBe(original.decisionId);
    expect([...retrying.store.budgets.values()][0]?.committedUsd).toBe('4400.00');
  });

  it('recovers without available evidence or a current grant and preserves historical timestamps', async () => {
    const db = new DeterministicSqlStore();
    const a = invoice('historical').envelope;
    const original = await serviceFor(db, [a]).service.decideAndCommit(commandFor(a), worker);
    const fresh = serviceFor(db, [], recoveredAt);
    fresh.store.grants.clear();
    const commit = vi.spyOn(db, 'commitPayable');
    expect(await fresh.service.decideAndCommit(commandFor(a), worker)).toEqual(original);
    expect(await fresh.service.decideAndCommit(commandFor(a), worker)).toEqual(original);
    expect(fresh.resolveEnvelopes).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(fresh.store.commitments.get(original.commitmentId!)?.committedAt).toBe(committedAt);
    expect([...fresh.store.obligations.values()][0]?.authorizedAt).toBe(committedAt);
    expect(fresh.store.ledgerEvents).toHaveLength(1);
    expect(fresh.store.ledgerEvents[0]?.occurredAt).toBe(committedAt);
    expect(fresh.store.receipts.get(commandFor(a).idempotencyKey)).toMatchObject({
      recordedAt: committedAt, recoveredAt,
    });
  });

  it('rejects durable payload drift before current gates or evidence are consulted', async () => {
    const db = new DeterministicSqlStore();
    const a = invoice('drift').envelope;
    await serviceFor(db, [a]).service.decideAndCommit(commandFor(a), worker);
    const fresh = serviceFor(db, [], recoveredAt);
    const command = commandFor(a);
    await expect(fresh.service.decideAndCommit({
      ...command, proposal: { ...command.proposal, payableCaseId: 'changed-case' },
    }, worker)).rejects.toThrow('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
    expect(fresh.resolveEnvelopes).not.toHaveBeenCalled();
    expect(fresh.store.receipts.size).toBe(0);
  });

  it('does not require mutable budget context to read committed history', async () => {
    const db = new DeterministicSqlStore();
    const a = invoice('missing-budget-context').envelope;
    const original = await serviceFor(db, [a]).service.decideAndCommit(commandFor(a), worker);
    const stored = [...db.commands.values()][0]!;
    const snapshot = await db.getCommandResult(stored.tenantId, stored.idempotencyKey, stored.payloadDigest);
    vi.spyOn(db, 'getCommandResult').mockResolvedValue({ ...snapshot!, budgetCommittedUsd: null });
    const fresh = serviceFor(db, [], recoveredAt);
    fresh.store.budgets.clear();
    fresh.store.grants.clear();
    expect(await fresh.service.decideAndCommit(commandFor(a), worker)).toEqual(original);
    expect(fresh.store.commitments.get(original.commitmentId!)?.committedAt).toBe(committedAt);
  });

  it('does not treat a durable miss as permission to issue a new action', async () => {
    const db = new DeterministicSqlStore();
    const a = invoice('new-action').envelope;
    const fresh = serviceFor(db, [a]);
    fresh.store.grants.get('grant-synthetic-worker')!.allowedActions = [];
    const commit = vi.spyOn(db, 'commitPayable');
    const result = await fresh.service.decideAndCommit(commandFor(a), worker);
    expect(result.outcome).toBe('BLOCKED');
    expect(commit).not.toHaveBeenCalled();
    expect(db.commands.size).toBe(0);
  });

  it('prefers a durable successful result over locally cached non-commit state', async () => {
    const db = new DeterministicSqlStore();
    const a = invoice('cached-block').envelope;
    const blocked = serviceFor(db, [a], recoveredAt);
    [...blocked.store.budgets.values()][0]!.committedUsd = '5000.00';
    expect((await blocked.service.decideAndCommit(commandFor(a), worker)).outcome).toBe('BLOCKED');
    const original = await serviceFor(db, [a]).service.decideAndCommit(commandFor(a), worker);
    blocked.resolveEnvelopes.mockClear();
    expect(await blocked.service.decideAndCommit(commandFor(a), worker)).toEqual(original);
    expect(blocked.resolveEnvelopes).not.toHaveBeenCalled();
    expect(blocked.store.receipts.get(commandFor(a).idempotencyKey)?.decisionId).toBe(original.decisionId);
  });

  it('rejects cross-tenant retries before durable reads and fails closed on lookup errors', async () => {
    const db = new DeterministicSqlStore();
    const a = invoice('protected').envelope;
    const fresh = serviceFor(db, [a]);
    const lookup = vi.spyOn(db, 'getCommandResult').mockRejectedValue(new Error('LOOKUP_UNAVAILABLE'));
    await expect(fresh.service.decideAndCommit(commandFor(a), { ...worker, tenantId: 'other-tenant' }))
      .rejects.toThrow('TENANT_ID_MISMATCH');
    expect(lookup).not.toHaveBeenCalled();
    await expect(fresh.service.decideAndCommit(commandFor(a), worker)).rejects.toThrow('LOOKUP_UNAVAILABLE');
    expect(fresh.resolveEnvelopes).not.toHaveBeenCalled();
  });

  it('recovers a committed approval before loading an absent pending request', async () => {
    const db = new DeterministicSqlStore();
    const a = invoice('approval', 2).envelope;
    const first = serviceFor(db, [a], committedAt, 2);
    const pending = await first.service.decideAndCommit(commandFor(a), worker);
    const resolution = {
      approvalRequestId: pending.approvalRequestId!, idempotencyKey: 'approval-resolution', action: 'APPROVE' as const,
    };
    const original = await first.service.resolveApproval(resolution, admin);
    const fresh = serviceFor(db, [], recoveredAt, 2);
    const commit = vi.spyOn(db, 'commitPayable');
    const lookup = vi.spyOn(db, 'getCommandResult');
    await expect(fresh.service.resolveApproval(resolution, worker)).rejects.toThrow('UNAUTHORIZED_ROLE');
    expect(lookup).not.toHaveBeenCalled();
    expect(await fresh.service.resolveApproval(resolution, admin)).toEqual(original);
    expect(fresh.resolveEnvelopes).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(fresh.store.commitments.get(original.commitmentId!)?.committedAt).toBe(committedAt);
    expect([...fresh.store.obligations.values()][0]?.authorizedAt).toBe(committedAt);
  });

  it('uses persisted timestamps when the preflight misses but the commit transaction observes a replay', async () => {
    const db = new DeterministicSqlStore();
    const a = invoice('commit-race').envelope;
    const original = await serviceFor(db, [a]).service.decideAndCommit(commandFor(a), worker);
    const fresh = serviceFor(db, [a], recoveredAt);
    // A current structural revision must not replace historical commit metadata.
    const revisedBudget = [...fresh.store.budgets.values()][0]!;
    const originalBudgetId = revisedBudget.budgetId;
    revisedBudget.budgetId = 'CURRENT-REVISED-BUDGET';
    vi.spyOn(db, 'getCommandResult').mockResolvedValueOnce(null);
    expect(await fresh.service.decideAndCommit(commandFor(a), worker)).toEqual(original);
    expect(fresh.store.commitments.get(original.commitmentId!)?.committedAt).toBe(committedAt);
    expect([...fresh.store.obligations.values()][0]?.authorizedAt).toBe(committedAt);
    expect(fresh.store.commitments.get(original.commitmentId!)?.budgetId).toBe(originalBudgetId);
    expect(revisedBudget.committedUsd).toBe('0.00');
  });

  it('preserves approval history when the commit transaction observes a replay after a preflight miss', async () => {
    const db = new DeterministicSqlStore();
    const a = invoice('approval-race', 2).envelope;
    const first = serviceFor(db, [a], committedAt, 2);
    const pending = await first.service.decideAndCommit(commandFor(a), worker);
    const request = structuredClone(first.store.approvalRequests.get(pending.approvalRequestId!)!);
    const command = {
      approvalRequestId: request.approvalRequestId, idempotencyKey: 'approval-race-resolution', action: 'APPROVE' as const,
    };
    const original = await first.service.resolveApproval(command, admin);
    const fresh = serviceFor(db, [a], recoveredAt, 2);
    fresh.store.approvalRequests.set(request.approvalRequestId, request);
    vi.spyOn(db, 'getCommandResult').mockResolvedValueOnce(null);
    expect(await fresh.service.resolveApproval(command, admin)).toEqual(original);
    expect(request.resolvedAt).toBe(committedAt);
    expect(fresh.store.commitments.get(original.commitmentId!)?.committedAt).toBe(committedAt);
    expect([...fresh.store.obligations.values()][0]?.authorizedAt).toBe(committedAt);
    expect(fresh.store.receipts.get(command.idempotencyKey)).toMatchObject({
      recordedAt: committedAt, recoveredAt,
    });
  });

  it('rejects malformed or cross-tenant persisted decisions without caching an outcome', async () => {
    const db = new DeterministicSqlStore();
    const a = invoice('invalid-record').envelope;
    const original = await serviceFor(db, [a]).service.decideAndCommit(commandFor(a), worker);
    const stored = [...db.commands.values()][0]!;
    for (const decisionRecord of [
      null,
      { ...original, tenantId: 'other-tenant' },
      { ...original, commitmentId: 'wrong-commitment' },
      { ...original, approvalRequestId: 'wrong-approval' },
    ]) {
      stored.decisionRecord = decisionRecord;
      const fresh = serviceFor(db, [], recoveredAt);
      await expect(fresh.service.decideAndCommit(commandFor(a), worker))
        .rejects.toThrow('IDEMPOTENT_DECISION_RECORD_INVALID');
      expect(fresh.resolveEnvelopes).not.toHaveBeenCalled();
      expect(fresh.store.receipts.size).toBe(0);
    }
  });
});
