import { describe, expect, it } from 'vitest';
import {
  createScenarioStore,
  FinancialAuthorizationService,
  DEMO_TENANT_ID,
  type EnvelopeResolver,
  type FinancialDecisionRecord,
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

/** Creates a fresh scenario-03 service with a PENDING human-approval request. */
async function createPendingApproval(): Promise<{
  store: ReturnType<typeof createScenarioStore>;
  service: FinancialAuthorizationService;
  record: FinancialDecisionRecord;
}> {
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
      proposal: { payableCaseId: 'case-corr-03', envelopeIds: ['env-mex-03'] },
      idempotencyKey: 'idem-corr-03',
      workerId: 'worker-agent-demo',
      agentGrantRef: 'grant-synthetic-worker',
    },
    actorWorker
  );
  if (record.outcome !== 'PENDING_HUMAN_APPROVAL') {
    throw new Error(`setup failed: expected PENDING_HUMAN_APPROVAL, got ${record.outcome}`);
  }
  return { store, service, record };
}

describe('L2 correctness regressions — G2 classification, budget staleness, vendor ambiguity', () => {
  it('classifies a byte-identical re-submission of an authorized invoice as G2_DUPLICATE, not G2_CONFLICT', async () => {
    const store = createScenarioStore('BLINKA-01');
    const resolver = new InMemoryEnvelopeResolver();
    const service = new FinancialAuthorizationService(store, resolver);

    const env = createSyntheticEnvelope({
      tenantId: DEMO_TENANT_ID,
      envelopeId: 'env-bog-corr-01',
      invoiceNumber: 'BOG-2026-10',
      taxId: 'CO-900.123.456-7',
      amount: '2200.00',
      currency: 'USD',
    });
    resolver.register(env);

    const command = {
      proposal: { payableCaseId: 'case-corr-01', envelopeIds: ['env-bog-corr-01'] },
      idempotencyKey: 'idem-corr-01',
      workerId: 'worker-agent-demo',
      agentGrantRef: 'grant-synthetic-worker',
    };

    const first = await service.decideAndCommit(command, actorWorker);
    expect(first.outcome).toBe('AUTHORIZED_SIMULATED');

    // Same envelope, different idempotency key and case id: a business duplicate.
    const second = await service.decideAndCommit(
      {
        ...command,
        proposal: { ...command.proposal, payableCaseId: 'case-corr-01-repeat' },
        idempotencyKey: 'idem-corr-01-repeat',
      },
      actorWorker
    );

    expect(second.outcome).toBe('BLOCKED');
    const g2 = second.gateChecks.find(c => c.gate === 'G2');
    expect(g2?.code).toBe('G2_DUPLICATE');
  });

  it('keeps a pending approval valid when other spending only advances the spend counter', async () => {
    const { service, store, record } = await createPendingApproval();

    // Other obligations spent budget during the wait: the spend counter moves,
    // but the limit entry itself is structurally unchanged. $500 spent still
    // leaves $4,000 of the $4,500 limit for this $3,800 approval.
    const budget = store.budgets.get('BUDGET-2026-10')!;
    budget.committedUsd = '500.00';
    budget.revision += 1;

    const approvalRecord = await service.resolveApproval(
      {
        approvalRequestId: record.approvalRequestId!,
        idempotencyKey: 'idem-corr-spend-ok',
        action: 'APPROVE',
      },
      actorCFO
    );

    expect(approvalRecord.outcome).toBe('AUTHORIZED_SIMULATED');
  });

  it('invalidates a pending approval when the budget limit itself is structurally revised', async () => {
    const { service, store, record } = await createPendingApproval();

    // The company raises the limit mid-wait: the approval was grounded in the
    // previous budget envelope, so it must go stale even though more money is
    // now available.
    const budget = store.budgets.get('BUDGET-2026-10')!;
    budget.limitUsd = '9000.00';
    budget.limitRevision += 1;

    await expect(
      service.resolveApproval(
        {
          approvalRequestId: record.approvalRequestId!,
          idempotencyKey: 'idem-corr-limit-stale',
          action: 'APPROVE',
        },
        actorCFO
      )
    ).rejects.toThrow('APPROVAL_STALE');
  });

  it('fails closed when two allowlisted vendors share the same canonical tax ID', async () => {
    const store = createScenarioStore('BLINKA-01');
    const resolver = new InMemoryEnvelopeResolver();
    const service = new FinancialAuthorizationService(store, resolver);

    // Corrupt the directory: a second allowlisted entry with the same tax ID.
    const original = store.vendors.get('VENDOR-BOG')!;
    store.vendors.set('VENDOR-BOG-CLONE', {
      ...original,
      vendorId: 'VENDOR-BOG-CLONE',
      legalName: 'Bogotá Contractor Clone LLC',
    });

    const env = createSyntheticEnvelope({
      tenantId: DEMO_TENANT_ID,
      envelopeId: 'env-bog-corr-02',
      invoiceNumber: 'BOG-2026-10',
      taxId: 'CO-900.123.456-7',
      amount: '2200.00',
      currency: 'USD',
    });
    resolver.register(env);

    const record = await service.decideAndCommit(
      {
        proposal: { payableCaseId: 'case-corr-02', envelopeIds: ['env-bog-corr-02'] },
        idempotencyKey: 'idem-corr-02',
        workerId: 'worker-agent-demo',
        agentGrantRef: 'grant-synthetic-worker',
      },
      actorWorker
    );

    expect(record.outcome).toBe('BLOCKED');
    const g3 = record.gateChecks.find(c => c.gate === 'G3');
    expect(g3?.code).toBe('VENDOR_DIRECTORY_AMBIGUOUS');
  });
});
