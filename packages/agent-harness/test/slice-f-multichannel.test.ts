import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createL1, type L1Runtime } from '@praeco/evidence-intelligence';
import {
  createScenarioStore,
  FinancialAuthorizationService,
  L1EvidenceReaderAdapter,
  DEMO_TENANT_ID,
  type ScenarioId,
  type TransactionalFinancialStore,
} from '@praeco/financial-decision-kernel';

import {
  InMemoryHarnessStore,
  AssignmentService,
  WorkflowRunner,
  L1EvidencePortAdapter,
  L2FinancialDecisionAdapter,
  EmailChannelAdapter,
  TelegramChannelAdapter,
  WebChannelAdapter,
  ChannelNotificationService,
  type OutboxEvent,
  type TrustedPrincipal,
} from '../src/index.js';

describe('L3 Slice F — Multichannel Demo Package (Web, Email, Telegram & Notifications)', { timeout: 30_000 }, () => {
  let l1StorageDir: string;
  let l1: L1Runtime;
  let evidencePort: L1EvidencePortAdapter;
  let readerAdapter: L1EvidenceReaderAdapter;

  const demoSourcesRoot = new URL(
    '../../evidence-intelligence/test/fixtures/demo-day/sources/',
    import.meta.url
  );

  const TENANT_A = DEMO_TENANT_ID;
  const TENANT_B = 'tenant-competitor-corp';

  const CFO_PRINCIPAL: TrustedPrincipal = {
    tenantId: TENANT_A,
    principalId: 'cfo-alice',
    roles: ['FinanceAdmin', 'APReviewer'],
    bindingRevision: 'rev-1',
  };

  const scenarioStores = new Map<ScenarioId, TransactionalFinancialStore>();

  function getScenarioStore(scenarioId: ScenarioId): TransactionalFinancialStore {
    let store = scenarioStores.get(scenarioId);
    if (!store) {
      store = createScenarioStore(scenarioId);
      scenarioStores.set(scenarioId, store);
    }
    return store;
  }

  beforeAll(async () => {
    l1StorageDir = join(tmpdir(), `praeco-l3-slice-f-${randomUUID()}`);
    l1 = await createL1({
      storageRoot: l1StorageDir,
      now: () => '2026-10-17T12:00:00Z',
    });
    evidencePort = new L1EvidencePortAdapter({ l1 });
    readerAdapter = new L1EvidenceReaderAdapter(l1.reader);
  });

  afterAll(async () => {
    await rm(l1StorageDir, { recursive: true, force: true });
  });

  function createWorkflowRunner(store: InMemoryHarnessStore, scenarioId: ScenarioId = 'BLINKA-01') {
    const service = new AssignmentService({ store });
    const decisionPort = new L2FinancialDecisionAdapter({
      resolveService: (_tenantId: string) => {
        const sStore = getScenarioStore(scenarioId);
        const authService = new FinancialAuthorizationService(sStore, readerAdapter);
        return { service: authService, store: sStore };
      },
    });

    return new WorkflowRunner({
      store,
      service,
      evidencePort,
      decisionPort,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Cross-tenant Telegram lookup blocked (ADR-006 Abuse case 1)
  // ─────────────────────────────────────────────────────────────────────────────
  it('1. Cross-tenant Telegram lookup blocked (ADR-006 Abuse case 1)', async () => {
    const store = new InMemoryHarnessStore();
    const telegramAdapter = new TelegramChannelAdapter(store);

    // Tenant A has a case
    const caseIdTenantA = 'case-confidential-blinka-001';
    await store.saveCase({
      caseId: caseIdTenantA,
      tenantId: TENANT_A,
      sourceLinks: [],
      version: 1,
    });

    // User Bob is linked only to Tenant B on Telegram
    await store.registerPrincipalBinding({
      tenantId: TENANT_B,
      provider: 'TELEGRAM',
      installationId: 'tg-bot-main',
      providerUserId: 'tg-user-bob-999',
      principalId: 'cfo-bob',
      roles: ['FinanceAdmin'],
      bindingRevision: 'rev-1',
      revoked: false,
    });

    // Bob tries to query Tenant A's case
    const response = await telegramAdapter.handleUpdate({
      installationId: 'tg-bot-main',
      updateId: 101,
      message: {
        messageId: 5001,
        from: { id: 'tg-user-bob-999', firstName: 'Bob' },
        chat: { id: 8888, type: 'private' },
        text: `/status ${caseIdTenantA}`,
        date: Math.floor(Date.now() / 1000),
      },
    });

    expect(response.actionOutcome).toBe('ACCESS_DENIED');
    expect(response.text).toContain(`Case ${caseIdTenantA} not found or access denied`);
    expect(response.caseId).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Forged / stale provider webhook and payload digest tampering rejected (ADR-006 Abuse case 2 & 9)
  // ─────────────────────────────────────────────────────────────────────────────
  it('2. Forged / stale provider webhook and payload digest tampering rejected (ADR-006 Abuse case 2 & 9)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const emailAdapter = new EmailChannelAdapter(store, service);

    const pdfBuffer = Buffer.from('%PDF-1.4 synthetic invoice content');

    // 1st request with eventId
    const firstResult = await emailAdapter.handleInboundEmail({
      tenantId: TENANT_A,
      installationId: 'mail-mx-1',
      providerEventId: 'evt-unique-email-101',
      from: 'billing@vendor.com',
      to: 'ap@blinka.com',
      subject: 'Invoice #101',
      bodyText: 'Please process attached invoice',
      attachments: [{ filename: 'inv101.pdf', mimeType: 'application/pdf', content: pdfBuffer }],
    });

    expect(firstResult.isDuplicate).toBe(false);

    // 2nd request with SAME eventId but altered content
    const tamperedBuffer = Buffer.from('%PDF-1.4 TAMPERED content with changed amount');
    await expect(
      emailAdapter.handleInboundEmail({
        tenantId: TENANT_A,
        installationId: 'mail-mx-1',
        providerEventId: 'evt-unique-email-101',
        from: 'billing@vendor.com',
        to: 'ap@blinka.com',
        subject: 'Invoice #101',
        bodyText: 'MODIFIED TEXT BODY',
        attachments: [{ filename: 'inv101.pdf', mimeType: 'application/pdf', content: tamperedBuffer }],
      })
    ).rejects.toThrow(/CONFLICTING_EVENT_PAYLOAD|PAYLOAD_DIGEST_MISMATCH/);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Exact-byte email intake & replay idempotency (ADR-007 delta #4, ADR-006 Abuse case 3)
  // ─────────────────────────────────────────────────────────────────────────────
  it('3. Exact-byte email intake & replay idempotency (ADR-007 delta #4, ADR-006 Abuse case 3)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const emailAdapter = new EmailChannelAdapter(store, service);

    const pdfBytes = await readFile(new URL('01.pdf', demoSourcesRoot));
    const expectedHash = createHash('sha256').update(pdfBytes).digest('hex');

    // Ingest email
    const result1 = await emailAdapter.handleInboundEmail({
      tenantId: TENANT_A,
      installationId: 'mail-mx-1',
      providerEventId: 'evt-email-exact-01',
      from: 'contractor@bogota.co',
      to: 'ap@blinka.com',
      subject: 'Invoice 01',
      attachments: [{ filename: '01.pdf', mimeType: 'application/pdf', content: pdfBytes }],
    });

    expect(result1.isDuplicate).toBe(false);
    expect(result1.attachmentHashes).toHaveLength(1);
    expect(result1.attachmentHashes[0]).toBe(expectedHash);

    // Exact replay with same eventId and same payload
    const result2 = await emailAdapter.handleInboundEmail({
      tenantId: TENANT_A,
      installationId: 'mail-mx-1',
      providerEventId: 'evt-email-exact-01',
      from: 'contractor@bogota.co',
      to: 'ap@blinka.com',
      subject: 'Invoice 01',
      attachments: [{ filename: '01.pdf', mimeType: 'application/pdf', content: pdfBytes }],
    });

    expect(result2.isDuplicate).toBe(true);
    expect(result2.assignmentId).toBe(result1.assignmentId);
    expect(result2.caseId).toBe(result1.caseId);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Sender email spoofing does not grant authority (ADR-006 §12, Abuse case 4)
  // ─────────────────────────────────────────────────────────────────────────────
  it('4. Sender email spoofing does not grant authority (ADR-006 §12, Abuse case 4)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const emailAdapter = new EmailChannelAdapter(store, service);

    // Spoofed email pretending to be the CFO
    const result = await emailAdapter.handleInboundEmail({
      tenantId: TENANT_A,
      installationId: 'mail-mx-1',
      from: 'cfo@blinka.com', // Spoofed address
      to: 'ap@blinka.com',
      subject: 'Approve this immediately',
    });

    // Principal MUST NOT receive FinanceAdmin or APReviewer
    expect(result.principal.roles).not.toContain('FinanceAdmin');
    expect(result.principal.roles).not.toContain('APReviewer');
    expect(result.principal.roles).toContain('InboundSender');

    // Revoked user attempting email intake is blocked
    await store.registerPrincipalBinding({
      tenantId: TENANT_A,
      provider: 'EMAIL',
      installationId: 'mail-mx-1',
      providerUserId: 'ex-employee@blinka.com',
      principalId: 'user-ex-emp',
      roles: ['FinanceAdmin'],
      bindingRevision: 'rev-1',
      revoked: true,
    });

    await expect(
      emailAdapter.handleInboundEmail({
        tenantId: TENANT_A,
        installationId: 'mail-mx-1',
        from: 'ex-employee@blinka.com',
        to: 'ap@blinka.com',
        subject: 'Malicious intake',
      })
    ).rejects.toThrow(/REVOKED_CHANNEL_USER/);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Telegram linking challenge lifecycle (ADR-006 §22, Abuse case 5)
  // ─────────────────────────────────────────────────────────────────────────────
  it('5. Telegram linking challenge lifecycle (ADR-006 §22, Abuse case 5)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const webAdapter = new WebChannelAdapter(store, service);
    const telegramAdapter = new TelegramChannelAdapter(store);

    // Non-admin cannot create linking challenges
    const guestPrincipal: TrustedPrincipal = {
      tenantId: TENANT_A,
      principalId: 'guest-1',
      roles: ['InboundSender'],
      bindingRevision: 'rev-1',
    };

    await expect(
      webAdapter.createLinkingChallenge(guestPrincipal, {
        provider: 'TELEGRAM',
        installationId: 'tg-bot-main',
      })
    ).rejects.toThrow(/UNAUTHORIZED_CHALLENGE_CREATOR/);

    // CFO creates valid challenge
    const challenge = await webAdapter.createLinkingChallenge(CFO_PRINCIPAL, {
      provider: 'TELEGRAM',
      installationId: 'tg-bot-main',
      ttlSeconds: 600,
    });

    expect(challenge.token).toMatch(/^link-/);
    expect(challenge.tenantId).toBe(TENANT_A);

    // Telegram user links account
    const linkRes = await telegramAdapter.handleUpdate({
      installationId: 'tg-bot-main',
      updateId: 201,
      message: {
        messageId: 6001,
        from: { id: 'tg-cfo-user-1234', firstName: 'Alice' },
        chat: { id: 7777, type: 'private' },
        text: `/link ${challenge.token}`,
        date: Math.floor(Date.now() / 1000),
      },
    });

    expect(linkRes.actionOutcome).toBe('LINK_SUCCESS');
    expect(linkRes.text).toContain(`Account successfully linked to tenant ${TENANT_A}`);

    // Verify binding in store
    const binding = await store.getPrincipalBinding(
      TENANT_A,
      'TELEGRAM',
      'tg-bot-main',
      'tg-cfo-user-1234'
    );
    expect(binding).not.toBeNull();
    expect(binding?.roles).toContain('FinanceAdmin');
    expect(binding?.revoked).toBe(false);

    // Second attempt to use consumed challenge fails
    const reUseRes = await telegramAdapter.handleUpdate({
      installationId: 'tg-bot-main',
      updateId: 202,
      message: {
        messageId: 6002,
        from: { id: 'tg-attacker-999', firstName: 'Attacker' },
        chat: { id: 9999, type: 'private' },
        text: `/link ${challenge.token}`,
        date: Math.floor(Date.now() / 1000),
      },
    });

    expect(reUseRes.actionOutcome).toBe('LINK_FAILED');
    expect(reUseRes.text).toContain('already been used');

    // Expired challenge fails
    const expiredChallenge = await webAdapter.createLinkingChallenge(CFO_PRINCIPAL, {
      provider: 'TELEGRAM',
      installationId: 'tg-bot-main',
      ttlSeconds: -10, // already expired
    });

    const expRes = await telegramAdapter.handleUpdate({
      installationId: 'tg-bot-main',
      updateId: 203,
      message: {
        messageId: 6003,
        from: { id: 'tg-user-exp', firstName: 'User' },
        chat: { id: 7777, type: 'private' },
        text: `/link ${expiredChallenge.token}`,
        date: Math.floor(Date.now() / 1000),
      },
    });

    expect(expRes.actionOutcome).toBe('LINK_FAILED');
    expect(expRes.text).toContain('expired');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Cross-channel correlation across Web, Email, and Telegram (Slice F Exit criterion)
  // ─────────────────────────────────────────────────────────────────────────────
  it('6. Cross-channel correlation across Web, Email, and Telegram (Slice F Exit criterion)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const emailAdapter = new EmailChannelAdapter(store, service, evidencePort);
    const telegramAdapter = new TelegramChannelAdapter(store);
    const webAdapter = new WebChannelAdapter(store, service);
    const runner = createWorkflowRunner(store, 'BLINKA-01');

    // 1. Link Telegram user to CFO principal
    const challenge = await webAdapter.createLinkingChallenge(CFO_PRINCIPAL, {
      provider: 'TELEGRAM',
      installationId: 'tg-bot-main',
    });
    await telegramAdapter.handleUpdate({
      installationId: 'tg-bot-main',
      updateId: 301,
      message: {
        messageId: 7001,
        from: { id: 'tg-cfo-alice', firstName: 'Alice' },
        chat: { id: 1111, type: 'private' },
        text: `/link ${challenge.token}`,
        date: Math.floor(Date.now() / 1000),
      },
    });

    // 2. Inbound invoice via Email
    const pdfBytes = await readFile(new URL('01.pdf', demoSourcesRoot));
    const emailResult = await emailAdapter.handleInboundEmail({
      tenantId: TENANT_A,
      installationId: 'mail-mx-1',
      from: 'billing@contractor.co',
      to: 'ap@blinka.com',
      subject: 'Invoice Blinka-01',
      attachments: [{ filename: '01.pdf', mimeType: 'application/pdf', content: pdfBytes }],
    });

    const caseId = emailResult.caseId;
    const assignmentId = emailResult.assignmentId;

    // 3. Workflow runner processes assignment to completion (Blinka-01 -> AUTHORIZED_SIMULATED)
    const runResult = await runner.executeAssignmentWorkflow(
      {
        assignmentId,
        triggerRunId: 'trig-cross-01',
        sourceReference: caseId,
        requestedBudgetId: 'bud-blinka-ops',
        scenarioId: 'BLINKA-01',
      },
      CFO_PRINCIPAL
    );

    expect(runResult.outcome).toBe('AUTHORIZED_SIMULATED');
    expect(runResult.assignment.state).toBe('COMPLETED');

    // 4. Query status via linked Telegram using the exact same caseId
    const tgStatusRes = await telegramAdapter.handleUpdate({
      installationId: 'tg-bot-main',
      updateId: 302,
      message: {
        messageId: 7002,
        from: { id: 'tg-cfo-alice', firstName: 'Alice' },
        chat: { id: 1111, type: 'private' },
        text: `/status ${caseId}`,
        date: Math.floor(Date.now() / 1000),
      },
    });

    expect(tgStatusRes.actionOutcome).toBe('STATUS_REPORT');
    expect(tgStatusRes.caseId).toBe(caseId);
    expect(tgStatusRes.assignmentState).toBe('COMPLETED');
    expect(tgStatusRes.financialOutcome).toBe('AUTHORIZED_SIMULATED');
    expect(tgStatusRes.text).toContain(`Case Status: ${caseId}`);
    expect(tgStatusRes.text).toContain('AUTHORIZED_SIMULATED');

    // 5. Inspect case via Web adapter
    const webView = await webAdapter.inspectCase(CFO_PRINCIPAL, caseId);
    expect(webView.payableCase.caseId).toBe(caseId);
    expect(webView.assignments[0]!.assignmentId).toBe(assignmentId);
    expect(webView.decisions[0]!.outcome).toBe('AUTHORIZED_SIMULATED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Strict zero-paid-equivalent assertion (ADR-007 delta #4)
  // ─────────────────────────────────────────────────────────────────────────────
  it('7. Strict zero-paid-equivalent assertion (ADR-007 delta #4)', async () => {
    const store = new InMemoryHarnessStore();
    const notificationService = new ChannelNotificationService(store);

    // Register active binding
    await store.registerPrincipalBinding({
      tenantId: TENANT_A,
      provider: 'TELEGRAM',
      installationId: 'tg-bot-main',
      providerUserId: 'tg-user-valid',
      principalId: 'cfo-alice',
      roles: ['FinanceAdmin'],
      bindingRevision: 'rev-1',
      revoked: false,
    });

    // Valid notification with AUTHORIZED_SIMULATED
    const validEvent: OutboxEvent = {
      eventId: 'evt-outbox-valid-1',
      tenantId: TENANT_A,
      installationId: 'tg-bot-main',
      eventType: 'ASSIGNMENT_RESOLVED',
      commandId: 'cmd-valid-1',
      payload: {
        assignmentId: 'asg-valid-1',
        caseId: 'case-valid-1',
        outcome: 'AUTHORIZED_SIMULATED',
        decisionId: 'dec-sim-100',
      },
      occurredAt: new Date().toISOString(),
    };

    const delivery = await notificationService.sendNotification({
      event: validEvent,
      provider: 'TELEGRAM',
      installationId: 'tg-bot-main',
      recipientUserId: 'tg-user-valid',
    });

    expect(delivery.renderedText).toContain('AUTHORIZED_SIMULATED');
    expect(delivery.renderedText).not.toMatch(/\b(PAID|PAGÓ|PAGO|PAGADO|PAYMENT COMPLETED)\b/i);

    // Tampered event attempting forbidden PAID wording
    const tamperedEvent: OutboxEvent = {
      eventId: 'evt-outbox-tampered-2',
      tenantId: TENANT_A,
      installationId: 'tg-bot-main',
      eventType: 'PAYMENT_SENT',
      commandId: 'cmd-bad-2',
      payload: {
        outcome: 'PAID', // FORBIDDEN!
      },
      occurredAt: new Date().toISOString(),
    };

    await expect(
      notificationService.sendNotification({
        event: tamperedEvent,
        provider: 'TELEGRAM',
        installationId: 'tg-bot-main',
        recipientUserId: 'tg-user-valid',
      })
    ).rejects.toThrow(/FORBIDDEN_PAID_EQUIVALENT_WORDING/);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Revocation between enqueue and send blocks private invoice details (ADR-006 §31, Abuse case 10)
  // ─────────────────────────────────────────────────────────────────────────────
  it('8. Revocation between enqueue and send blocks private invoice details (ADR-006 §31, Abuse case 10)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const webAdapter = new WebChannelAdapter(store, service);
    const notificationService = new ChannelNotificationService(store);

    // Initial binding active
    await store.registerPrincipalBinding({
      tenantId: TENANT_A,
      provider: 'TELEGRAM',
      installationId: 'tg-bot-main',
      providerUserId: 'tg-user-revocable',
      principalId: 'user-contractor-charlie',
      roles: ['APReviewer'],
      bindingRevision: 'rev-1',
      revoked: false,
    });

    // Outbox event enqueued while active
    const event: OutboxEvent = {
      eventId: 'evt-outbox-revoked-user-1',
      tenantId: TENANT_A,
      installationId: 'tg-bot-main',
      eventType: 'ASSIGNMENT_RESOLVED',
      commandId: 'cmd-rev-1',
      payload: {
        assignmentId: 'asg-secret-999',
        caseId: 'case-secret-999',
        outcome: 'AUTHORIZED_SIMULATED',
        decisionId: 'dec-confidential-888',
      },
      occurredAt: new Date().toISOString(),
    };

    // Before send, admin revokes binding!
    await webAdapter.revokePrincipalBinding(CFO_PRINCIPAL, {
      provider: 'TELEGRAM',
      installationId: 'tg-bot-main',
      providerUserId: 'tg-user-revocable',
    });

    // Notification is dispatched
    const delivery = await notificationService.sendNotification({
      event,
      provider: 'TELEGRAM',
      installationId: 'tg-bot-main',
      recipientUserId: 'tg-user-revocable',
    });

    expect(delivery.isRedactedDueToRevocation).toBe(true);
    expect(delivery.renderedText).toContain('[Praeco Security Notice]');
    expect(delivery.renderedText).toContain('Details are withheld');
    expect(delivery.renderedText).not.toContain('asg-secret-999');
    expect(delivery.renderedText).not.toContain('dec-confidential-888');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Telegram chat message saying "approve" cannot bypass L2 (ADR-006 §30, Abuse case 6)
  // ─────────────────────────────────────────────────────────────────────────────
  it('9. Telegram chat message saying "approve" cannot bypass L2 (ADR-006 §30, Abuse case 6)', async () => {
    const store = new InMemoryHarnessStore();
    const telegramAdapter = new TelegramChannelAdapter(store);

    // Even if linked
    await store.registerPrincipalBinding({
      tenantId: TENANT_A,
      provider: 'TELEGRAM',
      installationId: 'tg-bot-main',
      providerUserId: 'tg-user-alice',
      principalId: 'cfo-alice',
      roles: ['FinanceAdmin'],
      bindingRevision: 'rev-1',
      revoked: false,
    });

    const response = await telegramAdapter.handleUpdate({
      installationId: 'tg-bot-main',
      updateId: 401,
      message: {
        messageId: 8001,
        from: { id: 'tg-user-alice', firstName: 'Alice' },
        chat: { id: 1111, type: 'private' },
        text: 'approve case-12345',
        date: Math.floor(Date.now() / 1000),
      },
    });

    expect(response.actionOutcome).toBe('APPROVAL_REJECTED');
    expect(response.text).toContain('Financial authorization cannot be granted via Telegram');
    expect(response.text).toContain('strictly require an authenticated FinanceAdmin web session');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Colliding event/installation isolation across tenants (ADR-006 Abuse case 9)
  // ─────────────────────────────────────────────────────────────────────────────
  it('10. Colliding event/installation isolation across tenants (ADR-006 Abuse case 9)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const emailAdapter = new EmailChannelAdapter(store, service);

    const collidingEventId = 'evt-colliding-fixed-id';
    const collidingUserId = 'billing@shared-domain.com';

    // Tenant A intake
    const resA = await emailAdapter.handleInboundEmail({
      tenantId: TENANT_A,
      installationId: 'mail-mx-us',
      providerEventId: collidingEventId,
      from: collidingUserId,
      to: 'ap@blinka.com',
      subject: 'Tenant A Bill',
    });

    // Tenant B intake with SAME eventId and SAME sender on different installation
    const resB = await emailAdapter.handleInboundEmail({
      tenantId: TENANT_B,
      installationId: 'mail-mx-eu',
      providerEventId: collidingEventId,
      from: collidingUserId,
      to: 'ap@othercorp.com',
      subject: 'Tenant B Bill',
    });

    expect(resA.assignmentId).not.toBe(resB.assignmentId);
    expect(resA.caseId).not.toBe(resB.caseId);
    expect(resA.isDuplicate).toBe(false);
    expect(resB.isDuplicate).toBe(false);

    // Verify store isolation
    const caseA = await store.getCase(TENANT_A, resA.caseId);
    const caseB = await store.getCase(TENANT_B, resB.caseId);
    expect(caseA).not.toBeNull();
    expect(caseB).not.toBeNull();
    expect(caseA?.tenantId).toBe(TENANT_A);
    expect(caseB?.tenantId).toBe(TENANT_B);

    // Tenant A cannot read Tenant B's case
    const crossCase = await store.getCase(TENANT_A, resB.caseId);
    expect(crossCase).toBeNull();
  });
});
