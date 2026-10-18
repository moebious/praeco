import { describe, expect, it, beforeEach } from 'vitest';
import {
  AssignmentService,
  InMemoryHarnessStore,
  FakeChannelAdapter,
  HarnessError,
  type TrustedPrincipal,
} from '../src/index.js';

describe('Layer 3 Slice A — Operational Schema, Idempotency & Fencing', () => {
  let store: InMemoryHarnessStore;
  let service: AssignmentService;
  let adapter: FakeChannelAdapter;

  const TENANT_A = 'tenant-blinka-us';
  const TENANT_B = 'tenant-other-corp';

  const PRINCIPAL_A: TrustedPrincipal = {
    tenantId: TENANT_A,
    principalId: 'user-cfo-alice',
    roles: ['FinanceAdmin', 'APReviewer'],
    bindingRevision: 'rev-1',
  };

  const PRINCIPAL_B: TrustedPrincipal = {
    tenantId: TENANT_B,
    principalId: 'user-cfo-bob',
    roles: ['FinanceAdmin'],
    bindingRevision: 'rev-1',
  };

  beforeEach(async () => {
    store = new InMemoryHarnessStore();
    service = new AssignmentService({ store });
    adapter = new FakeChannelAdapter(store, service);

    // Register channel principal bindings for Tenant A
    await store.registerPrincipalBinding({
      tenantId: TENANT_A,
      provider: 'EMAIL',
      installationId: 'mail-mx-1',
      providerUserId: 'ap@blinka.com',
      principalId: 'user-cfo-alice',
      roles: ['FinanceAdmin'],
      bindingRevision: 'rev-1',
      revoked: false,
    });

    await store.registerPrincipalBinding({
      tenantId: TENANT_A,
      provider: 'TELEGRAM',
      installationId: 'tg-bot-blinka',
      providerUserId: 'tg-user-999',
      principalId: 'user-cfo-alice',
      roles: ['FinanceAdmin'],
      bindingRevision: 'rev-1',
      revoked: false,
    });
  });

  describe('Exit Criterion: Inbound Idempotency & Duplicate Delivery', () => {
    it('creates a new Assignment on first inbound message', async () => {
      const res = await adapter.handleInboundWebhook(TENANT_A, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: 'mail-evt-100',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-invoice-01',
        messageId: 'msg-100',
        text: 'New invoice attached from Bogota contractor',
        attachmentRefs: ['art-bogota-01-pdf'],
      });

      expect(res.isDuplicate).toBe(false);
      expect(res.assignmentId).toMatch(/^asgn-/);
      expect(res.caseId).toMatch(/^case-/);

      const assignment = await service.get(res.assignmentId, PRINCIPAL_A);
      expect(assignment.state).toBe('QUEUED');
      expect(assignment.version).toBe(1);
      expect(assignment.ownershipEpoch).toBe(1);

      // Verify outbox event queued
      const outbox = await store.drainOutbox(TENANT_A);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.eventType).toBe('ASSIGNMENT_QUEUED');
      expect(outbox[0]!.payload['assignmentId']).toBe(res.assignmentId);
    });

    it('returns the same Assignment on duplicate inbound delivery with identical payload', async () => {
      const payload = {
        provider: 'EMAIL' as const,
        installationId: 'mail-mx-1',
        providerEventId: 'mail-evt-101',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-invoice-01',
        messageId: 'msg-101',
        text: 'Invoice submission',
        attachmentRefs: ['art-pdf-1'],
      };

      const first = await adapter.handleInboundWebhook(TENANT_A, payload);
      expect(first.isDuplicate).toBe(false);

      // Duplicate delivery
      const second = await adapter.handleInboundWebhook(TENANT_A, payload);
      expect(second.isDuplicate).toBe(true);
      expect(second.assignmentId).toBe(first.assignmentId);
      expect(second.caseId).toBe(first.caseId);

      // Ensure outbox did not emit duplicate creation events
      const outbox = await store.drainOutbox(TENANT_A);
      expect(outbox).toHaveLength(1);
    });

    it('fails closed when an existing event ID arrives with altered payload (payload tampering)', async () => {
      const payload = {
        provider: 'EMAIL' as const,
        installationId: 'mail-mx-1',
        providerEventId: 'mail-evt-tamper',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-invoice-01',
        messageId: 'msg-orig',
        text: 'Original invoice payload',
        attachmentRefs: ['art-1'],
      };

      await adapter.handleInboundWebhook(TENANT_A, payload);

      // Same providerEventId but altered attachment
      const tampered = {
        ...payload,
        text: 'Altered invoice payload text',
      };

      await expect(
        adapter.handleInboundWebhook(TENANT_A, tampered)
      ).rejects.toThrowError(HarnessError);

      await expect(
        adapter.handleInboundWebhook(TENANT_A, tampered)
      ).rejects.toThrow('CONFLICTING_EVENT_PAYLOAD');
    });
  });

  describe('Exit Criterion: Tenant Isolation', () => {
    it('prevents cross-tenant access to assignments', async () => {
      const res = await adapter.handleInboundWebhook(TENANT_A, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: 'mail-tenant-a-only',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-a',
        attachmentRefs: ['art-a'],
      });

      // Tenant B attempting to access Tenant A's assignment fails
      await expect(service.get(res.assignmentId, PRINCIPAL_B)).rejects.toThrow(
        'ASSIGNMENT_NOT_FOUND'
      );
    });

    it('isolates inbound receipts and cases across tenants even with identical providerEventId', async () => {
      // Register binding for Tenant B
      await store.registerPrincipalBinding({
        tenantId: TENANT_B,
        provider: 'EMAIL',
        installationId: 'mail-mx-corp',
        providerUserId: 'ap@corp.com',
        principalId: 'user-cfo-bob',
        roles: ['FinanceAdmin'],
        bindingRevision: 'rev-1',
        revoked: false,
      });

      const sharedEventId = 'evt-shared-uuid-001';

      const resA = await adapter.handleInboundWebhook(TENANT_A, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: sharedEventId,
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-shared',
        text: 'Tenant A invoice',
      });

      const resB = await adapter.handleInboundWebhook(TENANT_B, {
        provider: 'EMAIL',
        installationId: 'mail-mx-corp',
        providerEventId: sharedEventId,
        providerUserId: 'ap@corp.com',
        providerThreadId: 'thread-shared',
        text: 'Tenant B invoice',
      });

      expect(resA.assignmentId).not.toBe(resB.assignmentId);
      expect(resA.caseId).not.toBe(resB.caseId);
      expect(resA.isDuplicate).toBe(false);
      expect(resB.isDuplicate).toBe(false);
    });
  });

  describe('Channel Authentication & Linking Assurance', () => {
    it('fails closed when an unlinked external user sends an event', async () => {
      await expect(
        adapter.handleInboundWebhook(TENANT_A, {
          provider: 'EMAIL',
          installationId: 'mail-mx-1',
          providerEventId: 'evt-unknown-user',
          providerUserId: 'attacker@unknown.com',
          providerThreadId: 'thread-evil',
          text: 'Pay me please',
        })
      ).rejects.toThrow('UNAUTHENTICATED_CHANNEL_USER');
    });

    it('fails closed when a revoked user binding attempts to trigger work', async () => {
      await store.registerPrincipalBinding({
        tenantId: TENANT_A,
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerUserId: 'revoked-finance@blinka.com',
        principalId: 'user-ex-employee',
        roles: ['FinanceAdmin'],
        bindingRevision: 'rev-2',
        revoked: true,
      });

      await expect(
        adapter.handleInboundWebhook(TENANT_A, {
          provider: 'EMAIL',
          installationId: 'mail-mx-1',
          providerEventId: 'evt-revoked',
          providerUserId: 'revoked-finance@blinka.com',
          providerThreadId: 'thread-revoked',
          text: 'Late invoice',
        })
      ).rejects.toThrow('REVOKED_CHANNEL_USER');
    });

    it('correlates multiple messages in the same thread to the same PayableCase', async () => {
      const msg1 = await adapter.handleInboundWebhook(TENANT_A, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: 'evt-thread-msg-1',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-same-contractor',
        text: 'Initial invoice attached',
        attachmentRefs: ['art-1'],
      });

      const msg2 = await adapter.handleInboundWebhook(TENANT_A, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: 'evt-thread-msg-2',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-same-contractor',
        text: 'Supplemental contract sheet',
        attachmentRefs: ['art-2'],
      });

      expect(msg1.caseId).toBe(msg2.caseId);
      expect(msg1.assignmentId).not.toBe(msg2.assignmentId); // Distinct assignments under same case
    });
  });

  describe('State Machine & Monotonic Execution Fencing', () => {
    it('executes valid state machine progression: QUEUED -> RUNNING -> WAITING_FOR_REVIEW -> COMPLETED', async () => {
      const { assignmentId } = await adapter.handleInboundWebhook(TENANT_A, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: 'evt-workflow-test',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-workflow',
        attachmentRefs: ['art-1'],
      });

      // 1. Worker claims run (transitions QUEUED -> RUNNING with epoch 2)
      const context = await service.claimRun(
        {
          assignmentId,
          triggerRunId: 'trig-run-001',
          workerVersionId: 'v1.0.0',
          specialistRole: 'KAEL',
        },
        PRINCIPAL_A
      );

      expect(context.ownershipEpoch).toBe(2);

      let current = await service.get(assignmentId, PRINCIPAL_A);
      expect(current.state).toBe('RUNNING');
      expect(current.version).toBe(2);
      expect(current.activeRunId).toBe(context.runId);

      // 2. Advance to WAITING_FOR_REVIEW (HITL suspension)
      current = await service.advance(
        {
          assignmentId,
          expectedVersion: 2,
          next: 'WAITING_FOR_REVIEW',
          outputRefs: ['appr-req-001'],
          checkpointStage: 'AWAITING_REVIEW',
        },
        context
      );

      expect(current.state).toBe('WAITING_FOR_REVIEW');
      expect(current.version).toBe(3);

      // Verify checkpoint recorded
      const checkpoints = await store.getCheckpoints(TENANT_A, assignmentId);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]!.stage).toBe('AWAITING_REVIEW');
      expect(checkpoints[0]!.ownershipEpoch).toBe(2);

      // 3. Resume and complete after approval
      current = await service.advance(
        {
          assignmentId,
          expectedVersion: 3,
          next: 'COMPLETED',
          outputRefs: ['dec-auth-sim-001'],
          checkpointStage: 'FINISHED',
        },
        context
      );

      expect(current.state).toBe('COMPLETED');
      expect(current.version).toBe(4);
    });

    it('rejects stale version CAS attempts', async () => {
      const { assignmentId } = await adapter.handleInboundWebhook(TENANT_A, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: 'evt-cas-test',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-cas',
      });

      const context = await service.claimRun(
        {
          assignmentId,
          triggerRunId: 'trig-cas-1',
          workerVersionId: 'v1.0.0',
        },
        PRINCIPAL_A
      );

      // Attempting to advance with stale expectedVersion 1 instead of 2 fails
      await expect(
        service.advance(
          {
            assignmentId,
            expectedVersion: 1, // Stale!
            next: 'COMPLETED',
            outputRefs: [],
          },
          context
        )
      ).rejects.toThrow('STALE_ASSIGNMENT_VERSION');
    });

    it('fences out stale superseded workers when a new run has claimed ownership', async () => {
      const { assignmentId } = await adapter.handleInboundWebhook(TENANT_A, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: 'evt-epoch-test',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-epoch',
      });

      // Worker 1 claims run (epoch 2)
      const context1 = await service.claimRun(
        {
          assignmentId,
          triggerRunId: 'trig-slow-worker',
          workerVersionId: 'v1.0.0',
        },
        PRINCIPAL_A
      );

      // Worker 1 fails or times out, transitions to FAILED_RECOVERABLE
      await service.advance(
        {
          assignmentId,
          expectedVersion: 2,
          next: 'FAILED_RECOVERABLE',
          outputRefs: ['error-timeout'],
        },
        context1
      );

      // Worker 2 takes over and claims a fresh run (epoch 3)
      const context2 = await service.claimRun(
        {
          assignmentId,
          triggerRunId: 'trig-retry-worker',
          workerVersionId: 'v1.0.1',
        },
        PRINCIPAL_A
      );

      expect(context2.ownershipEpoch).toBe(3);

      // Delayed Worker 1 wakes up and attempts to advance the assignment
      await expect(
        service.advance(
          {
            assignmentId,
            expectedVersion: 4,
            next: 'COMPLETED',
            outputRefs: [],
          },
          context1 // Superseded context!
        )
      ).rejects.toThrow('STALE_OWNERSHIP_EPOCH');
    });

    it('rejects transitions on terminal states', async () => {
      const { assignmentId } = await adapter.handleInboundWebhook(TENANT_A, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: 'evt-term-test',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-term',
      });

      const context = await service.claimRun(
        {
          assignmentId,
          triggerRunId: 'trig-term',
          workerVersionId: 'v1.0.0',
        },
        PRINCIPAL_A
      );

      // Advance directly to COMPLETED
      await service.advance(
        {
          assignmentId,
          expectedVersion: 2,
          next: 'COMPLETED',
          outputRefs: ['dec-01'],
        },
        context
      );

      // Any subsequent transition attempt from COMPLETED must fail closed
      await expect(
        service.advance(
          {
            assignmentId,
            expectedVersion: 3,
            next: 'RUNNING',
            outputRefs: [],
          },
          context
        )
      ).rejects.toThrow('ASSIGNMENT_ALREADY_TERMINAL');
    });

    it('rejects invalid state jumps (e.g. QUEUED directly to COMPLETED)', async () => {
      const { assignmentId } = await adapter.handleInboundWebhook(TENANT_A, {
        provider: 'EMAIL',
        installationId: 'mail-mx-1',
        providerEventId: 'evt-invalid-jump',
        providerUserId: 'ap@blinka.com',
        providerThreadId: 'thread-jump',
      });

      // Craft forged execution context without claiming run
      const forgedContext = {
        principal: PRINCIPAL_A,
        assignmentId,
        workerPrincipalId: 'forged-worker',
        workerVersionId: 'v1',
        runId: 'fake-run',
        ownershipEpoch: 1,
      };

      await expect(
        service.advance(
          {
            assignmentId,
            expectedVersion: 1,
            next: 'COMPLETED', // Illegal from QUEUED
            outputRefs: [],
          },
          forgedContext
        )
      ).rejects.toThrow('INVALID_STATE_TRANSITION');
    });
  });
});
