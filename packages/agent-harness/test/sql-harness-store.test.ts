import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SqlHarnessStore,
  AssignmentService,
  computeInboundPayloadDigest,
  type Assignment,
  type CaseSourceLink,
  type Checkpoint,
  type ExternalPrincipalBinding,
  type FinancialDecisionReference,
  type FinancialIntentReference,
  type InboundMessageCommand,
  type LinkingChallenge,
  type OutboxEvent,
  type TrustedPrincipal,
} from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;

/**
 * Live integration tests for SqlHarnessStore against PostgreSQL / Neon (ADR-004, ADR-007).
 * When DATABASE_URL is set, tests execute real database transactions and CAS guards.
 * When DATABASE_URL is unset, tests skip cleanly to keep offline CI builds green.
 */
describe.skipIf(!databaseUrl)('SqlHarnessStore — Neon PostgreSQL operational boundary', () => {
  let store: SqlHarnessStore;

  beforeAll(async () => {
    store = await SqlHarnessStore.connect(databaseUrl!);
  });

  afterAll(async () => {
    await store?.close();
  });

  function makeTenant(): string {
    return `tenant-${randomUUID()}`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Principal Bindings & Revocation
  // ─────────────────────────────────────────────────────────────────────────────
  it('1. registers, queries, and revokes principal bindings', async () => {
    const tenant = makeTenant();
    const binding: ExternalPrincipalBinding = {
      tenantId: tenant,
      provider: 'TELEGRAM',
      installationId: 'tg-bot-neon',
      providerUserId: 'tg-user-12345',
      principalId: 'cfo-alice',
      roles: ['FinanceAdmin', 'APReviewer'],
      bindingRevision: 'rev-1',
      revoked: false,
    };

    await store.registerPrincipalBinding(binding);

    const loaded = await store.getPrincipalBinding(
      tenant,
      'TELEGRAM',
      'tg-bot-neon',
      'tg-user-12345'
    );
    expect(loaded).not.toBeNull();
    expect(loaded?.principalId).toBe('cfo-alice');
    expect(loaded?.roles).toEqual(['FinanceAdmin', 'APReviewer']);
    expect(loaded?.revoked).toBe(false);

    const byUser = await store.findPrincipalBindingsByUser(
      'TELEGRAM',
      'tg-bot-neon',
      'tg-user-12345'
    );
    expect(byUser.length).toBeGreaterThanOrEqual(1);
    expect(byUser.some((b) => b.tenantId === tenant)).toBe(true);

    // Revocation
    await store.revokePrincipalBinding(
      tenant,
      'TELEGRAM',
      'tg-bot-neon',
      'tg-user-12345'
    );
    const revoked = await store.getPrincipalBinding(
      tenant,
      'TELEGRAM',
      'tg-bot-neon',
      'tg-user-12345'
    );
    expect(revoked?.revoked).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Linking Challenge Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────
  it('2. creates, queries, and consumes linking challenges', async () => {
    const tenant = makeTenant();
    const token = `link-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 600_000).toISOString();

    const challenge: LinkingChallenge = {
      token,
      tenantId: tenant,
      principalId: 'cfo-alice',
      roles: ['FinanceAdmin'],
      provider: 'TELEGRAM',
      installationId: 'tg-bot-neon',
      expiresAt,
    };

    await store.saveLinkingChallenge(challenge);

    const loaded = await store.getLinkingChallenge(token);
    expect(loaded).not.toBeNull();
    expect(loaded?.token).toBe(token);
    expect(loaded?.tenantId).toBe(tenant);
    expect(loaded?.consumedAt).toBeUndefined();

    // Consume challenge
    const consumedAt = new Date().toISOString();
    await store.saveLinkingChallenge({
      ...challenge,
      consumedAt,
      consumedByUserId: 'tg-alice-777',
    });

    const consumed = await store.getLinkingChallenge(token);
    expect(consumed?.consumedAt).toBeDefined();
    expect(consumed?.consumedByUserId).toBe('tg-alice-777');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Technical Inbound Event Idempotency
  // ─────────────────────────────────────────────────────────────────────────────
  it('3. enforces technical inbound event idempotency', async () => {
    const tenant = makeTenant();
    const receipt = {
      receiptId: `rcpt-${randomUUID()}`,
      tenantId: tenant,
      provider: 'EMAIL' as const,
      installationId: 'mail-mx-neon',
      providerEventId: 'evt-email-neon-1',
      payloadDigest: 'digest-sha256-original',
      assignmentId: `asg-${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };

    await store.recordInboundReceipt(receipt);

    const loaded = await store.getInboundReceipt(
      tenant,
      'EMAIL',
      'mail-mx-neon',
      'evt-email-neon-1'
    );
    expect(loaded).not.toBeNull();
    expect(loaded?.payloadDigest).toBe('digest-sha256-original');
    expect(loaded?.assignmentId).toBe(receipt.assignmentId);

    // Duplicate arrival with ON CONFLICT DO NOTHING
    await store.recordInboundReceipt({
      ...receipt,
      payloadDigest: 'digest-sha256-ignored',
    });

    const reloaded = await store.getInboundReceipt(
      tenant,
      'EMAIL',
      'mail-mx-neon',
      'evt-email-neon-1'
    );
    expect(reloaded?.payloadDigest).toBe('digest-sha256-original');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Case & Thread Linking with Monotonic Versioning
  // ─────────────────────────────────────────────────────────────────────────────
  it('4. persists cases, source links, and thread correlations with monotonic versioning', async () => {
    const tenant = makeTenant();
    const caseId = `case-${randomUUID()}`;

    await store.saveCase({
      caseId,
      tenantId: tenant,
      sourceLinks: [],
      version: 1,
    });

    await store.linkThreadToCase(
      tenant,
      'TELEGRAM',
      'tg-bot-neon',
      'thread-101',
      caseId
    );

    const resolvedCaseId = await store.findCaseByThread(
      tenant,
      'TELEGRAM',
      'tg-bot-neon',
      'thread-101'
    );
    expect(resolvedCaseId).toBe(caseId);

    // Attach source link
    const link: CaseSourceLink = {
      kind: 'ERP_REFERENCE',
      refId: 'erp-inv-999',
    };
    const updated = await store.attachSourceLink(tenant, caseId, link);
    expect(updated.version).toBe(2);
    expect(updated.sourceLinks).toHaveLength(1);

    const reloaded = await store.getCase(tenant, caseId);
    expect(reloaded?.version).toBe(2);
    expect(reloaded?.sourceLinks).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Assignment State & Search by State
  // ─────────────────────────────────────────────────────────────────────────────
  it('5. saves, updates, and queries assignments by lifecycle state', async () => {
    const tenant = makeTenant();
    const assignmentId = `asg-${randomUUID()}`;
    const now = new Date().toISOString();

    const assignment: Assignment = {
      tenantId: tenant,
      assignmentId,
      caseId: `case-${randomUUID()}`,
      agentPrincipalId: 'agent-praeco-worker',
      requestedByPrincipalId: 'user-cfo',
      state: 'QUEUED',
      version: 1,
      ownershipEpoch: 1,
      createdAt: now,
      updatedAt: now,
    };

    await store.saveAssignment(assignment);

    const loaded = await store.getAssignment(tenant, assignmentId);
    expect(loaded).not.toBeNull();
    expect(loaded?.state).toBe('QUEUED');
    expect(loaded?.version).toBe(1);

    // Transition to RUNNING
    const updated: Assignment = {
      ...assignment,
      state: 'RUNNING',
      version: 2,
      activeRunId: 'run-101',
      updatedAt: new Date().toISOString(),
    };
    await store.saveAssignment(updated);

    const running = await store.findAssignmentsByState(tenant, 'RUNNING');
    expect(running.length).toBeGreaterThanOrEqual(1);
    expect(running.some((a) => a.assignmentId === assignmentId)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Checkpoints & Runs
  // ─────────────────────────────────────────────────────────────────────────────
  it('6. persists execution runs and checkpoints in chronological order', async () => {
    const tenant = makeTenant();
    const assignmentId = `asg-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;

    await store.saveRun({
      tenantId: tenant,
      assignmentId,
      runId,
      triggerRunId: 'trig-neon-1',
      workerVersionId: 'v1.0.0',
      specialistRole: 'VERA',
      ownershipEpoch: 1,
      startedAt: new Date().toISOString(),
      status: 'ACTIVE',
    });

    const run = await store.getRun(tenant, assignmentId, runId);
    expect(run?.specialistRole).toBe('VERA');
    expect(run?.status).toBe('ACTIVE');

    // Save checkpoints
    const cp1: Checkpoint = {
      tenantId: tenant,
      checkpointId: `cp-${randomUUID()}`,
      assignmentId,
      runId,
      ownershipEpoch: 1,
      stage: 'INGESTED',
      inputRefs: ['doc-1'],
      outputRefs: ['sha256-1'],
      recordedAt: new Date(Date.now() - 1000).toISOString(),
    };
    const cp2: Checkpoint = {
      tenantId: tenant,
      checkpointId: `cp-${randomUUID()}`,
      assignmentId,
      runId,
      ownershipEpoch: 1,
      stage: 'EVIDENCE_RESOLVED',
      inputRefs: ['sha256-1'],
      outputRefs: ['env-1'],
      recordedAt: new Date().toISOString(),
    };

    await store.saveCheckpoint(cp1);
    await store.saveCheckpoint(cp2);

    const checkpoints = await store.getCheckpoints(tenant, assignmentId);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]!.stage).toBe('INGESTED');
    expect(checkpoints[1]!.stage).toBe('EVIDENCE_RESOLVED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Financial Intent & Decision References
  // ─────────────────────────────────────────────────────────────────────────────
  it('7. saves and loads financial intent and decision references', async () => {
    const tenant = makeTenant();
    const intentId = `intent-${randomUUID()}`;
    const decisionId = `dec-${randomUUID()}`;

    const intent: FinancialIntentReference = {
      intentId,
      assignmentId: `asg-${randomUUID()}`,
      caseId: `case-${randomUUID()}`,
      caseVersion: 1,
      requestedByPrincipalId: 'cfo-alice',
      workerPrincipalId: 'worker-nova',
      requestedBudgetId: 'bud-ops-2026',
      envelopeIds: ['env-01', 'env-02'],
      idempotencyKey: `idem-${randomUUID()}`,
      payloadDigest: 'digest-intent-sha256',
    };

    await store.saveFinancialIntent(intent);

    const loadedIntent = await store.getFinancialIntent(tenant, intentId);
    expect(loadedIntent).not.toBeNull();
    expect(loadedIntent?.envelopeIds).toEqual(['env-01', 'env-02']);
    expect(loadedIntent?.idempotencyKey).toBe(intent.idempotencyKey);

    const decision: FinancialDecisionReference = {
      decisionId,
      outcome: 'AUTHORIZED_SIMULATED',
      approvalRequestId: 'req-appr-101',
      gateSummaryRefs: ['G1:PASS', 'G2:PASS', 'G3:PASS', 'G4:PASS', 'G5:PASS', 'G6:PASS'],
    };

    await store.saveFinancialDecision(tenant, decision);

    const loadedDecision = await store.getFinancialDecision(tenant, decisionId);
    expect(loadedDecision).not.toBeNull();
    expect(loadedDecision?.outcome).toBe('AUTHORIZED_SIMULATED');
    expect(loadedDecision?.gateSummaryRefs).toHaveLength(6);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Transactional Outbox Draining with FOR UPDATE SKIP LOCKED
  // ─────────────────────────────────────────────────────────────────────────────
  it('8. drains outbox events with SKIP LOCKED concurrency', async () => {
    const tenant = makeTenant();

    const ev1: OutboxEvent = {
      eventId: `evt-out-1-${randomUUID()}`,
      tenantId: tenant,
      eventType: 'ASSIGNMENT_CREATED',
      commandId: 'cmd-1',
      payload: { index: 1 },
      occurredAt: new Date(Date.now() - 2000).toISOString(),
    };
    const ev2: OutboxEvent = {
      eventId: `evt-out-2-${randomUUID()}`,
      tenantId: tenant,
      eventType: 'CHECKPOINT_RECORDED',
      commandId: 'cmd-2',
      payload: { index: 2 },
      occurredAt: new Date(Date.now() - 1000).toISOString(),
    };
    const ev3: OutboxEvent = {
      eventId: `evt-out-3-${randomUUID()}`,
      tenantId: tenant,
      eventType: 'ASSIGNMENT_RESOLVED',
      commandId: 'cmd-3',
      payload: { index: 3 },
      occurredAt: new Date().toISOString(),
    };

    await store.enqueueOutbox(ev1);
    await store.enqueueOutbox(ev2);
    await store.enqueueOutbox(ev3);

    // First drain: batch size 2
    const batch1 = await store.drainOutbox(tenant, 2);
    expect(batch1).toHaveLength(2);
    expect(batch1[0]!.eventId).toBe(ev1.eventId);
    expect(batch1[1]!.eventId).toBe(ev2.eventId);
    expect(batch1[0]!.dispatchedAt).toBeDefined();

    // Second drain: remaining 1
    const batch2 = await store.drainOutbox(tenant, 2);
    expect(batch2).toHaveLength(1);
    expect(batch2[0]!.eventId).toBe(ev3.eventId);

    // Third drain: empty
    const batch3 = await store.drainOutbox(tenant, 2);
    expect(batch3).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Full Multi-Tenant Isolation
  // ─────────────────────────────────────────────────────────────────────────────
  it('9. strictly isolates state between distinct tenants', async () => {
    const tenantA = makeTenant();
    const tenantB = makeTenant();
    const sharedId = `shared-entity-id`;

    // Both tenants save an assignment with the SAME assignmentId
    const now = new Date().toISOString();
    await store.saveAssignment({
      tenantId: tenantA,
      assignmentId: sharedId,
      caseId: `case-a`,
      agentPrincipalId: 'worker',
      requestedByPrincipalId: 'alice',
      state: 'RUNNING',
      version: 1,
      ownershipEpoch: 1,
      createdAt: now,
      updatedAt: now,
    });

    await store.saveAssignment({
      tenantId: tenantB,
      assignmentId: sharedId,
      caseId: `case-b`,
      agentPrincipalId: 'worker',
      requestedByPrincipalId: 'bob',
      state: 'COMPLETED',
      version: 5,
      ownershipEpoch: 2,
      createdAt: now,
      updatedAt: now,
    });

    const asgA = await store.getAssignment(tenantA, sharedId);
    const asgB = await store.getAssignment(tenantB, sharedId);

    expect(asgA?.caseId).toBe('case-a');
    expect(asgA?.state).toBe('RUNNING');
    expect(asgA?.version).toBe(1);

    expect(asgB?.caseId).toBe('case-b');
    expect(asgB?.state).toBe('COMPLETED');
    expect(asgB?.version).toBe(5);

    // Tenant A cannot see Tenant B's case
    const crossCase = await store.getCase(tenantA, 'case-b');
    expect(crossCase).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. End-to-End AssignmentService + SqlHarnessStore Integration
  // ─────────────────────────────────────────────────────────────────────────────
  it('10. executes end-to-end AssignmentService lifecycle against SqlHarnessStore', async () => {
    const tenant = makeTenant();
    const service = new AssignmentService({ store });

    const principal: TrustedPrincipal = {
      tenantId: tenant,
      principalId: 'cfo-alice',
      roles: ['FinanceAdmin'],
      bindingRevision: 'rev-1',
    };

    const rawCommand = {
      provider: 'WEB' as const,
      installationId: 'web-neon-1',
      providerEventId: `evt-sql-${randomUUID()}`,
      providerUserId: 'cfo-alice',
      providerThreadId: `thread-sql-${randomUUID()}`,
      messageId: `msg-sql-${randomUUID()}`,
      attachmentRefs: [],
      text: 'Submit invoice via Web',
    };

    const payloadDigest = computeInboundPayloadDigest(rawCommand);
    const command: InboundMessageCommand = {
      ...rawCommand,
      payloadDigest,
    };

    // 1. Create assignment
    const { assignment, isDuplicate } = await service.createOrLoad(command, principal);
    expect(isDuplicate).toBe(false);
    expect(assignment.state).toBe('QUEUED');
    expect(assignment.version).toBe(1);

    // 2. Claim run
    const execCtx = await service.claimRun(
      {
        assignmentId: assignment.assignmentId,
        triggerRunId: 'trig-neon-run-1',
        workerVersionId: 'v1.0.0',
        specialistRole: 'VERA',
      },
      principal
    );

    expect(execCtx.ownershipEpoch).toBe(2);

    // 3. Advance to RUNNING (expectedVersion is 2 following claimRun epoch/version bump)
    const running = await service.advance(
      {
        assignmentId: assignment.assignmentId,
        expectedVersion: 2,
        next: 'RUNNING',
        outputRefs: ['ref-1'],
        checkpointStage: 'INGESTED',
      },
      execCtx
    );

    expect(running.state).toBe('RUNNING');
    expect(running.version).toBe(3);

    // 4. Verify stored in Neon
    const inDb = await store.getAssignment(tenant, assignment.assignmentId);
    expect(inDb?.state).toBe('RUNNING');
    expect(inDb?.version).toBe(3);
  });
});
