import { describe, expect, it } from 'vitest';
import {
  createScenarioStore,
  FinancialAuthorizationService,
  DEMO_TENANT_ID,
  type EnvelopeResolver,
  type ReadyInvoiceEnvelope,
  type TrustedActorContext,
} from '../src/index.js';
import { createSyntheticEnvelope } from './helpers.js';

class InMemoryEnvelopeResolver implements EnvelopeResolver {
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

describe('L2 Slices B & C — Transactional Store, Commit, and Concurrency', () => {
  const actorWorker: TrustedActorContext = {
    tenantId: DEMO_TENANT_ID,
    principalId: 'worker-agent-demo',
    roles: ['WorkerAgent'],
  };

  const actorCFO: TrustedActorContext = {
    tenantId: DEMO_TENANT_ID,
    principalId: 'cfo-user-01',
    roles: ['FinanceAdmin'],
  };

  it('Scenario 01 through service: commits budget and creates unique obligation', async () => {
    const store = createScenarioStore('BLINKA-01');
    const resolver = new InMemoryEnvelopeResolver();
    const service = new FinancialAuthorizationService(store, resolver);

    const env = createSyntheticEnvelope({
      tenantId: DEMO_TENANT_ID,
      envelopeId: 'env-bogota-01',
      invoiceNumber: 'BOG-2026-10',
      taxId: 'CO-900.123.456-7',
      amount: '2200.00',
      currency: 'USD',
    });
    resolver.register(env);

    const command = {
      proposal: {
        payableCaseId: 'case-01',
        envelopeIds: ['env-bogota-01'],
      },
      idempotencyKey: 'idem-cmd-01',
      workerId: 'worker-agent-demo',
      agentGrantRef: 'grant-synthetic-worker',
    };

    const record = await service.decideAndCommit(command, actorWorker);
    expect(record.outcome).toBe('AUTHORIZED_SIMULATED');
    expect(record.commitmentId).not.toBeNull();

    // Verify budget committed
    const budget = store.budgets.get('BUDGET-2026-10');
    expect(budget?.committedUsd).toBe('2200');

    // Verify ledger event
    expect(store.ledgerEvents).toHaveLength(1);
    expect(store.ledgerEvents[0]?.eventType).toBe('SIMULATED_AUTHORIZATION_COMMITTED');
  });

  it('Idempotency: exact same command returns identical record without double-spending', async () => {
    const store = createScenarioStore('BLINKA-01');
    const resolver = new InMemoryEnvelopeResolver();
    const service = new FinancialAuthorizationService(store, resolver);

    const env = createSyntheticEnvelope({
      tenantId: DEMO_TENANT_ID,
      envelopeId: 'env-bogota-01',
      invoiceNumber: 'BOG-2026-10',
      taxId: 'CO-900.123.456-7',
      amount: '2200.00',
      currency: 'USD',
    });
    resolver.register(env);

    const command = {
      proposal: {
        payableCaseId: 'case-01',
        envelopeIds: ['env-bogota-01'],
      },
      idempotencyKey: 'idem-cmd-retry',
      workerId: 'worker-agent-demo',
      agentGrantRef: 'grant-synthetic-worker',
    };

    const first = await service.decideAndCommit(command, actorWorker);
    const second = await service.decideAndCommit(command, actorWorker);

    expect(second.decisionId).toBe(first.decisionId);
    expect(second.commitmentId).toBe(first.commitmentId);

    // Budget only debited once!
    const budget = store.budgets.get('BUDGET-2026-10');
    expect(budget?.committedUsd).toBe('2200');
  });

  it('Idempotency: reusing idempotencyKey with conflicting payload is rejected', async () => {
    const store = createScenarioStore('BLINKA-01');
    const resolver = new InMemoryEnvelopeResolver();
    const service = new FinancialAuthorizationService(store, resolver);

    const env1 = createSyntheticEnvelope({
      tenantId: DEMO_TENANT_ID,
      envelopeId: 'env-bogota-01',
      amount: '2200.00',
      currency: 'USD',
    });
    const env2 = createSyntheticEnvelope({
      tenantId: DEMO_TENANT_ID,
      envelopeId: 'env-bogota-02',
      amount: '1500.00',
      currency: 'USD',
    });
    resolver.register(env1);
    resolver.register(env2);

    const command1 = {
      proposal: { payableCaseId: 'case-01', envelopeIds: ['env-bogota-01'] },
      idempotencyKey: 'idem-shared-key',
      workerId: 'worker-agent-demo',
      agentGrantRef: 'grant-synthetic-worker',
    };

    const command2 = {
      proposal: { payableCaseId: 'case-02', envelopeIds: ['env-bogota-02'] },
      idempotencyKey: 'idem-shared-key', // reused with different payload!
      workerId: 'worker-agent-demo',
      agentGrantRef: 'grant-synthetic-worker',
    };

    await service.decideAndCommit(command1, actorWorker);
    await expect(service.decideAndCommit(command2, actorWorker)).rejects.toThrow(
      'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH'
    );
  });

  it('Concurrency & budget atomicity: competing decisions for $1,000 budget cannot both spend $700', async () => {
    const store = createScenarioStore('BLINKA-01');
    // Set budget limit to exactly $1,000
    const budget = store.budgets.get('BUDGET-2026-10')!;
    budget.limitUsd = '1000.00';
    budget.committedUsd = '0.00';

    const resolver = new InMemoryEnvelopeResolver();
    const service = new FinancialAuthorizationService(store, resolver);

    // Two distinct contractors with $700 contracts
    store.vendors.set('VENDOR-A', {
      vendorId: 'VENDOR-A',
      legalName: 'Vendor A',
      taxId: 'US-VENDOR-A',
      isAllowlisted: true,
      paymentAccountFingerprint: store.vendors.get('VENDOR-BOG')!.paymentAccountFingerprint,
    });
    store.contracts.set('CTR-A', {
      contractId: 'CTR-A',
      vendorId: 'VENDOR-A',
      mode: 'EXACT',
      amount: '700.00',
      currency: 'USD',
      effectiveFrom: '2026-01-01',
    });

    store.vendors.set('VENDOR-B', {
      vendorId: 'VENDOR-B',
      legalName: 'Vendor B',
      taxId: 'US-VENDOR-B',
      isAllowlisted: true,
      paymentAccountFingerprint: store.vendors.get('VENDOR-BOG')!.paymentAccountFingerprint,
    });
    store.contracts.set('CTR-B', {
      contractId: 'CTR-B',
      vendorId: 'VENDOR-B',
      mode: 'EXACT',
      amount: '700.00',
      currency: 'USD',
      effectiveFrom: '2026-01-01',
    });

    const envA = createSyntheticEnvelope({
      tenantId: DEMO_TENANT_ID,
      envelopeId: 'env-a',
      invoiceNumber: 'INV-A-1',
      taxId: 'US-VENDOR-A',
      amount: '700.00',
      currency: 'USD',
    });
    const envB = createSyntheticEnvelope({
      tenantId: DEMO_TENANT_ID,
      envelopeId: 'env-b',
      invoiceNumber: 'INV-B-1',
      taxId: 'US-VENDOR-B',
      amount: '700.00',
      currency: 'USD',
    });
    resolver.register(envA);
    resolver.register(envB);

    const cmdA = {
      proposal: { payableCaseId: 'case-a', envelopeIds: ['env-a'] },
      idempotencyKey: 'idem-race-a',
      workerId: 'worker-agent-demo',
      agentGrantRef: 'grant-synthetic-worker',
    };
    const cmdB = {
      proposal: { payableCaseId: 'case-b', envelopeIds: ['env-b'] },
      idempotencyKey: 'idem-race-b',
      workerId: 'worker-agent-demo',
      agentGrantRef: 'grant-synthetic-worker',
    };

    // Run simultaneously
    const [resA, resB] = await Promise.all([
      service.decideAndCommit(cmdA, actorWorker),
      service.decideAndCommit(cmdB, actorWorker),
    ]);

    const outcomes = [resA.outcome, resB.outcome].sort();
    expect(outcomes).toEqual(['AUTHORIZED_SIMULATED', 'BLOCKED']);

    // Total budget committed must be exactly 700, NOT 1400!
    expect(budget.committedUsd).toBe('700');
  });

  describe('Human Approval Lifecycle (Slice D)', () => {
    it('Case 03 escalation: PENDING_HUMAN_APPROVAL -> approved by FinanceAdmin -> AUTHORIZED_SIMULATED', async () => {
      const store = createScenarioStore('BLINKA-03');
      const resolver = new InMemoryEnvelopeResolver();
      const service = new FinancialAuthorizationService(store, resolver);

      const env = createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-mex-03',
        invoiceNumber: 'MEX-2026-10',
        taxId: 'MX-DESIGN-AGENCY',
        amount: '76000.00',
        currency: 'MXN',
      });
      resolver.register(env);

      const command = {
        proposal: { payableCaseId: 'case-blinka-03', envelopeIds: ['env-mex-03'] },
        idempotencyKey: 'idem-mex-cmd',
        workerId: 'worker-agent-demo',
        agentGrantRef: 'grant-synthetic-worker',
      };

      const record = await service.decideAndCommit(command, actorWorker);
      expect(record.outcome).toBe('PENDING_HUMAN_APPROVAL');
      expect(record.approvalRequestId).not.toBeNull();

      // FinanceAdmin approves
      const approvalRecord = await service.resolveApproval(
        {
          approvalRequestId: record.approvalRequestId!,
          idempotencyKey: 'idem-cfo-approve',
          action: 'APPROVE',
        },
        actorCFO
      );

      expect(approvalRecord.outcome).toBe('AUTHORIZED_SIMULATED');
      expect(approvalRecord.commitmentId).not.toBeNull();

      // Budget committed is $3,800
      const budget = store.budgets.get('BUDGET-2026-10')!;
      expect(budget.committedUsd).toBe('3800');
    });

    it('Non-FinanceAdmin actor cannot resolve approval', async () => {
      const store = createScenarioStore('BLINKA-03');
      const resolver = new InMemoryEnvelopeResolver();
      const service = new FinancialAuthorizationService(store, resolver);

      const env = createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-mex-03',
        invoiceNumber: 'MEX-2026-10',
        taxId: 'MX-DESIGN-AGENCY',
        amount: '76000.00',
        currency: 'MXN',
      });
      resolver.register(env);

      const record = await service.decideAndCommit(
        {
          proposal: { payableCaseId: 'case-blinka-03', envelopeIds: ['env-mex-03'] },
          idempotencyKey: 'idem-mex-cmd-2',
          workerId: 'worker-agent-demo',
          agentGrantRef: 'grant-synthetic-worker',
        },
        actorWorker
      );

      await expect(
        service.resolveApproval(
          {
            approvalRequestId: record.approvalRequestId!,
            idempotencyKey: 'idem-hacker-approve',
            action: 'APPROVE',
          },
          actorWorker // Worker has no FinanceAdmin role!
        )
      ).rejects.toThrow('UNAUTHORIZED_ROLE');
    });

    it('Expired approval (> 24h) fails with APPROVAL_EXPIRED', async () => {
      let currentTime = '2026-10-17T12:00:00Z';
      const store = createScenarioStore('BLINKA-03');
      const resolver = new InMemoryEnvelopeResolver();
      const service = new FinancialAuthorizationService(store, resolver, () => currentTime);

      const env = createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-mex-03',
        invoiceNumber: 'MEX-2026-10',
        taxId: 'MX-DESIGN-AGENCY',
        amount: '76000.00',
        currency: 'MXN',
      });
      resolver.register(env);

      const record = await service.decideAndCommit(
        {
          proposal: { payableCaseId: 'case-blinka-03', envelopeIds: ['env-mex-03'] },
          idempotencyKey: 'idem-mex-cmd-3',
          workerId: 'worker-agent-demo',
          agentGrantRef: 'grant-synthetic-worker',
        },
        actorWorker
      );

      // Advance time by 25 hours
      currentTime = '2026-10-18T13:00:01Z';

      await expect(
        service.resolveApproval(
          {
            approvalRequestId: record.approvalRequestId!,
            idempotencyKey: 'idem-late-approve',
            action: 'APPROVE',
          },
          actorCFO
        )
      ).rejects.toThrow('APPROVAL_EXPIRED');
    });

    it('Budget exhaustion during wait causes legitimate BLOCKED on G5 re-evaluation', async () => {
      const store = createScenarioStore('BLINKA-03');
      const resolver = new InMemoryEnvelopeResolver();
      const service = new FinancialAuthorizationService(store, resolver);

      const env = createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-mex-03',
        invoiceNumber: 'MEX-2026-10',
        taxId: 'MX-DESIGN-AGENCY',
        amount: '76000.00', // USD 3,800
        currency: 'MXN',
      });
      resolver.register(env);

      const record = await service.decideAndCommit(
        {
          proposal: { payableCaseId: 'case-blinka-03', envelopeIds: ['env-mex-03'] },
          idempotencyKey: 'idem-mex-cmd-4',
          workerId: 'worker-agent-demo',
          agentGrantRef: 'grant-synthetic-worker',
        },
        actorWorker
      );

      // During the wait, budget was spent by other obligations!
      const budget = store.budgets.get('BUDGET-2026-10')!;
      budget.committedUsd = '4000.00'; // Only $500 remains, but $3,800 needed!

      const approvalRecord = await service.resolveApproval(
        {
          approvalRequestId: record.approvalRequestId!,
          idempotencyKey: 'idem-exhausted-approve',
          action: 'APPROVE',
        },
        actorCFO
      );

      expect(approvalRecord.outcome).toBe('BLOCKED');
      expect(approvalRecord.explanation).toContain('INSUFFICIENT_PERIOD_BUDGET');
    });

    it('V-8: fails closed when agentGrantRef is unresolvable', async () => {
      const store = createScenarioStore('BLINKA-01');
      const resolver = new InMemoryEnvelopeResolver();
      const service = new FinancialAuthorizationService(store, resolver);

      const env = createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-grant-fail',
        invoiceNumber: 'BOG-2026-10',
        taxId: 'CO-900.123.456-7',
        amount: '2200.00',
        currency: 'USD',
      });
      resolver.register(env);

      await expect(
        service.decideAndCommit(
          {
            proposal: { payableCaseId: 'case-bogota-01', envelopeIds: ['env-grant-fail'] },
            idempotencyKey: 'idem-unknown-grant',
            workerId: 'worker-agent-demo',
            agentGrantRef: 'non-existent-grant',
          },
          actorWorker
        )
      ).rejects.toThrow('UNKNOWN_AGENT_GRANT: non-existent-grant');
    });

    it('V-9: rejects approval with APPROVAL_STALE when company policy revision changes during wait', async () => {
      const store = createScenarioStore('BLINKA-03');
      const resolver = new InMemoryEnvelopeResolver();
      const service = new FinancialAuthorizationService(store, resolver);

      const env = createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-mex-stale-pol',
        invoiceNumber: 'MEX-2026-10',
        taxId: 'MX-DESIGN-AGENCY',
        amount: '76000.00',
        currency: 'MXN',
      });
      resolver.register(env);

      const record = await service.decideAndCommit(
        {
          proposal: { payableCaseId: 'case-blinka-03', envelopeIds: ['env-mex-stale-pol'] },
          idempotencyKey: 'idem-mex-stale-cmd',
          workerId: 'worker-agent-demo',
          agentGrantRef: 'grant-synthetic-worker',
        },
        actorWorker
      );

      // Mutate policy revision during wait
      store.policy.policyRevisionId = 'pol-blinka-demo-v2-updated';

      await expect(
        service.resolveApproval(
          {
            approvalRequestId: record.approvalRequestId!,
            idempotencyKey: 'idem-stale-pol-approve',
            action: 'APPROVE',
          },
          actorCFO
        )
      ).rejects.toThrow('APPROVAL_STALE: Company policy revision changed');
    });

    it('V-6: Scenario 05 forwarded duplicate correctly returns G2_DUPLICATE through service', async () => {
      const store = createScenarioStore('BLINKA-05');
      const resolver = new InMemoryEnvelopeResolver();
      const service = new FinancialAuthorizationService(store, resolver);

      const env = createSyntheticEnvelope({
        tenantId: DEMO_TENANT_ID,
        envelopeId: 'env-bogota-duplicate-transport',
        invoiceNumber: 'BOG-2026-10',
        taxId: 'CO-900.123.456-7',
        amount: '2200.00',
        currency: 'USD',
      });
      resolver.register(env);

      const record = await service.decideAndCommit(
        {
          proposal: { payableCaseId: 'case-blinka-05', envelopeIds: ['env-bogota-duplicate-transport'] },
          idempotencyKey: 'idem-bogota-dup',
          workerId: 'worker-agent-demo',
          agentGrantRef: 'grant-synthetic-worker',
        },
        actorWorker
      );

      expect(record.outcome).toBe('BLOCKED');
      const g2 = record.gateChecks.find(c => c.gate === 'G2');
      expect(g2?.status).toBe('FAIL');
      expect(g2?.code).toBe('G2_DUPLICATE');
    });
  });
});
