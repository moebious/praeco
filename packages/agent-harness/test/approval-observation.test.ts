import { describe, expect, it } from 'vitest';
import {
  createScenarioStore,
  buildScenarios,
  FinancialAuthorizationService,
  DEMO_TENANT_ID,
  type EnvelopeResolver,
  type ReadyInvoiceEnvelope,
  type TrustedActorContext,
} from '@praeco/financial-decision-kernel';
import { L2FinancialDecisionAdapter } from '../src/index.js';

class ScenarioResolver implements EnvelopeResolver {
  private readonly envelopes = new Map<string, ReadyInvoiceEnvelope>();

  constructor() {
    for (const s of buildScenarios()) {
      this.envelopes.set(s.envelope.envelopeId, s.envelope);
    }
  }

  public async resolveEnvelopes(
    _tenantId: string,
    envelopeIds: readonly string[]
  ): Promise<readonly ReadyInvoiceEnvelope[]> {
    return envelopeIds.map(id => {
      const env = this.envelopes.get(id);
      if (!env) throw new Error(`ENVELOPE_NOT_FOUND: ${id}`);
      return env;
    });
  }
}

describe('L3 approval observations over the L2 adapter', () => {
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

  const principal = {
    tenantId: DEMO_TENANT_ID,
    principalId: 'worker-agent-demo',
    roles: ['WorkerAgent'],
    bindingRevision: 'rev-1',
  };

  function setup() {
    const store = createScenarioStore('BLINKA-03');
    const service = new FinancialAuthorizationService(store, new ScenarioResolver());
    const adapter = new L2FinancialDecisionAdapter({
      resolveService: () => ({ service, store }),
    });
    return { store, service, adapter };
  }

  function seedWorkerGrant(service: FinancialAuthorizationService) {
    const grantId = 'grant-test-worker';
    service.store.grants.set(grantId, {
      grantId,
      grantRevisionId: 'grant-rev-test-1',
      tenantId: DEMO_TENANT_ID,
      workerId: 'worker-agent-demo',
      perPayableLimitUsd: '2500.00',
      allowedActions: ['PROPOSE_PAYABLE', 'REQUEST_SIMULATED_AUTHORIZATION'],
    });
    return grantId;
  }

  it('observes PENDING then RESOLVED with the resolving decision id, without mutating reads', async () => {
    const { service, adapter } = setup();
    const scenario = buildScenarios().find(s => s.id === 'BLINKA-03')!;
    const grantId = seedWorkerGrant(service);

    const record = await service.decideAndCommit(
      {
        proposal: { payableCaseId: 'case-obs-01', envelopeIds: [scenario.envelope.envelopeId] },
        idempotencyKey: 'idem-obs-01',
        workerId: 'worker-agent-demo',
        agentGrantRef: grantId,
      },
      workerActor
    );
    expect(record.outcome).toBe('PENDING_HUMAN_APPROVAL');

    const pending = await adapter.getApprovalStatus(record.approvalRequestId!, principal);
    expect(pending?.status).toBe('PENDING');

    const resolution = await service.resolveApproval(
      {
        approvalRequestId: record.approvalRequestId!,
        idempotencyKey: 'idem-obs-01-approve',
        action: 'APPROVE',
      },
      cfoActor
    );
    expect(resolution.outcome).toBe('AUTHORIZED_SIMULATED');

    const resolved = await adapter.getApprovalStatus(record.approvalRequestId!, principal);
    expect(resolved?.status).toBe('RESOLVED');
    if (!resolved || resolved.status !== 'RESOLVED') throw new Error('unreachable');
    expect(resolved.resolutionDecisionId).toBe(resolution.decisionId);
  });

  it('derives EXPIRED on read without mutating the stored request', async () => {
    const { store, service, adapter } = setup();
    const scenario = buildScenarios().find(s => s.id === 'BLINKA-03')!;
    const grantId = seedWorkerGrant(service);

    const record = await service.decideAndCommit(
      {
        proposal: { payableCaseId: 'case-obs-02', envelopeIds: [scenario.envelope.envelopeId] },
        idempotencyKey: 'idem-obs-02',
        workerId: 'worker-agent-demo',
        agentGrantRef: grantId,
      },
      workerActor
    );

    // Force expiry without going through the write path.
    const request = store.approvalRequests.get(record.approvalRequestId!)!;
    request.expiresAt = '2000-01-01T00:00:00.000Z';

    const observation = await adapter.getApprovalStatus(record.approvalRequestId!, principal);
    expect(observation?.status).toBe('EXPIRED');

    // The read must not have persisted a state transition.
    expect(store.approvalRequests.get(record.approvalRequestId!)!.status).toBe('PENDING');
  });
});
