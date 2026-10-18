import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqlFinancialStore, type CommitPayableCommand } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;

/**
 * These tests exercise the real PostgreSQL transaction boundary (ADR-003):
 * they run in CI against a postgres:16 service container and locally whenever
 * DATABASE_URL is set. Without a database they skip, keeping the offline
 * demo build green.
 */
describe.skipIf(!databaseUrl)('SQL financial store — ADR-003 transaction boundary', () => {
  let store: SqlFinancialStore;

  beforeAll(async () => {
    store = await SqlFinancialStore.connect(databaseUrl!);
  });

  afterAll(async () => {
    await store?.close();
  });

  function makeTenant(): string {
    return `tenant-${randomUUID()}`;
  }

  function makeCommand(tenantId: string, over: Partial<CommitPayableCommand> = {}): CommitPayableCommand {
    return {
      tenantId,
      decisionId: `dec-${randomUUID()}`,
      canonicalKey: `${tenantId}:CO-900.123.456-7:INV-${randomUUID()}`,
      intentDigestSha256: 'a'.repeat(64),
      amountUsd: '2200.00',
      budgetId: 'BUDGET-2026-10',
      idempotencyKey: `idem-${randomUUID()}`,
      payloadDigest: 'b'.repeat(64),
      decisionRecord: { outcome: 'AUTHORIZED_SIMULATED' },
      occurredAt: new Date().toISOString(),
      ...over,
    };
  }

  async function seedBudget(tenantId: string, limitUsd: string): Promise<void> {
    await store.seedBudget({
      tenantId,
      budgetId: 'BUDGET-2026-10',
      period: '2026-10',
      limitUsd,
    });
  }

  it('commits exactly one of two concurrent duplicate payables and debits once', async () => {
    const tenant = makeTenant();
    await seedBudget(tenant, '5000.00');

    const canonicalKey = `${tenant}:CO-900.123.456-7:INV-DUP-1`;
    const a = makeCommand(tenant, { canonicalKey, idempotencyKey: `idem-${randomUUID()}` });
    const b = makeCommand(tenant, { canonicalKey, idempotencyKey: `idem-${randomUUID()}` });

    const [resultA, resultB] = await Promise.all([
      store.commitPayable(a),
      store.commitPayable(b),
    ]);

    const statuses = [resultA.status, resultB.status].sort();
    expect(statuses).toEqual(['COMMITTED', 'DUPLICATE_OBLIGATION']);

    // The loser rolls back completely: the budget carries exactly one debit.
    expect(await store.getCommittedUsd(tenant, 'BUDGET-2026-10')).toBe('2200.00');
  });

  it('serializes concurrent distinct payables without losing or double-debiting budget', async () => {
    const tenant = makeTenant();
    await seedBudget(tenant, '5000.00');

    const amounts = ['2200.00', '1800.00', '1500.00'];
    const commands = amounts.map(amount =>
      makeCommand(tenant, { amountUsd: amount, idempotencyKey: `idem-${randomUUID()}` })
    );

    const results = await Promise.all(commands.map(c => store.commitPayable(c)));

    const committed = results.filter(r => r.status === 'COMMITTED');
    const blocked = results.filter(r => r.status === 'INSUFFICIENT_BUDGET');
    expect(committed).toHaveLength(2);
    expect(blocked).toHaveLength(1);

    // The committed total equals the two winners exactly (any pair fits).
    const winnerIds = new Set(committed.map(r => (r.status === 'COMMITTED' ? r.decisionId : null)));
    const winnerSum = commands
      .filter(c => winnerIds.has(c.decisionId))
      .reduce((acc, c) => acc + Math.round(Number(c.amountUsd) * 100), 0);
    const committedUsd = await store.getCommittedUsd(tenant, 'BUDGET-2026-10');
    expect(Math.round(Number(committedUsd) * 100)).toBe(winnerSum);
  });

  it('replays idempotently on the same key and rejects payload drift', async () => {
    const tenant = makeTenant();
    await seedBudget(tenant, '5000.00');

    const command = makeCommand(tenant);
    const first = await store.commitPayable(command);
    expect(first.status).toBe('COMMITTED');

    const replay = await store.commitPayable(command);
    expect(replay.status).toBe('IDEMPOTENT_REPLAY');
    if (replay.status === 'IDEMPOTENT_REPLAY') {
      expect(replay.decisionId).toBe(command.decisionId);
    }

    // Same key with a different payload is a hard error, never a second debit.
    await expect(
      store.commitPayable({ ...command, payloadDigest: 'c'.repeat(64) })
    ).rejects.toThrow('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');

    expect(await store.getCommittedUsd(tenant, 'BUDGET-2026-10')).toBe('2200.00');
  });

  it('blocks a payable that exceeds the remaining budget without any side effects', async () => {
    const tenant = makeTenant();
    await seedBudget(tenant, '3000.00');

    const result = await store.commitPayable(makeCommand(tenant, { amountUsd: '3800.00' }));
    expect(result.status).toBe('INSUFFICIENT_BUDGET');
    if (result.status === 'INSUFFICIENT_BUDGET') {
      expect(result.availableUsd).toBe('3000.00');
    }
    expect(await store.getCommittedUsd(tenant, 'BUDGET-2026-10')).toBe('0.00');
  });

  it('persists committed state visible to a fresh connection', async () => {
    const tenant = makeTenant();
    await seedBudget(tenant, '100.00');

    const command = makeCommand(tenant, { amountUsd: '100.00' });
    expect((await store.commitPayable(command)).status).toBe('COMMITTED');

    const other = await SqlFinancialStore.connect(databaseUrl!);
    try {
      expect(await other.getCommittedUsd(tenant, 'BUDGET-2026-10')).toBe('100.00');
    } finally {
      await other.close();
    }
  });
});
