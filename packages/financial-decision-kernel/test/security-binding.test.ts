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
      proposal: { payableCaseId: 'case-sec-03', envelopeIds: ['env-mex-03'] },
      idempotencyKey: 'idem-sec-03',
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

describe('L2 security bindings — worker/grant identity, tenant isolation, approval re-checks', () => {
  it('rejects a command whose workerId is not the worker bound to the grant', async () => {
    const store = createScenarioStore('BLINKA-01');
    const resolver = new InMemoryEnvelopeResolver();
    const service = new FinancialAuthorizationService(store, resolver);

    const env = createSyntheticEnvelope({
      tenantId: DEMO_TENANT_ID,
      envelopeId: 'env-bog-sec-01',
      invoiceNumber: 'BOG-2026-10',
      taxId: 'CO-900.123.456-7',
      amount: '2200.00',
      currency: 'USD',
    });
    resolver.register(env);

    await expect(
      service.decideAndCommit(
        {
          proposal: { payableCaseId: 'case-sec-01', envelopeIds: ['env-bog-sec-01'] },
          idempotencyKey: 'idem-sec-impostor',
          workerId: 'worker-agent-impostor',
          agentGrantRef: 'grant-synthetic-worker',
        },
        actorWorker
      )
    ).rejects.toThrow('GRANT_WORKER_MISMATCH');

    // Nothing may be committed after the failed attempt.
    expect(store.commitments.size).toBe(0);
  });

  it('rejects a preview whose acting principal is not the worker bound to the grant', async () => {
    const store = createScenarioStore('BLINKA-01');
    const resolver = new InMemoryEnvelopeResolver();
    const service = new FinancialAuthorizationService(store, resolver);

    const env = createSyntheticEnvelope({
      tenantId: DEMO_TENANT_ID,
      envelopeId: 'env-bog-sec-02',
      invoiceNumber: 'BOG-2026-10',
      taxId: 'CO-900.123.456-7',
      amount: '2200.00',
      currency: 'USD',
    });
    resolver.register(env);

    await expect(
      service.preview(
        {
          proposal: { payableCaseId: 'case-sec-02', envelopeIds: ['env-bog-sec-02'] },
          idempotencyKey: 'idem-sec-preview',
          workerId: 'worker-agent-demo',
          agentGrantRef: 'grant-synthetic-worker',
        },
        { tenantId: DEMO_TENANT_ID, principalId: 'principal-someone-else', roles: ['WorkerAgent'] }
      )
    ).rejects.toThrow('GRANT_PRINCIPAL_MISMATCH');
  });

  it('rejects approval resolution by a FinanceAdmin from a foreign tenant', async () => {
    const { service, record } = await createPendingApproval();

    await expect(
      service.resolveApproval(
        {
          approvalRequestId: record.approvalRequestId!,
          idempotencyKey: 'idem-sec-foreign-cfo',
          action: 'APPROVE',
        },
        { tenantId: 'tenant-foreign', principalId: 'cfo-foreign', roles: ['FinanceAdmin'] }
      )
    ).rejects.toThrow('TENANT_ID_MISMATCH');
  });

  it('rejects approval resolution when the approval request row belongs to a foreign tenant', async () => {
    const { service, store, record } = await createPendingApproval();

    // Simulate a corrupted or cross-tenant request row.
    const request = store.approvalRequests.get(record.approvalRequestId!)!;
    request.tenantId = 'tenant-foreign';

    await expect(
      service.resolveApproval(
        {
          approvalRequestId: record.approvalRequestId!,
          idempotencyKey: 'idem-sec-row-tenant',
          action: 'APPROVE',
        },
        actorCFO
      )
    ).rejects.toThrow('APPROVAL_TENANT_MISMATCH');
  });

  it('blocks approval when the grant lost the authorization action during the wait (G6 enforced)', async () => {
    const { service, store, record } = await createPendingApproval();

    // Revoke REQUEST_SIMULATED_AUTHORIZATION while the request is pending.
    const grant = store.grants.get('grant-synthetic-worker')!;
    (grant.allowedActions as ('PROPOSE_PAYABLE' | 'REQUEST_SIMULATED_AUTHORIZATION')[]).splice(0);

    const approvalRecord = await service.resolveApproval(
      {
        approvalRequestId: record.approvalRequestId!,
        idempotencyKey: 'idem-sec-g6-revoke',
        action: 'APPROVE',
      },
      actorCFO
    );

    // The human approval must NOT bypass the now-failing G6 gate.
    expect(approvalRecord.outcome).toBe('BLOCKED');
    expect(
      approvalRecord.gateChecks.some(c => c.status === 'FAIL' && c.code === 'GRANT_ACTION_NOT_PERMITTED')
    ).toBe(true);
    expect(approvalRecord.commitmentId).toBeNull();
    expect(store.commitments.size).toBe(0);
  });
});
