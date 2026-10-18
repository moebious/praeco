import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEMO_TENANT_ID } from '@praeco/financial-decision-kernel';
import {
  SqlHarnessStore,
  AssignmentService,
  WorkflowRunner,
  HarnessReconciler,
  computeInboundPayloadDigest,
  type Assignment,
  type CaseSourceLink,
  type Checkpoint,
  type ExternalPrincipalBinding,
  type FinancialDecisionReference,
  type FinancialIntentReference,
  type FinancialDecisionPort,
  type InboundMessageCommand,
  type LinkingChallenge,
  type OutboxEvent,
  type TrustedPrincipal,
} from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;

/**
 * Live integration tests for SqlHarnessStore against PostgreSQL / Neon (ADR-004, ADR-005, ADR-007).
 * When DATABASE_URL is set, tests execute real database transactions, row locking, and CAS guards.
 * When DATABASE_URL is unset, tests skip cleanly to keep offline CI builds green (ADR-007 delta #1).
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

    // Consume challenge atomically
    const consumedAt = new Date().toISOString();
    const consumed = await store.consumeLinkingChallenge({
      token,
      provider: 'TELEGRAM',
      installationId: 'tg-bot-neon',
      consumedByUserId: 'tg-alice-777',
      consumedAt,
    });

    expect(consumed).not.toBeNull();
    expect(consumed?.challenge.consumedAt).toBeDefined();
    expect(consumed?.binding.providerUserId).toBe('tg-alice-777');
    expect(consumed?.binding.principalId).toBe('cfo-alice');

    // Binding is immediately queryable in store
    const binding = await store.getPrincipalBinding(tenant, 'TELEGRAM', 'tg-bot-neon', 'tg-alice-777');
    expect(binding).not.toBeNull();
    expect(binding?.principalId).toBe('cfo-alice');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Technical Inbound Event Idempotency & Conflict Check
  // ─────────────────────────────────────────────────────────────────────────────
  it('3. enforces technical inbound event idempotency and rejects conflicting payloads', async () => {
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

    // Identical replay succeeds idempotently
    await expect(store.recordInboundReceipt(receipt)).resolves.toBeUndefined();

    // Replay with conflicting digest throws CONFLICTING_EVENT_PAYLOAD
    const conflictingReceipt = {
      ...receipt,
      receiptId: `rcpt-${randomUUID()}`,
      payloadDigest: 'digest-sha256-tampered',
    };
    await expect(store.recordInboundReceipt(conflictingReceipt)).rejects.toThrowError(
      /CONFLICTING_EVENT_PAYLOAD/
    );

    const loaded = await store.getInboundReceipt(
      tenant,
      'EMAIL',
      'mail-mx-neon',
      'evt-email-neon-1'
    );
    expect(loaded?.payloadDigest).toBe('digest-sha256-original');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Case Management & Thread Correlations
  // ─────────────────────────────────────────────────────────────────────────────
  it('4. persists cases, source links, and thread correlations with monotonic versioning', async () => {
    const tenant = makeTenant();
    const caseId = `case-${randomUUID()}`;

    const link1: CaseSourceLink = {
      kind: 'CHANNEL_MESSAGE',
      refId: 'msg-001',
    };

    const case1 = await store.attachSourceLink(tenant, caseId, link1);
    expect(case1.version).toBe(1);
    expect(case1.sourceLinks).toHaveLength(1);

    const link2: CaseSourceLink = {
      kind: 'ERP_REFERENCE',
      refId: 'erp-002',
    };

    const case2 = await store.attachSourceLink(tenant, caseId, link2);
    expect(case2.version).toBe(2);
    expect(case2.sourceLinks).toHaveLength(2);

    // Link thread
    await store.linkThreadToCase(tenant, 'TELEGRAM', 'tg-bot-1', 'chat-999', caseId);
    const resolvedCaseId = await store.findCaseByThread(
      tenant,
      'TELEGRAM',
      'tg-bot-1',
      'chat-999'
    );
    expect(resolvedCaseId).toBe(caseId);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Assignment CAS Version Guarding & Case Queries
  // ─────────────────────────────────────────────────────────────────────────────
  it('5. saves, updates, and queries assignments with CAS versioning', async () => {
    const tenant = makeTenant();
    const assignmentId = `asg-${randomUUID()}`;
    const caseId = `case-${randomUUID()}`;
    const now = new Date().toISOString();

    const assignment: Assignment = {
      tenantId: tenant,
      assignmentId,
      caseId,
      agentPrincipalId: 'specialist-vera',
      requestedByPrincipalId: 'human-alice',
      state: 'QUEUED',
      version: 1,
      ownershipEpoch: 1,
      createdAt: now,
      updatedAt: now,
    };

    // Initial insert (version 1)
    await store.saveAssignment(assignment, 0);

    const loaded = await store.getAssignment(tenant, assignmentId);
    expect(loaded).not.toBeNull();
    expect(loaded?.state).toBe('QUEUED');
    expect(loaded?.version).toBe(1);

    // Update with correct expectedVersion
    const updated: Assignment = {
      ...loaded!,
      state: 'RUNNING',
      version: 2,
      ownershipEpoch: 2,
      activeRunId: 'run-001',
      updatedAt: new Date().toISOString(),
    };
    await store.saveAssignment(updated, 1);

    const loaded2 = await store.getAssignment(tenant, assignmentId);
    expect(loaded2?.state).toBe('RUNNING');
    expect(loaded2?.version).toBe(2);

    // Stale update with wrong expectedVersion must fail
    const stale: Assignment = {
      ...loaded2!,
      state: 'COMPLETED',
      version: 3,
      updatedAt: new Date().toISOString(),
    };
    await expect(store.saveAssignment(stale, 1)).rejects.toThrowError(
      /CONCURRENT_MODIFICATION/
    );

    // Query assignments by case (P2 port)
    const byCase = await store.findAssignmentsByCase(tenant, caseId);
    expect(byCase).toHaveLength(1);
    expect(byCase[0]?.assignmentId).toBe(assignmentId);

    // List assignments
    const list = await store.listAssignments(tenant, 10);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Runs & Checkpoints Persistence
  // ─────────────────────────────────────────────────────────────────────────────
  it('6. persists execution runs and checkpoints in chronological order', async () => {
    const tenant = makeTenant();
    const assignmentId = `asg-${randomUUID()}`;
    const runId = 'run-neon-1';
    const now = new Date().toISOString();

    await store.saveRun({
      tenantId: tenant,
      assignmentId,
      runId,
      triggerRunId: 'trig-1',
      workerVersionId: 'v1.0.0',
      specialistRole: 'VERA',
      ownershipEpoch: 1,
      startedAt: now,
      status: 'ACTIVE',
    });

    const run = await store.getRun(tenant, assignmentId, runId);
    expect(run?.status).toBe('ACTIVE');
    expect(run?.specialistRole).toBe('VERA');

    // Save checkpoints
    const chk1: Checkpoint = {
      tenantId: tenant,
      checkpointId: 'chk-1',
      assignmentId,
      runId,
      ownershipEpoch: 1,
      stage: 'INGESTED',
      inputRefs: ['in-1'],
      outputRefs: ['out-1'],
      recordedAt: new Date(Date.now() - 1000).toISOString(),
    };
    const chk2: Checkpoint = {
      tenantId: tenant,
      checkpointId: 'chk-2',
      assignmentId,
      runId,
      ownershipEpoch: 1,
      stage: 'EVIDENCE_RESOLVED',
      inputRefs: ['in-2'],
      outputRefs: ['out-2'],
      recordedAt: new Date().toISOString(),
    };

    await store.saveCheckpoint(chk1);
    await store.saveCheckpoint(chk2);

    const checkpoints = await store.getCheckpoints(tenant, assignmentId);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]?.stage).toBe('INGESTED');
    expect(checkpoints[1]?.stage).toBe('EVIDENCE_RESOLVED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Strict Financial Intent Tenant Isolation (Finding 1)
  // ─────────────────────────────────────────────────────────────────────────────
  it('7. enforces strict tenant isolation on financial intents without fallback', async () => {
    const tenantA = makeTenant();
    const tenantB = makeTenant();
    const intentId = `intent-${randomUUID()}`;
    const decisionId = `dec-${randomUUID()}`;

    const intent: FinancialIntentReference = {
      tenantId: tenantA,
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

    // Tenant A can load its own intent
    const loadedIntent = await store.getFinancialIntent(tenantA, intentId);
    expect(loadedIntent).not.toBeNull();
    expect(loadedIntent?.tenantId).toBe(tenantA);
    expect(loadedIntent?.envelopeIds).toEqual(['env-01', 'env-02']);

    // Tenant B querying the same intentId gets strictly NULL (no cross-tenant leak, no fallback)
    const crossTenantIntent = await store.getFinancialIntent(tenantB, intentId);
    expect(crossTenantIntent).toBeNull();

    // Decisions are also strictly tenant-isolated
    const decision: FinancialDecisionReference = {
      decisionId,
      outcome: 'AUTHORIZED_SIMULATED',
      approvalRequestId: 'req-appr-101',
      gateSummaryRefs: ['G1:PASS', 'G2:PASS', 'G3:PASS', 'G4:PASS', 'G5:PASS', 'G6:PASS'],
    };
    await store.saveFinancialDecision(tenantA, decision);

    const loadedDecision = await store.getFinancialDecision(tenantA, decisionId);
    expect(loadedDecision?.outcome).toBe('AUTHORIZED_SIMULATED');

    const crossTenantDecision = await store.getFinancialDecision(tenantB, decisionId);
    expect(crossTenantDecision).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Outbox Leased Claiming, Acknowledgment & Crash Recovery (Finding 4)
  // ─────────────────────────────────────────────────────────────────────────────
  it('8. leases outbox events, acknowledges delivery, and recovers on worker crash', async () => {
    const tenant = makeTenant();

    const ev1: OutboxEvent = {
      eventId: `evt-out-1-${randomUUID()}`,
      tenantId: tenant,
      eventType: 'ASSIGNMENT_CREATED',
      commandId: 'cmd-1',
      payload: { index: 1 },
      occurredAt: new Date(Date.now() - 2000).toISOString(),
    };

    await store.enqueueOutbox(ev1);

    // Worker 1 claims outbox with a 1500ms lease but crashes before acknowledging
    const batch1 = await store.drainOutbox(tenant, 10, 1500);
    expect(batch1).toHaveLength(1);
    expect(batch1[0]?.eventId).toBe(ev1.eventId);
    expect(batch1[0]?.claimedAt).toBeDefined();
    expect(batch1[0]?.dispatchedAt).toBeUndefined(); // NOT dispatched yet

    // Immediate second drain by Worker 2 returns empty because lease is still active
    const batchActiveLease = await store.drainOutbox(tenant, 10, 1500);
    expect(batchActiveLease).toHaveLength(0);

    // Wait for Worker 1's lease to expire
    await new Promise((res) => setTimeout(res, 1800));

    // Worker 2 drains after lease expiration: message is re-claimed for redelivery!
    const batchRecovered = await store.drainOutbox(tenant, 10, 60_000);
    expect(batchRecovered).toHaveLength(1);
    expect(batchRecovered[0]?.eventId).toBe(ev1.eventId);

    // Worker 2 successfully delivers and acknowledges
    await store.acknowledgeOutbox(tenant, [ev1.eventId]);

    // Subsequent drains never return the acknowledged event
    const batchFinal = await store.drainOutbox(tenant, 10);
    expect(batchFinal).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Full Multi-Tenant Isolation
  // ─────────────────────────────────────────────────────────────────────────────
  it('9. strictly isolates state between distinct tenants', async () => {
    const tenantA = makeTenant();
    const tenantB = makeTenant();
    const sharedId = `shared-entity-id`;

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
    }, 0);

    await store.saveAssignment({
      tenantId: tenantB,
      assignmentId: sharedId,
      caseId: `case-b`,
      agentPrincipalId: 'worker',
      requestedByPrincipalId: 'bob',
      state: 'COMPLETED',
      version: 1,
      ownershipEpoch: 2,
      createdAt: now,
      updatedAt: now,
    }, 0);

    const asgA = await store.getAssignment(tenantA, sharedId);
    const asgB = await store.getAssignment(tenantB, sharedId);

    expect(asgA?.caseId).toBe('case-a');
    expect(asgA?.state).toBe('RUNNING');

    expect(asgB?.caseId).toBe('case-b');
    expect(asgB?.state).toBe('COMPLETED');

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

    // 1. Create assignment transactionally
    const { assignment, isDuplicate } = await service.createOrLoad(command, principal);
    expect(isDuplicate).toBe(false);
    expect(assignment.state).toBe('QUEUED');
    expect(assignment.version).toBe(1);

    // 2. Claim run (bumps epoch from 1 to 2, version from 1 to 2)
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

    // 3. Advance to RUNNING (expectedVersion 2 -> version 3)
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

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. Adversarial Assignment CAS Concurrency (Finding 2)
  // ─────────────────────────────────────────────────────────────────────────────
  it('11. serializes concurrent assignment writers via atomic SQL version fencing', async () => {
    const tenant = makeTenant();
    const assignmentId = `asg-${randomUUID()}`;
    const now = new Date().toISOString();

    await store.saveAssignment({
      tenantId: tenant,
      assignmentId,
      caseId: `case-${randomUUID()}`,
      agentPrincipalId: 'worker',
      requestedByPrincipalId: 'alice',
      state: 'QUEUED',
      version: 1,
      ownershipEpoch: 1,
      createdAt: now,
      updatedAt: now,
    }, 0);

    // Two competing workers simultaneously attempt to advance from version 1 to 2
    const worker1Update: Assignment = {
      tenantId: tenant,
      assignmentId,
      caseId: 'case-1',
      agentPrincipalId: 'worker-1',
      requestedByPrincipalId: 'alice',
      state: 'RUNNING',
      version: 2,
      ownershipEpoch: 2,
      createdAt: now,
      updatedAt: new Date().toISOString(),
    };

    const worker2Update: Assignment = {
      tenantId: tenant,
      assignmentId,
      caseId: 'case-2',
      agentPrincipalId: 'worker-2',
      requestedByPrincipalId: 'alice',
      state: 'RUNNING',
      version: 2,
      ownershipEpoch: 2,
      createdAt: now,
      updatedAt: new Date().toISOString(),
    };

    const results = await Promise.allSettled([
      store.saveAssignment(worker1Update, 1),
      store.saveAssignment(worker2Update, 1),
    ]);

    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

    // Exactly one succeeds, and exactly one fails with CONCURRENT_MODIFICATION
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as PromiseRejectedResult).reason.message).toMatch(/CONCURRENT_MODIFICATION/);

    const finalAssignment = await store.getAssignment(tenant, assignmentId);
    expect(finalAssignment?.version).toBe(2);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Adversarial Linking Challenge Race (Finding 5)
  // ─────────────────────────────────────────────────────────────────────────────
  it('12. atomically consumes linking challenges so competing callers cannot double-bind', async () => {
    const tenant = makeTenant();
    const token = `link-race-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 600_000).toISOString();

    await store.saveLinkingChallenge({
      token,
      tenantId: tenant,
      principalId: 'cfo-charlie',
      roles: ['FinanceAdmin'],
      provider: 'TELEGRAM',
      installationId: 'tg-bot-race',
      expiresAt,
    });

    const nowIso = new Date().toISOString();
    // Two callers simultaneously try to redeem the same single-use token
    const [result1, result2] = await Promise.all([
      store.consumeLinkingChallenge({
        token,
        provider: 'TELEGRAM',
        installationId: 'tg-bot-race',
        consumedByUserId: 'tg-caller-1',
        consumedAt: nowIso,
      }),
      store.consumeLinkingChallenge({
        token,
        provider: 'TELEGRAM',
        installationId: 'tg-bot-race',
        consumedByUserId: 'tg-caller-2',
        consumedAt: nowIso,
      }),
    ]);

    const winner = result1 ?? result2;
    const loser = result1 ? result2 : result1;

    expect(winner).not.toBeNull();
    expect(loser).toBeNull(); // Second caller is strictly rejected!

    // Verify challenge in DB is consumed by the winner
    const inDb = await store.getLinkingChallenge(token);
    expect(inDb?.consumedAt).toBeDefined();
    expect(inDb?.consumedByUserId).toBe(winner?.binding.providerUserId);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. Adversarial Concurrent Source Attachment (Finding 6)
  // ─────────────────────────────────────────────────────────────────────────────
  it('13. appends concurrent source links without losing evidence', async () => {
    const tenant = makeTenant();
    const caseId = `case-multi-source-${randomUUID()}`;

    // 5 concurrent writers simultaneously attach distinct documents to the same case
    const linkPromises = Array.from({ length: 5 }, (_, i) => {
      const link: CaseSourceLink = {
        kind: 'CHANNEL_MESSAGE',
        refId: `msg-doc-${i}`,
      };
      return store.attachSourceLink(tenant, caseId, link);
    });

    await Promise.all(linkPromises);

    const loadedCase = await store.getCase(tenant, caseId);
    expect(loadedCase).not.toBeNull();
    // All 5 links must be present (zero lost evidence)
    expect(loadedCase?.sourceLinks).toHaveLength(5);
    expect(loadedCase?.version).toBe(5);

    const refIds = loadedCase?.sourceLinks
      .map((l) => (l.kind !== 'DOCUMENT' ? l.refId : ''))
      .sort();
    expect(refIds).toEqual(['msg-doc-0', 'msg-doc-1', 'msg-doc-2', 'msg-doc-3', 'msg-doc-4']);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 14. Adversarial Transactional Inbound Claiming (Finding 3)
  // ─────────────────────────────────────────────────────────────────────────────
  it('14. handles concurrent deliveries transactionally and returns winning assignment', async () => {
    const tenant = makeTenant();
    const service = new AssignmentService({ store });

    const principal: TrustedPrincipal = {
      tenantId: tenant,
      principalId: 'cfo-david',
      roles: ['FinanceAdmin'],
      bindingRevision: 'rev-1',
    };

    const eventId = `evt-concurrent-${randomUUID()}`;
    const rawCommand = {
      provider: 'EMAIL' as const,
      installationId: 'mail-mx-race',
      providerEventId: eventId,
      providerUserId: 'vendor-corp',
      providerThreadId: `thread-${randomUUID()}`,
      messageId: `msg-${randomUUID()}`,
      attachmentRefs: [],
      text: 'Invoice delivery attempt',
    };

    const payloadDigest = computeInboundPayloadDigest(rawCommand);
    const command: InboundMessageCommand = {
      ...rawCommand,
      payloadDigest,
    };

    // Two identical deliveries arrive simultaneously
    const [res1, res2] = await Promise.all([
      service.createOrLoad(command, principal),
      service.createOrLoad(command, principal),
    ]);

    const nonDuplicate = !res1.isDuplicate ? res1 : res2;
    const duplicate = res1.isDuplicate ? res1 : res2;

    expect(nonDuplicate.isDuplicate).toBe(false);
    expect(duplicate.isDuplicate).toBe(true);
    // Both returned the identical winning assignment
    expect(duplicate.assignment.assignmentId).toBe(nonDuplicate.assignment.assignmentId);

    // If a conflicting payload arrives later with the same event ID, it must fail closed
    const tamperedRaw = {
      ...rawCommand,
      text: 'Tampered invoice amount',
    };
    const tamperedCommand: InboundMessageCommand = {
      ...tamperedRaw,
      payloadDigest: computeInboundPayloadDigest(tamperedRaw),
    };

    await expect(service.createOrLoad(tamperedCommand, principal)).rejects.toThrowError(
      /CONFLICTING_EVENT_PAYLOAD/
    );
  });

  it('keeps distinct new-thread events, persisted assignments, and outbox payloads on the winning case', async () => {
    const tenantId = makeTenant();
    const principal: TrustedPrincipal = {
      tenantId, principalId: 'synthetic-admin', roles: ['FinanceAdmin'], bindingRevision: 'rev-1',
    };
    const service = new AssignmentService({ store });
    const providerThreadId = `thread-${randomUUID()}`;
    const commands = [0, 1].map(index => {
      const raw = {
        provider: 'EMAIL' as const,
        installationId: 'distinct-event-race',
        providerEventId: `event-${randomUUID()}`,
        providerUserId: 'synthetic-sender',
        providerThreadId,
        messageId: `message-${index}`,
        attachmentRefs: [],
      };
      return { ...raw, payloadDigest: computeInboundPayloadDigest(raw) };
    });
    // Force both preflight reads to miss. Only the transactional thread-key
    // claim may elect the winner, not timing of the service's earlier read.
    const preflight = vi.spyOn(store, 'findCaseByThread').mockResolvedValue(null);
    let results;
    try {
      results = await Promise.all(commands.map(command => service.createOrLoad(command, principal)));
    } finally {
      preflight.mockRestore();
    }
    const canonical = await store.findCaseByThread(tenantId, 'EMAIL', 'distinct-event-race', providerThreadId);
    expect(canonical).toBeTruthy();
    expect(results.every(result => !result.isDuplicate)).toBe(true);
    expect(new Set(results.map(result => result.assignment.assignmentId)).size).toBe(2);
    for (const result of results) {
      expect(result.assignment.caseId).toBe(canonical);
      expect((await store.getAssignment(tenantId, result.assignment.assignmentId))?.caseId).toBe(canonical);
    }
    const events = await store.drainOutbox(tenantId);
    expect(events).toHaveLength(2);
    expect(events.every(event => event.payload.caseId === canonical)).toBe(true);
    expect((await store.findAssignmentsByCase(tenantId, canonical!))).toHaveLength(2);
  });

  it.each(['01', '03', '08'])('runs the full scenario %s workflow under SQL CAS', async id => {
    const principal: TrustedPrincipal = {
      tenantId: DEMO_TENANT_ID,
      principalId: 'workflow-cas-admin',
      roles: ['FinanceAdmin'],
      bindingRevision: 'rev-1',
    };
    const raw = {
      provider: 'WEB' as const,
      installationId: 'workflow-cas',
      providerEventId: `event-${randomUUID()}`,
      providerUserId: 'synthetic-user',
      providerThreadId: `thread-${randomUUID()}`,
      messageId: `message-${randomUUID()}`,
      attachmentRefs: [],
    };
    const service = new AssignmentService({ store });
    const { assignment } = await service.createOrLoad({
      ...raw, payloadDigest: computeInboundPayloadDigest(raw),
    }, principal);
    const runner = new WorkflowRunner({ store, service });
    const result = await runner.executeAssignmentWorkflow({
      assignmentId: assignment.assignmentId,
      triggerRunId: `run-${randomUUID()}`,
      sourceReference: `${id}.pdf`,
      scenarioId: `BLINKA-${id}`,
      requestedBudgetId: 'BUDGET-2026-10',
    }, principal);
    const persisted = await store.getAssignment(principal.tenantId, assignment.assignmentId);
    expect(persisted?.version).toBe(6);
    if (id === '03') {
      expect(persisted?.state).toBe('WAITING_FOR_REVIEW');
      expect(persisted?.initialL2DecisionId).toBe(result.decisionId);
      expect(persisted?.l2ApprovalRequestId).toBe(result.approvalRequestId);
      expect(persisted?.triggerWaitToken).toBeTruthy();
    } else {
      expect(persisted?.state).toBe('COMPLETED');
      expect(persisted?.latestL2DecisionId).toBe(result.decisionId);
    }
  });

  it('only acknowledges SQL outbox events after successful delivery and retries failed handlers', async () => {
    const tenantId = makeTenant();
    const eventIds = ['retry', 'success'].map(label => `${label}-${randomUUID()}`);
    for (const eventId of eventIds) {
      await store.enqueueOutbox({
        tenantId, eventId, eventType: 'ASSIGNMENT_QUEUED', commandId: eventId,
        payload: {}, occurredAt: new Date().toISOString(),
      });
    }
    const decisionPort: FinancialDecisionPort = {
      preview: vi.fn(), decideAndCommit: vi.fn(), getCommandResult: vi.fn(),
      getDecision: vi.fn(), getApprovalStatus: vi.fn(), resolveApproval: vi.fn(),
    };
    const options = {
      store, decisionPort,
      workflowRunner: new WorkflowRunner({ store, service: new AssignmentService({ store }) }),
    };
    expect((await new HarnessReconciler(options).tick(tenantId)).drainedOutboxCount).toBe(0);
    let fail = true;
    const delivered: string[] = [];
    const reconciler = new HarnessReconciler({
      ...options,
      deliverL3Event: async event => {
        if (event.eventId === eventIds[0] && fail) throw new Error('synthetic handler failure');
        delivered.push(event.eventId);
      },
    });
    expect((await reconciler.tick(tenantId)).drainedOutboxCount).toBe(1);
    expect(delivered).toEqual([eventIds[1]]);
    const retryable = await store.drainOutbox(tenantId);
    expect(retryable.map(event => event.eventId)).toEqual([eventIds[0]]);
    await store.failOutboxClaim(tenantId, [eventIds[0]!]);
    fail = false;
    expect((await reconciler.tick(tenantId)).drainedOutboxCount).toBe(1);
    expect(await store.drainOutbox(tenantId)).toHaveLength(0);
  });
});
