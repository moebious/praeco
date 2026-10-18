import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createL1, type L1Runtime } from '@praeco/evidence-intelligence';
import {
  createScenarioStore,
  FinancialAuthorizationService,
  L1EvidenceReaderAdapter,
  DEMO_TENANT_ID,
  type TransactionalFinancialStore,
} from '@praeco/financial-decision-kernel';

import {
  InMemoryHarnessStore,
  AssignmentService,
  WorkflowRunner,
  L1EvidencePortAdapter,
  L2FinancialDecisionAdapter,
  HarnessReconciler,
  computeInboundPayloadDigest,
  type InboundMessageCommand,
  type TrustedPrincipal,
} from '../src/index.js';

describe('L3 Slice E — Authenticated Human Approval & Durable Reconciler Daemon', { timeout: 60_000 }, () => {
  let l1StorageDir: string;
  let l1: L1Runtime;
  let evidencePort: L1EvidencePortAdapter;
  let readerAdapter: L1EvidenceReaderAdapter;

  const demoSourcesRoot = new URL(
    '../../evidence-intelligence/test/fixtures/demo-day/sources/',
    import.meta.url
  );

  const PRINCIPAL_VERA: TrustedPrincipal = {
    tenantId: DEMO_TENANT_ID,
    principalId: 'worker-vera',
    roles: ['WorkerAgent'],
    bindingRevision: 'rev-1',
  };

  const PRINCIPAL_ADMIN: TrustedPrincipal = {
    tenantId: DEMO_TENANT_ID,
    principalId: 'human-finance-admin-01',
    roles: ['FinanceAdmin', 'HumanApprover'],
    bindingRevision: 'rev-1',
  };

  const PRINCIPAL_OPERATOR: TrustedPrincipal = {
    tenantId: DEMO_TENANT_ID,
    principalId: 'human-operator-01',
    roles: ['Operator'],
    bindingRevision: 'rev-1',
  };

  const PRINCIPAL_OTHER_TENANT: TrustedPrincipal = {
    tenantId: 'tenant-competitor',
    principalId: 'evil-admin-01',
    roles: ['FinanceAdmin'],
    bindingRevision: 'rev-1',
  };

  function makeInboundCommand(
    eventId: string,
    attachmentRefs: readonly string[] = []
  ): InboundMessageCommand {
    const raw = {
      provider: 'EMAIL' as const,
      installationId: 'inst-1',
      providerEventId: eventId,
      providerUserId: 'user-01',
      providerThreadId: `thread-${eventId}`,
      messageId: `msg-${eventId}`,
      text: '',
      attachmentRefs,
    };
    const payloadDigest = computeInboundPayloadDigest(raw);
    return { ...raw, payloadDigest };
  }

  function createTestEnvironment(
    harnessStore: InMemoryHarnessStore,
    scenarioStore?: TransactionalFinancialStore
  ) {
    const sStore = scenarioStore ?? createScenarioStore('BLINKA-03');
    const service = new AssignmentService({ store: harnessStore });
    const decisionPort = new L2FinancialDecisionAdapter({
      resolveService: (_tenantId: string, _scenarioId?: string) => {
        const authService = new FinancialAuthorizationService(sStore, readerAdapter);
        return { service: authService, store: sStore };
      },
    });

    const runner = new WorkflowRunner({
      store: harnessStore,
      service,
      evidencePort,
      decisionPort,
    });

    return { service, decisionPort, runner, scenarioStore: sStore };
  }

  beforeAll(async () => {
    l1StorageDir = join(tmpdir(), `praeco-l3-slice-e-${randomUUID()}`);
    l1 = await createL1({
      storageRoot: l1StorageDir,
      now: () => '2026-10-17T12:00:00Z',
    });
    evidencePort = new L1EvidencePortAdapter({ l1 });
    readerAdapter = new L1EvidenceReaderAdapter(l1.reader);
  });

  afterAll(async () => {
    try {
      await rm(l1StorageDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('1. Interactive Approval: Blinka-03 escalated to WAITING_FOR_REVIEW is approved by FinanceAdmin to AUTHORIZED_SIMULATED', async () => {
    const harnessStore = new InMemoryHarnessStore();
    const { service, decisionPort, runner } = createTestEnvironment(harnessStore);

    // 1. Ingest real 03.pdf through EvidencePort
    const pdfBytes = await readFile(new URL('03.pdf', demoSourcesRoot));
    const evRef = await evidencePort.ingestSource(
      {
        bytes: pdfBytes,
        channel: 'PDF',
        mimeType: 'application/pdf',
        displayName: '03.pdf',
      },
      {
        principal: PRINCIPAL_VERA,
        assignmentId: 'asg-e-01',
        workerPrincipalId: 'worker-vera',
        workerVersionId: 'v1.0.0',
        runId: 'run-ingest-e-01',
        ownershipEpoch: 1,
      }
    );

    const caseId = 'case-slice-e-01';
    await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
      kind: 'DOCUMENT',
      evidence: evRef,
    });

    const { assignment } = await service.createOrLoad(
      makeInboundCommand('evt-e-01', [evRef.sourceId]),
      PRINCIPAL_VERA
    );
    assignment.caseId = caseId;
    await harnessStore.saveAssignment(assignment);

    // 2. Initial execution suspends awaiting review (G6 auto-approval threshold)
    const workflowResult = await runner.executeAssignmentWorkflow(
      {
        assignmentId: assignment.assignmentId,
        triggerRunId: 'trig-e-01',
        sourceReference: caseId,
        requestedBudgetId: 'BUDGET-2026-10',
        scenarioId: 'BLINKA-03',
      },
      PRINCIPAL_VERA
    );

    expect(workflowResult.outcome).toBe('PENDING_HUMAN_APPROVAL');
    expect(workflowResult.assignment.state).toBe('WAITING_FOR_REVIEW');
    expect(workflowResult.approvalRequestId).toBeDefined();
    expect(workflowResult.assignment.triggerWaitToken).toBeDefined();

    const approvalRequestId = workflowResult.approvalRequestId!;

    // Verify observation status is PENDING
    const initialObservation = await decisionPort.getApprovalStatus(
      approvalRequestId,
      PRINCIPAL_ADMIN,
      'BLINKA-03'
    );
    expect(initialObservation?.status).toBe('PENDING');

    // 3. Authenticated FinanceAdmin approves the request
    const resolveResult = await decisionPort.resolveApproval(
      {
        approvalRequestId,
        action: 'APPROVE',
        idempotencyKey: 'idemp-approve-03',
      },
      PRINCIPAL_ADMIN,
      'BLINKA-03'
    );

    expect(resolveResult.outcome).toBe('AUTHORIZED_SIMULATED');
    expect(resolveResult.decisionId).toBeDefined();
    expect(resolveResult.decisionId).not.toBe(workflowResult.decisionId);

    // 4. Workflow resumes upon approval
    const resumeResult = await runner.resumeAssignment(
      {
        assignmentId: assignment.assignmentId,
        scenarioId: 'BLINKA-03',
      },
      PRINCIPAL_ADMIN
    );

    expect(resumeResult.assignment.state).toBe('COMPLETED');
    expect(resumeResult.outcome).toBe('AUTHORIZED_SIMULATED');
    // Financial safety: outcome is strictly AUTHORIZED_SIMULATED, never PAID
    expect(resumeResult.outcome).not.toBe('PAID');
    expect(resumeResult.assignment.triggerWaitToken).toBeUndefined();

    // Verify checkpoint stage is FINISHED
    const checkpoints = await harnessStore.getCheckpoints(DEMO_TENANT_ID, assignment.assignmentId);
    expect(checkpoints.some((c) => c.stage === 'FINISHED')).toBe(true);

    // Verify outbox has ASSIGNMENT_RESOLVED
    const outbox = await harnessStore.drainOutbox(DEMO_TENANT_ID);
    const resolvedEvent = outbox.find((e) => e.eventType === 'ASSIGNMENT_RESOLVED');
    expect(resolvedEvent).toBeDefined();
    expect(resolvedEvent?.payload.outcome).toBe('AUTHORIZED_SIMULATED');
  });

  it('2. Interactive Rejection: Blinka-03 rejected by FinanceAdmin results in BLOCKED', async () => {
    // DEMO-001: Isolated scenario replay must not share ledgers
    const harnessStore = new InMemoryHarnessStore();
    const { service, decisionPort, runner } = createTestEnvironment(harnessStore);

    const pdfBytes = await readFile(new URL('03.pdf', demoSourcesRoot));
    const evRef = await evidencePort.ingestSource(
      {
        bytes: pdfBytes,
        channel: 'PDF',
        mimeType: 'application/pdf',
        displayName: '03.pdf',
      },
      {
        principal: PRINCIPAL_VERA,
        assignmentId: 'asg-e-02',
        workerPrincipalId: 'worker-vera',
        workerVersionId: 'v1.0.0',
        runId: 'run-ingest-e-02',
        ownershipEpoch: 1,
      }
    );

    const caseId = 'case-slice-e-02';
    await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
      kind: 'DOCUMENT',
      evidence: evRef,
    });

    const { assignment } = await service.createOrLoad(
      makeInboundCommand('evt-e-02', [evRef.sourceId]),
      PRINCIPAL_VERA
    );
    assignment.caseId = caseId;
    await harnessStore.saveAssignment(assignment);

    const workflowResult = await runner.executeAssignmentWorkflow(
      {
        assignmentId: assignment.assignmentId,
        triggerRunId: 'trig-e-02',
        sourceReference: caseId,
        requestedBudgetId: 'BUDGET-2026-10',
        scenarioId: 'BLINKA-03',
      },
      PRINCIPAL_VERA
    );

    expect(workflowResult.outcome).toBe('PENDING_HUMAN_APPROVAL');
    expect(workflowResult.assignment.state).toBe('WAITING_FOR_REVIEW');
    const approvalRequestId = workflowResult.approvalRequestId!;

    // Resolve with REJECT
    const rejectResult = await decisionPort.resolveApproval(
      {
        approvalRequestId,
        action: 'REJECT',
        idempotencyKey: 'idemp-reject-03',
      },
      PRINCIPAL_ADMIN,
      'BLINKA-03'
    );

    expect(rejectResult.outcome).toBe('BLOCKED');

    // Resume assignment
    const resumeResult = await runner.resumeAssignment(
      {
        assignmentId: assignment.assignmentId,
        scenarioId: 'BLINKA-03',
      },
      PRINCIPAL_ADMIN
    );

    expect(resumeResult.assignment.state).toBe('COMPLETED');
    expect(resumeResult.outcome).toBe('BLOCKED');
  });

  it('3. Adversarial Role Check: non-FinanceAdmin cannot resolve approvals', async () => {
    const harnessStore = new InMemoryHarnessStore();
    const { decisionPort } = createTestEnvironment(harnessStore);

    // Attempt resolveApproval with Operator role
    await expect(
      decisionPort.resolveApproval(
        {
          approvalRequestId: 'dummy-appr-req',
          action: 'APPROVE',
        },
        PRINCIPAL_OPERATOR,
        'BLINKA-03'
      )
    ).rejects.toThrow(/UNAUTHORIZED_ROLE/);
  });

  it('4. Adversarial Tenant Isolation: cross-tenant actor cannot resolve approval or resume assignment', async () => {
    const harnessStore = new InMemoryHarnessStore();
    const { service, decisionPort, runner } = createTestEnvironment(harnessStore);

    const pdfBytes = await readFile(new URL('03.pdf', demoSourcesRoot));
    const evRef = await evidencePort.ingestSource(
      {
        bytes: pdfBytes,
        channel: 'PDF',
        mimeType: 'application/pdf',
        displayName: '03.pdf',
      },
      {
        principal: PRINCIPAL_VERA,
        assignmentId: 'asg-e-04',
        workerPrincipalId: 'worker-vera',
        workerVersionId: 'v1.0.0',
        runId: 'run-ingest-e-04',
        ownershipEpoch: 1,
      }
    );

    const caseId = 'case-slice-e-04';
    await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
      kind: 'DOCUMENT',
      evidence: evRef,
    });

    const { assignment } = await service.createOrLoad(
      makeInboundCommand('evt-e-04', [evRef.sourceId]),
      PRINCIPAL_VERA
    );
    assignment.caseId = caseId;
    await harnessStore.saveAssignment(assignment);

    const workflowResult = await runner.executeAssignmentWorkflow(
      {
        assignmentId: assignment.assignmentId,
        triggerRunId: 'trig-e-04',
        sourceReference: caseId,
        requestedBudgetId: 'BUDGET-2026-10',
        scenarioId: 'BLINKA-03',
      },
      PRINCIPAL_VERA
    );

    const approvalRequestId = workflowResult.approvalRequestId!;

    // Cross-tenant resolve attempt fails closed
    await expect(
      decisionPort.resolveApproval(
        {
          approvalRequestId,
          action: 'APPROVE',
        },
        PRINCIPAL_OTHER_TENANT,
        'BLINKA-03'
      )
    ).rejects.toThrow();

    // Cross-tenant resume attempt fails closed
    await expect(
      runner.resumeAssignment(
        {
          assignmentId: assignment.assignmentId,
          scenarioId: 'BLINKA-03',
        },
        PRINCIPAL_OTHER_TENANT
      )
    ).rejects.toThrow(/ASSIGNMENT_NOT_FOUND|CROSS_TENANT_ACCESS_DENIED/);
  });

  it('5. Adversarial Expiration: approval observed after 24h is evaluated as EXPIRED on read', async () => {
    const scenarioStore = createScenarioStore('BLINKA-03');
    // Seed approval request with an expiration time in the past
    const pastTime = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const expiredReq = {
      approvalRequestId: 'req-expired-01',
      tenantId: DEMO_TENANT_ID,
      payableCaseId: 'case-expired-01',
      canonicalPayableKey: 'key-expired-01',
      intentDigestSha256: 'sha256-expired',
      envelopeIds: ['env-01'],
      unroundedUsd: '3500.00',
      budgetId: 'BUDGET-2026-10',
      budgetLimitRevision: 1,
      originatingWorkerGrantRef: 'grant-nova',
      policyRevisionId: 'pol-1',
      status: 'PENDING' as const,
      createdAt: pastTime,
      expiresAt: pastTime,
      resolvedAt: null,
      resolvedByPrincipalId: null,
      resolvedDecisionId: null,
      decisionId: 'dec-expired-01',
    };
    scenarioStore.approvalRequests.set(expiredReq.approvalRequestId, expiredReq);

    const harnessStore = new InMemoryHarnessStore();
    const { decisionPort } = createTestEnvironment(harnessStore, scenarioStore);

    // Read status: derived expiry evaluates to EXPIRED on read
    const observation = await decisionPort.getApprovalStatus(
      'req-expired-01',
      PRINCIPAL_ADMIN,
      'BLINKA-03'
    );
    expect(observation?.status).toBe('EXPIRED');

    // Attempting to resolve an expired approval fails closed
    await expect(
      decisionPort.resolveApproval(
        {
          approvalRequestId: 'req-expired-01',
          action: 'APPROVE',
        },
        PRINCIPAL_ADMIN,
        'BLINKA-03'
      )
    ).rejects.toThrow(/APPROVAL_EXPIRED|APPROVAL_ALREADY_RESOLVED/);
  });

  it('6. Reconciler Duty 1: outbox draining delivers undispatched events', async () => {
    const harnessStore = new InMemoryHarnessStore();
    const { decisionPort, runner } = createTestEnvironment(harnessStore);
    const delivered: string[] = [];

    // Enqueue synthetic outbox event
    await harnessStore.enqueueOutbox({
      eventId: 'out-rec-01',
      tenantId: DEMO_TENANT_ID,
      eventType: 'ASSIGNMENT_CREATED',
      commandId: 'cmd-01',
      payload: { test: true },
      occurredAt: new Date().toISOString(),
    });

    const reconciler = new HarnessReconciler({
      store: harnessStore,
      decisionPort,
      workflowRunner: runner,
      defaultTenantId: DEMO_TENANT_ID,
      deliverL3Event: async event => { delivered.push(event.eventId); },
    });

    const report = await reconciler.tick(DEMO_TENANT_ID);
    expect(report.drainedOutboxCount).toBe(1);
    expect(delivered).toEqual(['out-rec-01']);

    // Subsequent tick sees no remaining undispatched outbox events
    const secondReport = await reconciler.tick(DEMO_TENANT_ID);
    expect(secondReport.drainedOutboxCount).toBe(0);
  });

  it('7. Reconciler Duty 2 & 3: autonomous recovery resumes suspended assignment on lost webhook / dropped callback', async () => {
    // DEMO-001: Isolated scenario replay must not share ledgers
    const harnessStore = new InMemoryHarnessStore();
    const { service, decisionPort, runner } = createTestEnvironment(harnessStore);

    const pdfBytes = await readFile(new URL('03.pdf', demoSourcesRoot));
    const evRef = await evidencePort.ingestSource(
      {
        bytes: pdfBytes,
        channel: 'PDF',
        mimeType: 'application/pdf',
        displayName: '03.pdf',
      },
      {
        principal: PRINCIPAL_VERA,
        assignmentId: 'asg-e-07',
        workerPrincipalId: 'worker-vera',
        workerVersionId: 'v1.0.0',
        runId: 'run-ingest-e-07',
        ownershipEpoch: 1,
      }
    );

    const caseId = 'case-slice-e-07';
    await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
      kind: 'DOCUMENT',
      evidence: evRef,
    });

    const { assignment } = await service.createOrLoad(
      makeInboundCommand('evt-e-07', [evRef.sourceId]),
      PRINCIPAL_VERA
    );
    assignment.caseId = caseId;
    await harnessStore.saveAssignment(assignment);

    const workflowResult = await runner.executeAssignmentWorkflow(
      {
        assignmentId: assignment.assignmentId,
        triggerRunId: 'trig-e-07',
        sourceReference: caseId,
        requestedBudgetId: 'BUDGET-2026-10',
        scenarioId: 'BLINKA-03',
      },
      PRINCIPAL_VERA
    );

    expect(workflowResult.assignment.state).toBe('WAITING_FOR_REVIEW');
    const approvalRequestId = workflowResult.approvalRequestId!;

    // Simulate approval occurring in L2 without runner resume being called (e.g. lost callback)
    await decisionPort.resolveApproval(
      {
        approvalRequestId,
        action: 'APPROVE',
        idempotencyKey: 'idemp-dropped-callback',
      },
      PRINCIPAL_ADMIN,
      'BLINKA-03'
    );

    // The assignment in store is still WAITING_FOR_REVIEW
    const storedBefore = await harnessStore.getAssignment(DEMO_TENANT_ID, assignment.assignmentId);
    expect(storedBefore?.state).toBe('WAITING_FOR_REVIEW');

    // Run Reconciler tick
    const reconciler = new HarnessReconciler({
      store: harnessStore,
      decisionPort,
      workflowRunner: runner,
      defaultTenantId: DEMO_TENANT_ID,
    });

    const tickReport = await reconciler.tick(DEMO_TENANT_ID);
    expect(tickReport.observedApprovalsCount).toBeGreaterThanOrEqual(1);
    expect(tickReport.completedAssignmentsCount).toBe(1);

    // Verify assignment was autonomously resumed and completed
    const storedAfter = await harnessStore.getAssignment(DEMO_TENANT_ID, assignment.assignmentId);
    expect(storedAfter?.state).toBe('COMPLETED');
    expect(storedAfter?.triggerWaitToken).toBeUndefined();
  });

  it('8. Resolve-before-subscribe: handles fast approval completed before waitpoint registration', async () => {
    // DEMO-001: Isolated scenario replay must not share ledgers
    const harnessStore = new InMemoryHarnessStore();
    const { service, decisionPort, runner } = createTestEnvironment(harnessStore);

    const pdfBytes = await readFile(new URL('03.pdf', demoSourcesRoot));
    const evRef = await evidencePort.ingestSource(
      {
        bytes: pdfBytes,
        channel: 'PDF',
        mimeType: 'application/pdf',
        displayName: '03.pdf',
      },
      {
        principal: PRINCIPAL_VERA,
        assignmentId: 'asg-e-08',
        workerPrincipalId: 'worker-vera',
        workerVersionId: 'v1.0.0',
        runId: 'run-ingest-e-08',
        ownershipEpoch: 1,
      }
    );

    const caseId = 'case-slice-e-08';
    await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
      kind: 'DOCUMENT',
      evidence: evRef,
    });

    const { assignment } = await service.createOrLoad(
      makeInboundCommand('evt-e-08', [evRef.sourceId]),
      PRINCIPAL_VERA
    );
    assignment.caseId = caseId;
    await harnessStore.saveAssignment(assignment);

    const workflowResult = await runner.executeAssignmentWorkflow(
      {
        assignmentId: assignment.assignmentId,
        triggerRunId: 'trig-e-08',
        sourceReference: caseId,
        requestedBudgetId: 'BUDGET-2026-10',
        scenarioId: 'BLINKA-03',
      },
      PRINCIPAL_VERA
    );

    const approvalRequestId = workflowResult.approvalRequestId!;

    // Approve
    await decisionPort.resolveApproval(
      {
        approvalRequestId,
        action: 'APPROVE',
        idempotencyKey: 'idemp-fast-appr',
      },
      PRINCIPAL_ADMIN,
      'BLINKA-03'
    );

    // Now resume
    const resumed = await runner.resumeAssignment(
      {
        assignmentId: assignment.assignmentId,
        scenarioId: 'BLINKA-03',
      },
      PRINCIPAL_ADMIN
    );

    expect(resumed.assignment.state).toBe('COMPLETED');
    expect(resumed.outcome).toBe('AUTHORIZED_SIMULATED');

    // Calling resumeAssignment again on an already completed assignment is idempotent
    const reResumed = await runner.resumeAssignment(
      {
        assignmentId: assignment.assignmentId,
        scenarioId: 'BLINKA-03',
      },
      PRINCIPAL_ADMIN
    );
    expect(reResumed.assignment.state).toBe('COMPLETED');
    expect(reResumed.outcome).toBe('AUTHORIZED_SIMULATED');
  });

  it('8b. Approval that resolves to BLOCKED during the wait is observed and the stranded Assignment resumes to COMPLETED/BLOCKED', async () => {
    // DEMO-001: Isolated scenario replay must not share ledgers
    const harnessStore = new InMemoryHarnessStore();
    const scenarioStore = createScenarioStore('BLINKA-03');
    const { service, decisionPort, runner } = createTestEnvironment(harnessStore, scenarioStore);

    const pdfBytes = await readFile(new URL('03.pdf', demoSourcesRoot));
    const evRef = await evidencePort.ingestSource(
      {
        bytes: pdfBytes,
        channel: 'PDF',
        mimeType: 'application/pdf',
        displayName: '03.pdf',
      },
      {
        principal: PRINCIPAL_VERA,
        assignmentId: 'asg-e-08b',
        workerPrincipalId: 'worker-vera',
        workerVersionId: 'v1.0.0',
        runId: 'run-ingest-e-08b',
        ownershipEpoch: 1,
      }
    );

    const caseId = 'case-slice-e-08b';
    await harnessStore.attachSourceLink(DEMO_TENANT_ID, caseId, {
      kind: 'DOCUMENT',
      evidence: evRef,
    });

    const { assignment } = await service.createOrLoad(
      makeInboundCommand('evt-e-08b', [evRef.sourceId]),
      PRINCIPAL_VERA
    );
    assignment.caseId = caseId;
    await harnessStore.saveAssignment(assignment);

    const workflowResult = await runner.executeAssignmentWorkflow(
      {
        assignmentId: assignment.assignmentId,
        triggerRunId: 'trig-e-08b',
        sourceReference: caseId,
        requestedBudgetId: 'BUDGET-2026-10',
        scenarioId: 'BLINKA-03',
      },
      PRINCIPAL_VERA
    );

    expect(workflowResult.outcome).toBe('PENDING_HUMAN_APPROVAL');
    expect(workflowResult.assignment.state).toBe('WAITING_FOR_REVIEW');
    const approvalRequestId = workflowResult.approvalRequestId!;

    // The budget was exhausted by other obligations while the request was
    // pending: a late APPROVE must be BLOCKED, not authorize (ADR-002/003).
    scenarioStore.budgets.get('BUDGET-2026-10')!.committedUsd = '4000.00';

    // Simulate the approval being processed without the synchronous resume
    // running (e.g. dropped callback): the Assignment stays WAITING_FOR_REVIEW.
    const approval = await decisionPort.resolveApproval(
      {
        approvalRequestId,
        action: 'APPROVE',
        idempotencyKey: 'idemp-blocked-approve-08b',
      },
      PRINCIPAL_ADMIN,
      'BLINKA-03'
    );
    expect(approval.outcome).toBe('BLOCKED');

    // L2 closed the lifecycle: the request is terminal, not dangling PENDING.
    const request = scenarioStore.approvalRequests.get(approvalRequestId)!;
    expect(request.status).toBe('APPROVAL_BLOCKED');
    expect(request.resolvedDecisionId).toBe(approval.decisionId);

    // L3 observes the RESOLVED-with-BLOCKED approval without mutating L2.
    const observation = await decisionPort.getApprovalStatus(
      approvalRequestId,
      PRINCIPAL_ADMIN,
      'BLINKA-03'
    );
    expect(observation?.status).toBe('RESOLVED');
    if (observation?.status !== 'RESOLVED') {
      throw new Error(`expected RESOLVED observation, got ${observation?.status}`);
    }
    expect(observation.resolutionDecisionId).toBe(approval.decisionId);

    const storedBefore = await harnessStore.getAssignment(DEMO_TENANT_ID, assignment.assignmentId);
    expect(storedBefore?.state).toBe('WAITING_FOR_REVIEW');

    // Run Reconciler tick: the stranded Assignment must resume, not hang.
    const reconciler = new HarnessReconciler({
      store: harnessStore,
      decisionPort,
      workflowRunner: runner,
      defaultTenantId: DEMO_TENANT_ID,
    });

    const tickReport = await reconciler.tick(DEMO_TENANT_ID);
    expect(tickReport.observedApprovalsCount).toBeGreaterThanOrEqual(1);
    expect(tickReport.completedAssignmentsCount).toBe(1);

    const storedAfter = await harnessStore.getAssignment(DEMO_TENANT_ID, assignment.assignmentId);
    expect(storedAfter?.state).toBe('COMPLETED');
    expect(storedAfter?.triggerWaitToken).toBeUndefined();
    expect(storedAfter?.latestL2DecisionId).toBe(approval.decisionId);

    // The resolved outcome is the actual BLOCKED verdict, never a paid outcome.
    const outbox = await harnessStore.drainOutbox(DEMO_TENANT_ID);
    const resolvedEvent = outbox.find((e) => e.eventType === 'ASSIGNMENT_RESOLVED');
    expect(resolvedEvent).toBeDefined();
    expect(resolvedEvent?.payload.outcome).toBe('BLOCKED');
  });
});
