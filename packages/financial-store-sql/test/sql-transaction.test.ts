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
    // Independent pools must safely initialize a fresh schema concurrently.
    const results = await Promise.allSettled([
      SqlFinancialStore.connect(databaseUrl!),
      SqlFinancialStore.connect(databaseUrl!),
    ]);
    const stores = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      await Promise.all(stores.map(opened => opened.close()));
      throw failure.reason;
    }
    store = stores[0]!;
    await stores[1]!.close();
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
      commitmentId: `cmt-${randomUUID()}`,
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
    // The first commit consumes the full budget. The second must still report
    // the higher-priority duplicate gate, not budget exhaustion.
    await seedBudget(tenant, '2200.00');

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

  it('reads durable command outcomes with tenant scoping and payload validation', async () => {
    const tenant = makeTenant();
    await seedBudget(tenant, '5000.00');
    const command = makeCommand(tenant);
    expect(await store.getCommandResult(tenant, command.idempotencyKey, command.payloadDigest)).toBeNull();
    await store.commitPayable(command);
    const result = await store.getCommandResult(tenant, command.idempotencyKey, command.payloadDigest);
    expect(result).toMatchObject({
      decisionId: command.decisionId,
      commitmentId: command.commitmentId,
      canonicalKey: command.canonicalKey,
      amountUsd: '2200.00',
      budgetId: command.budgetId,
      budgetCommittedUsd: '2200.00',
      decisionRecord: command.decisionRecord,
    });
    expect(await store.getCommandResult(makeTenant(), command.idempotencyKey, command.payloadDigest)).toBeNull();
    await expect(store.getCommandResult(tenant, command.idempotencyKey, 'c'.repeat(64)))
      .rejects.toThrow('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
    expect(await store.getCommittedUsd(tenant, command.budgetId)).toBe('2200.00');
  });

  it('fails closed on an incomplete durable outcome instead of returning an unrecorded command', async () => {
    const tenant = makeTenant();
    await seedBudget(tenant, '5000.00');
    // Model a corrupted historical JSON snapshot using this storage-only API.
    const command = makeCommand(tenant, { decisionRecord: null });
    await store.commitPayable(command);
    await expect(store.getCommandResult(tenant, command.idempotencyKey, command.payloadDigest))
      .rejects.toThrow('DURABLE_COMMAND_RESULT_INCOMPLETE');
    expect(await store.getCommittedUsd(tenant, command.budgetId)).toBe('2200.00');
  });

  it('serializes concurrent retries with the same idempotency key as one commit and one replay', async () => {
    const tenant = makeTenant();
    await seedBudget(tenant, '5000.00');
    const command = makeCommand(tenant);

    const results = await Promise.all([
      store.commitPayable(command),
      store.commitPayable(command),
    ]);

    expect(results.map(result => result.status).sort()).toEqual([
      'COMMITTED',
      'IDEMPOTENT_REPLAY',
    ]);
    const decisionIds = results.map(result =>
      result.status === 'COMMITTED' || result.status === 'IDEMPOTENT_REPLAY'
        ? result.decisionId
        : null
    );
    expect(decisionIds[0]).toBe(decisionIds[1]);
    expect(await store.getCommittedUsd(tenant, 'BUDGET-2026-10')).toBe('2200.00');
  });

  it('rejects concurrent payload drift for a reused idempotency key', async () => {
    const tenant = makeTenant();
    await seedBudget(tenant, '5000.00');
    const command = makeCommand(tenant);
    const changedPayload = { ...command, payloadDigest: 'c'.repeat(64) };

    const results = await Promise.allSettled([
      store.commitPayable(command),
      store.commitPayable(changedPayload),
    ]);
    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toHaveProperty(
      'message',
      'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH'
    );
    expect(await store.getCommittedUsd(tenant, 'BUDGET-2026-10')).toBe('2200.00');
  });

  it('classifies a concurrent conflicting intent separately from an exact duplicate', async () => {
    const tenant = makeTenant();
    await seedBudget(tenant, '2200.00');
    const canonicalKey = `${tenant}:CO-900.123.456-7:INV-CONFLICT-1`;
    const first = makeCommand(tenant, { canonicalKey });
    const conflict = makeCommand(tenant, {
      canonicalKey,
      intentDigestSha256: 'c'.repeat(64),
    });

    const results = await Promise.all([
      store.commitPayable(first),
      store.commitPayable(conflict),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([
      'COMMITTED',
      'CONFLICTING_OBLIGATION',
    ]);
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
