import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  buildScenarios,
  createScenarioStore,
  FinancialAuthorizationService,
  DEMO_TENANT_ID,
  type EnvelopeResolver,
  type FinancialAuthorizationService as ServiceType,
  type ReadyInvoiceEnvelope,
  type ScenarioDef,
  type TrustedActorContext,
} from '@praeco/financial-decision-kernel';
import { SqlCommitPort, SqlFinancialStore } from '../src/index.js';
import { runSqlGoldenDemo } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;

class TestResolver implements EnvelopeResolver {
  private readonly envelopes = new Map<string, ReadyInvoiceEnvelope>();
  public register(envelope: ReadyInvoiceEnvelope) {
    this.envelopes.set(envelope.envelopeId, envelope);
  }
  public async resolveEnvelopes(
    tenantId: string,
    envelopeIds: readonly string[]
  ): Promise<readonly ReadyInvoiceEnvelope[]> {
    return envelopeIds.map(id => {
      const env = this.envelopes.get(id);
      if (!env || env.source.tenantId !== tenantId) {
        throw new Error(`ENVELOPE_NOT_FOUND: ${id}`);
      }
      return env;
    });
  }
}

const workerActor: TrustedActorContext = {
  tenantId: DEMO_TENANT_ID,
  principalId: 'worker-agent-demo',
  roles: ['WorkerAgent'],
};

const cfoActor: TrustedActorContext = {
  tenantId: DEMO_TENANT_ID,
  principalId: 'cfo-user-01',
  roles: ['FinanceAdmin'],
};

function uniquePayableScenario(scenario: ScenarioDef): ScenarioDef {
  const isolated = structuredClone(scenario);
  isolated.envelope.invoice.invoice.number.value += `-${randomUUID()}`;
  return isolated;
}

function serviceFor(
  scenario: ScenarioDef,
  store: SqlFinancialStore,
  budgetSuffix: string,
  options: { now?: () => string; extraEnvelopes?: readonly ReadyInvoiceEnvelope[] } = {}
): ServiceType {
  const scenarioStore = createScenarioStore(scenario.id);
  const budget = Array.from(scenarioStore.budgets.values()).find(b => b.period === '2026-10');
  if (budget) {
    budget.budgetId = `${budget.budgetId}#${budgetSuffix}`;
  }
  const resolver = new TestResolver();
  resolver.register(scenario.envelope);
  for (const envelope of options.extraEnvelopes ?? []) resolver.register(envelope);
  return new FinancialAuthorizationService(scenarioStore, resolver, options.now, new SqlCommitPort(store));
}

async function seedScenarioBudget(
  sqlStore: SqlFinancialStore,
  scenario: ScenarioDef,
  budgetSuffix: string,
  limitUsd: string
): Promise<string> {
  const scenarioStore = createScenarioStore(scenario.id);
  const budget = Array.from(scenarioStore.budgets.values()).find(b => b.period === '2026-10')!;
  const budgetId = `${budget.budgetId}#${budgetSuffix}`;
  await sqlStore.seedBudget({ tenantId: DEMO_TENANT_ID, budgetId, period: budget.period, limitUsd });
  return budgetId;
}

describe.skipIf(!databaseUrl)('kernel commit paths over the authoritative SQL backend', () => {
  let sqlStore: SqlFinancialStore;

  beforeAll(async () => {
    sqlStore = await SqlFinancialStore.connect(databaseUrl!);
  });

  afterAll(async () => {
    await sqlStore?.close();
  });

  it('runs the golden set and the HITL approval through the SQL backend with exact debits', async () => {
    const { summary, store } = await runSqlGoldenDemo(databaseUrl!);
    try {
      expect(summary.total).toBe(8);
      expect(summary.matched).toBe(8);
      expect(summary.mismatched).toEqual([]);

      // Scenario isolation: each scenario owns its own authoritative budget row.
      expect(await store.getCommittedUsd(DEMO_TENANT_ID, 'BUDGET-2026-10#BLINKA-01')).toBe('2200.00');
      expect(await store.getCommittedUsd(DEMO_TENANT_ID, 'BUDGET-2026-10#BLINKA-02')).toBe('480.00');
      // Case 03 commits through the approval path.
      expect(await store.getCommittedUsd(DEMO_TENANT_ID, 'BUDGET-2026-10#BLINKA-03')).toBe('3800.00');
      // Blocked scenarios never touch the authoritative ledger.
      expect(await store.getCommittedUsd(DEMO_TENANT_ID, 'BUDGET-2026-10#BLINKA-07')).toBe('0.00');
    } finally {
      await store.close();
    }
  }, 120_000);

  it('resolves a concurrent duplicate across two services with a single authoritative debit', async () => {
    const scenario = uniquePayableScenario(buildScenarios()[0]!);
    const budgetSuffix = `RACE-${randomUUID()}`;
    const budgetId = await seedScenarioBudget(sqlStore, scenario, budgetSuffix, '2200.00');

    const serviceA = serviceFor(scenario, sqlStore, budgetSuffix);
    const serviceB = serviceFor(scenario, sqlStore, budgetSuffix);

    const command = (key: string) => ({
      proposal: { payableCaseId: `case-race`, envelopeIds: [scenario.envelope.envelopeId] },
      idempotencyKey: key,
      workerId: 'worker-agent-demo',
      agentGrantRef: 'grant-synthetic-worker',
    });

    const [a, b] = await Promise.all([
      serviceA.decideAndCommit(command(`idem-race-a-${randomUUID()}`), workerActor),
      serviceB.decideAndCommit(command(`idem-race-b-${randomUUID()}`), workerActor),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['AUTHORIZED_SIMULATED', 'BLOCKED']);
    const loser = a.outcome === 'BLOCKED' ? a : b;
    expect(loser.gateChecks.find(c => c.gate === 'G2')?.code).toBe('G2_DUPLICATE');
    // Exactly one authoritative debit.
    expect(await sqlStore.getCommittedUsd(DEMO_TENANT_ID, budgetId)).toBe('2200.00');
  });

  it('replays an idempotent commit from SQL into a fresh in-memory service', async () => {
    const scenario = uniquePayableScenario(buildScenarios()[0]!);
    const budgetSuffix = `REPLAY-${randomUUID()}`;
    const budgetId = await seedScenarioBudget(sqlStore, scenario, budgetSuffix, '5000.00');
    const idempotencyKey = `idem-replay-${randomUUID()}`;

    const committedAt = '2026-10-18T10:00:00.000Z';
    const recoveredAt = '2026-10-18T11:00:00.000Z';
    const first = serviceFor(scenario, sqlStore, budgetSuffix, { now: () => committedAt });
    const command = {
      proposal: { payableCaseId: 'case-replay', envelopeIds: [scenario.envelope.envelopeId] },
      idempotencyKey,
      workerId: 'worker-agent-demo',
      agentGrantRef: 'grant-synthetic-worker',
    };
    const committed = await first.decideAndCommit(command, workerActor);
    expect(committed.outcome).toBe('AUTHORIZED_SIMULATED');

    // A second service with a cold in-memory store replays from the
    // authoritative backend without a second debit.
    const second = serviceFor(scenario, sqlStore, budgetSuffix, { now: () => recoveredAt });
    const replayed = await second.decideAndCommit(command, workerActor);
    expect(replayed.decisionId).toBe(committed.decisionId);
    expect(replayed.outcome).toBe('AUTHORIZED_SIMULATED');
    expect(await sqlStore.getCommittedUsd(DEMO_TENANT_ID, budgetId)).toBe('2200.00');
    // The replay is mirrored into the cold service's read paths.
    expect(second.store.decisions.get(committed.decisionId)?.outcome).toBe('AUTHORIZED_SIMULATED');
    expect(second.store.receipts.get(idempotencyKey)?.decisionId).toBe(committed.decisionId);
    expect(second.store.commitments.get(committed.commitmentId!)?.committedAt).toBe(committedAt);
    expect([...second.store.obligations.values()][0]?.authorizedAt).toBe(committedAt);
    expect(second.store.receipts.get(idempotencyKey)).toMatchObject({
      recordedAt: committedAt, recoveredAt,
    });
  });

  it('returns the original committed outcome when retry-time budget gates would now block', async () => {
    const a = uniquePayableScenario(buildScenarios()[0]!);
    const b = uniquePayableScenario(buildScenarios()[0]!);
    a.envelope.envelopeId = `env-a-${randomUUID()}`;
    b.envelope.envelopeId = `env-b-${randomUUID()}`;
    const suffix = `RECOVERY-${randomUUID()}`;
    const budgetId = await seedScenarioBudget(sqlStore, a, suffix, '5000.00');
    const command = (scenario: ScenarioDef) => ({
      proposal: { payableCaseId: `case-${scenario.envelope.envelopeId}`, envelopeIds: [scenario.envelope.envelopeId] },
      idempotencyKey: `idem-${scenario.envelope.envelopeId}`,
      workerId: 'worker-agent-demo',
      agentGrantRef: 'grant-synthetic-worker',
    });
    const first = serviceFor(a, sqlStore, suffix);
    const original = await first.decideAndCommit(command(a), workerActor);
    const second = serviceFor(b, sqlStore, suffix, { extraEnvelopes: [a.envelope] });
    expect((await second.decideAndCommit(command(b), workerActor)).outcome).toBe('AUTHORIZED_SIMULATED');
    expect([...second.store.budgets.values()][0]?.committedUsd).toBe('4400.00');
    expect(await second.decideAndCommit(command(a), workerActor)).toEqual(original);
    expect(await second.decideAndCommit(command(a), workerActor)).toEqual(original);
    expect(await sqlStore.getCommittedUsd(DEMO_TENANT_ID, budgetId)).toBe('4400.00');
    expect(second.store.receipts.get(command(a).idempotencyKey)?.decisionId).toBe(original.decisionId);
    expect(second.store.ledgerEvents).toHaveLength(2);
  });

  it('blocks a payable the authoritative backend rejects for concurrent budget exhaustion', async () => {
    const scenarioA = uniquePayableScenario(buildScenarios()[0]!); // USD 2200, exact contract
    const scenarioB = uniquePayableScenario(buildScenarios()[1]!); // USD 480, recurring tolerance
    const budgetSuffix = `EXH-${randomUUID()}`;
    // Both scenarios share ONE authoritative budget row with room for only
    // the first commit (2200 + 480 > 2600).
    const budgetIdA = `${Array.from(createScenarioStore('BLINKA-01').budgets.values()).find(b => b.period === '2026-10')!.budgetId}#${budgetSuffix}`;
    const budgetIdB = `${Array.from(createScenarioStore('BLINKA-02').budgets.values()).find(b => b.period === '2026-10')!.budgetId}#${budgetSuffix}`;
    await sqlStore.seedBudget({ tenantId: DEMO_TENANT_ID, budgetId: budgetIdA, period: '2026-10', limitUsd: '2600.00' });

    const serviceA = serviceFor(scenarioA, sqlStore, budgetSuffix);
    const serviceB = serviceFor(scenarioB, sqlStore, budgetSuffix);

    const first = await serviceA.decideAndCommit(
      {
        proposal: { payableCaseId: 'case-exh-a', envelopeIds: [scenarioA.envelope.envelopeId] },
        idempotencyKey: `idem-exh-a-${randomUUID()}`,
        workerId: 'worker-agent-demo',
        agentGrantRef: 'grant-synthetic-worker',
      },
      workerActor
    );
    expect(first.outcome).toBe('AUTHORIZED_SIMULATED');

    const second = await serviceB.decideAndCommit(
      {
        proposal: { payableCaseId: 'case-exh-b', envelopeIds: [scenarioB.envelope.envelopeId] },
        idempotencyKey: `idem-exh-b-${randomUUID()}`,
        workerId: 'worker-agent-demo',
        agentGrantRef: 'grant-synthetic-worker',
      },
      workerActor
    );
    // In-memory gates passed, but the authoritative backend revalidated and
    // rejected: the decision is BLOCKED, never authorized.
    expect(second.outcome).toBe('BLOCKED');
    expect(second.gateChecks.find(c => c.gate === 'G5')?.code).toBe('BUDGET_EXHAUSTED');
    expect(await sqlStore.getCommittedUsd(DEMO_TENANT_ID, budgetIdA)).toBe('2200.00');
    expect(budgetIdB).toBe(budgetIdA);
  });

  it('commits an approved human escalation through the SQL backend', async () => {
    const scenario = uniquePayableScenario(buildScenarios()[2]!); // BLINKA-03: PENDING_HUMAN_APPROVAL
    const budgetSuffix = `APPR-${randomUUID()}`;
    const budgetId = await seedScenarioBudget(sqlStore, scenario, budgetSuffix, '4500.00');

    const committedAt = '2026-10-18T10:00:00.000Z';
    const recoveredAt = '2026-10-18T11:00:00.000Z';
    const service = serviceFor(scenario, sqlStore, budgetSuffix, { now: () => committedAt });
    const pending = await service.decideAndCommit(
      {
        proposal: { payableCaseId: 'case-appr', envelopeIds: [scenario.envelope.envelopeId] },
        idempotencyKey: `idem-appr-${randomUUID()}`,
        workerId: 'worker-agent-demo',
        agentGrantRef: 'grant-synthetic-worker',
      },
      workerActor
    );
    expect(pending.outcome).toBe('PENDING_HUMAN_APPROVAL');

    const request = structuredClone(service.store.approvalRequests.get(pending.approvalRequestId!)!);
    const resolution = {
      approvalRequestId: pending.approvalRequestId!,
      idempotencyKey: `idem-appr-resolve-${randomUUID()}`,
      action: 'APPROVE' as const,
    };
    const approved = await service.resolveApproval(resolution, cfoActor);
    expect(approved.outcome).toBe('AUTHORIZED_SIMULATED');
    expect(approved.commitmentId).not.toBeNull();
    expect(await sqlStore.getCommittedUsd(DEMO_TENANT_ID, budgetId)).toBe('3800.00');
    const fresh = serviceFor(scenario, sqlStore, budgetSuffix, { now: () => recoveredAt });
    fresh.store.approvalRequests.set(request.approvalRequestId, request);
    fresh.store.grants.clear();
    expect(await fresh.resolveApproval(resolution, cfoActor)).toEqual(approved);
    expect(request.resolvedAt).toBe(committedAt);
    expect(fresh.store.commitments.get(approved.commitmentId!)?.committedAt).toBe(committedAt);
    expect([...fresh.store.obligations.values()][0]?.authorizedAt).toBe(committedAt);
  });

  it('rejects payload drift on a reused idempotency key at the authoritative boundary', async () => {
    const scenario = uniquePayableScenario(buildScenarios()[0]!);
    const budgetSuffix = `DRIFT-${randomUUID()}`;
    await seedScenarioBudget(sqlStore, scenario, budgetSuffix, '5000.00');
    const idempotencyKey = `idem-drift-${randomUUID()}`;

    const first = serviceFor(scenario, sqlStore, budgetSuffix);
    await first.decideAndCommit(
      {
        proposal: { payableCaseId: 'case-drift', envelopeIds: [scenario.envelope.envelopeId] },
        idempotencyKey,
        workerId: 'worker-agent-demo',
        agentGrantRef: 'grant-synthetic-worker',
      },
      workerActor
    );

    const second = serviceFor(scenario, sqlStore, budgetSuffix);
    await expect(
      second.decideAndCommit(
        {
          proposal: { payableCaseId: 'case-drift-DIFFERENT', envelopeIds: [scenario.envelope.envelopeId] },
          idempotencyKey,
          workerId: 'worker-agent-demo',
          agentGrantRef: 'grant-synthetic-worker',
        },
        workerActor
      )
    ).rejects.toThrow('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
  });
});
