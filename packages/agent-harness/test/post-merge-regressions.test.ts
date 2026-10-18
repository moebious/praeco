import { describe, expect, it, vi } from 'vitest';
import { DEMO_TENANT_ID } from '@praeco/financial-decision-kernel';
import {
  AssignmentService,
  HarnessReconciler,
  InMemoryHarnessStore,
  WorkflowRunner,
  computeInboundPayloadDigest,
  type Assignment,
  type FinancialDecisionPort,
  type OutboxEvent,
  type TrustedPrincipal,
} from '../src/index.js';

const principal: TrustedPrincipal = {
  tenantId: DEMO_TENANT_ID,
  principalId: 'regression-admin',
  roles: ['FinanceAdmin'],
  bindingRevision: 'rev-1',
};

function inbound(eventId: string, threadId = eventId) {
  const raw = {
    provider: 'EMAIL' as const,
    installationId: 'regression-installation',
    providerEventId: eventId,
    providerUserId: 'synthetic-user',
    providerThreadId: threadId,
    messageId: eventId,
    attachmentRefs: [],
  };
  return { ...raw, payloadDigest: computeInboundPayloadDigest(raw) };
}

class StrictCasStore extends InMemoryHarnessStore {
  readonly writes: Assignment[] = [];

  override async saveAssignment(assignment: Assignment, expectedVersion?: number) {
    const existing = await this.getAssignment(assignment.tenantId, assignment.assignmentId);
    if (existing && (
      expectedVersion !== existing.version ||
      assignment.version !== existing.version + 1
    )) {
      throw new Error('CONCURRENT_MODIFICATION: explicit CAS and one version increment required');
    }
    await super.saveAssignment(assignment, expectedVersion);
    this.writes.push({ ...assignment });
  }
}

function unusedDecisionPort(): FinancialDecisionPort {
  return {
    preview: vi.fn(),
    decideAndCommit: vi.fn(),
    getCommandResult: vi.fn(),
    getDecision: vi.fn(),
    getApprovalStatus: vi.fn(async () => ({ status: 'EXPIRED' as const })),
    resolveApproval: vi.fn(),
  };
}

describe('PR #29 post-merge regressions', () => {
  it.each([
    ['01', 'AUTHORIZED_SIMULATED', 'COMPLETED'],
    ['03', 'PENDING_HUMAN_APPROVAL', 'WAITING_FOR_REVIEW'],
    ['08', 'BLOCKED', 'COMPLETED'],
  ])('persists scenario %s references within its single CAS transition', async (id, outcome, state) => {
    const store = new StrictCasStore();
    const service = new AssignmentService({ store });
    const { assignment } = await service.createOrLoad(inbound(`cas-${id}`), principal);
    const runner = new WorkflowRunner({ store, service });
    const result = await runner.executeAssignmentWorkflow({
      assignmentId: assignment.assignmentId,
      triggerRunId: `regression-${id}`,
      sourceReference: `${id}.pdf`,
      requestedBudgetId: 'BUDGET-2026-10',
      scenarioId: `BLINKA-${id}`,
    }, principal);

    expect(result.outcome).toBe(outcome);
    expect(result.assignment.state).toBe(state);
    expect(result.assignment.version).toBe(6);
    expect(store.writes.map(write => write.version)).toEqual([1, 2, 3, 4, 5, 6]);
    const saved = await store.getAssignment(principal.tenantId, assignment.assignmentId);
    expect(saved).toEqual(result.assignment);
    if (state === 'WAITING_FOR_REVIEW') {
      expect(saved?.initialL2DecisionId).toBe(result.decisionId);
      expect(saved?.l2ApprovalRequestId).toBe(result.approvalRequestId);
      expect(saved?.triggerWaitToken).toBeTruthy();
    } else {
      expect(saved?.latestL2DecisionId).toBe(result.decisionId);
    }
  });

  it('uses explicit CAS when completing a suspended approval', async () => {
    const store = new StrictCasStore();
    const now = new Date().toISOString();
    await store.saveAssignment({
      assignmentId: 'resume-cas',
      tenantId: principal.tenantId,
      caseId: 'resume-case',
      agentPrincipalId: 'worker',
      requestedByPrincipalId: principal.principalId,
      state: 'WAITING_FOR_REVIEW',
      version: 1,
      ownershipEpoch: 1,
      l2ApprovalRequestId: 'approval-expired',
      triggerWaitToken: 'wait-token',
      createdAt: now,
      updatedAt: now,
    }, 0);
    const runner = new WorkflowRunner({
      store,
      service: new AssignmentService({ store }),
      decisionPort: unusedDecisionPort(),
    });
    const result = await runner.resumeAssignment({ assignmentId: 'resume-cas' }, principal);
    expect(result.assignment.state).toBe('COMPLETED');
    expect(result.assignment.version).toBe(2);
    expect(result.assignment.triggerWaitToken).toBeUndefined();
    expect(result.outcome).toBe('BLOCKED');
  });

  function reconcilerFor(store: InMemoryHarnessStore, deliverL3Event?: (event: OutboxEvent) => Promise<void>) {
    return new HarnessReconciler({
      store,
      decisionPort: unusedDecisionPort(),
      workflowRunner: new WorkflowRunner({ store, service: new AssignmentService({ store }) }),
      deliverL3Event,
    });
  }

  async function enqueue(store: InMemoryHarnessStore, id: string) {
    await store.enqueueOutbox({
      tenantId: principal.tenantId,
      eventId: id,
      eventType: 'ASSIGNMENT_QUEUED',
      commandId: id,
      payload: { assignmentId: id },
      occurredAt: new Date().toISOString(),
    });
  }

  it('does not claim or acknowledge events without a delivery handler', async () => {
    const store = new InMemoryHarnessStore();
    await enqueue(store, 'no-handler');
    const drain = vi.spyOn(store, 'drainOutbox');
    const report = await reconcilerFor(store).tick(principal.tenantId);
    expect(report.drainedOutboxCount).toBe(0);
    expect(drain).not.toHaveBeenCalled();
    expect(store.outboxEvents[0]?.dispatchedAt).toBeUndefined();
    expect(await store.drainOutbox(principal.tenantId)).toHaveLength(1);
  });

  it('acknowledges successful handlers individually and retries failures', async () => {
    const store = new InMemoryHarnessStore();
    await enqueue(store, 'retry');
    await enqueue(store, 'success');
    let fail = true;
    const delivered: string[] = [];
    const handler = vi.fn(async (event: OutboxEvent) => {
      expect(store.outboxEvents.find(row => row.eventId === event.eventId)?.dispatchedAt).toBeUndefined();
      if (event.eventId === 'retry' && fail) throw new Error('synthetic delivery failure');
      delivered.push(event.eventId);
    });
    const reconciler = reconcilerFor(store, handler);
    expect((await reconciler.tick(principal.tenantId)).drainedOutboxCount).toBe(1);
    expect(delivered).toEqual(['success']);
    expect(store.outboxEvents[0]?.dispatchedAt).toBeUndefined();
    expect(store.outboxEvents[0]?.claimExpiresAt).toBeUndefined();
    fail = false;
    expect((await reconciler.tick(principal.tenantId)).drainedOutboxCount).toBe(1);
    expect(delivered).toEqual(['success', 'retry']);
    expect(handler).toHaveBeenCalledTimes(3);
    expect((await reconciler.tick(principal.tenantId)).drainedOutboxCount).toBe(0);
  });

  it('waits for delivery acceptance before acknowledging an event', async () => {
    const store = new InMemoryHarnessStore();
    await enqueue(store, 'pending-delivery');
    let release!: () => void;
    let started!: () => void;
    const delivery = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const tick = reconcilerFor(store, async () => {
      started();
      await delivery;
    }).tick(principal.tenantId);
    await entered;
    expect(store.outboxEvents[0]?.dispatchedAt).toBeUndefined();
    release();
    expect((await tick).drainedOutboxCount).toBe(1);
    expect(store.outboxEvents[0]?.dispatchedAt).toBeDefined();
  });

  it('uses one canonical case and matching outbox payloads for distinct events on a new thread', async () => {
    const store = new InMemoryHarnessStore();
    // Both service pre-reads miss the thread; the store must resolve the winner.
    vi.spyOn(store, 'findCaseByThread').mockResolvedValue(null);
    const service = new AssignmentService({ store });
    const results = await Promise.all([
      service.createOrLoad(inbound('thread-event-a', 'new-thread'), principal),
      service.createOrLoad(inbound('thread-event-b', 'new-thread'), principal),
    ]);
    const canonical = store.threadCaseLinks.values().next().value;
    expect(new Set(results.map(result => result.assignment.caseId))).toEqual(new Set([canonical]));
    expect(store.cases.size).toBe(1);
    expect(store.outboxEvents.map(event => event.payload.caseId)).toEqual([canonical, canonical]);
  });
});
