import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createL1, type L1Runtime } from '@praeco/evidence-intelligence';
import { DEMO_TENANT_ID } from '@praeco/financial-decision-kernel';

import {
  InMemoryHarnessStore,
  AssignmentService,
  L1EvidencePortAdapter,
  AgentMailChannelAdapter,
  createEveTools,
  toAiSdkTools,
  AiSdkSpecialistRunner,
  InMemoryChannelInbox,
  type AgentMailWebhookPayload,
  type TrustedExecutionContext,
} from '../src/index.js';

describe('L3 AgentMail & Vercel AI SDK Channel Ingestion Pipeline', { timeout: 30_000 }, () => {
  let l1StorageDir: string;
  let l1: L1Runtime;
  let evidencePort: L1EvidencePortAdapter;

  const demoSourcesRoot = new URL(
    '../../evidence-intelligence/test/fixtures/demo-day/sources/',
    import.meta.url
  );

  const TENANT_A = DEMO_TENANT_ID;
  const TENANT_B = 'tenant-competitor-corp';
  const WEBHOOK_SECRET = 'synthetic-agentmail-secret-key-12345';

  beforeAll(async () => {
    l1StorageDir = join(tmpdir(), `praeco-l3-agentmail-${randomUUID()}`);
    l1 = await createL1({
      storageRoot: l1StorageDir,
      now: () => '2026-10-18T12:00:00Z',
    });
    evidencePort = new L1EvidencePortAdapter({ l1 });
  });

  afterAll(async () => {
    await rm(l1StorageDir, { recursive: true, force: true });
  });

  function signPayload(messageId: string, from: string, timestamp: number | string, secret: string = WEBHOOK_SECRET): string {
    const signedPayload = `${messageId}:${from}:${timestamp}`;
    return createHmac('sha256', secret).update(signedPayload).digest('hex');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Webhook HMAC-SHA256 Signature Verification
  // ─────────────────────────────────────────────────────────────────────────────
  it('1. Webhook HMAC-SHA256 signature verification (valid, missing, forged)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const adapter = new AgentMailChannelAdapter({
      store,
      service,
      webhookSecret: WEBHOOK_SECRET,
    });

    const now = Date.now();
    const messageId = `msg-${randomUUID()}`;
    const from = 'billing@vendor.com';

    // A. Valid signature passes
    const validSignature = signPayload(messageId, from, now, WEBHOOK_SECRET);
    const validPayload: AgentMailWebhookPayload = {
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId,
      from,
      to: 'ap@blinka.com',
      subject: 'Invoice #1001',
      text: 'Please find attached invoice #1001',
      timestamp: now,
      signature: validSignature,
    };

    const res = await adapter.handleAgentMailWebhook(validPayload);
    expect(res.assignmentId).toBeDefined();
    expect(res.isDuplicate).toBe(false);

    // B. Missing signature throws INVALID_WEBHOOK_SIGNATURE
    const missingSigPayload: AgentMailWebhookPayload = {
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId: `msg-${randomUUID()}`,
      from,
      to: 'ap@blinka.com',
      subject: 'Invoice #1002',
      timestamp: now,
    };
    await expect(adapter.handleAgentMailWebhook(missingSigPayload)).rejects.toThrow(
      'AgentMail webhook signature is missing but webhookSecret is configured'
    );

    // C. Forged / invalid signature throws INVALID_WEBHOOK_SIGNATURE
    const forgedSigPayload: AgentMailWebhookPayload = {
      ...missingSigPayload,
      signature: 'deadbeef1234567890abcdefdeadbeef1234567890abcdefdeadbeef12345678',
    };
    await expect(adapter.handleAgentMailWebhook(forgedSigPayload)).rejects.toThrow(
      'AgentMail webhook signature verification failed'
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Timestamp Replay Defense
  // ─────────────────────────────────────────────────────────────────────────────
  it('2. Timestamp replay defense: rejects stale or future-skewed webhooks', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const fakeNow = 1_700_000_000_000;
    const adapter = new AgentMailChannelAdapter({
      store,
      service,
      clockSkewToleranceMs: 300_000, // 5 minutes
      now: () => fakeNow,
    });

    const from = 'billing@vendor.com';

    // A. Stale webhook (6 minutes old) -> rejects with STALE_WEBHOOK_TIMESTAMP
    const staleTime = fakeNow - 360_000;
    const stalePayload: AgentMailWebhookPayload = {
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId: `msg-stale-${randomUUID()}`,
      from,
      to: 'ap@blinka.com',
      subject: 'Stale webhook replay',
      timestamp: staleTime,
    };
    await expect(adapter.handleAgentMailWebhook(stalePayload)).rejects.toThrow(
      'exceeds clock skew tolerance of 300000ms'
    );

    // B. Future-dated webhook (> 5 minutes ahead) -> rejects
    const futureTime = fakeNow + 360_000;
    const futurePayload: AgentMailWebhookPayload = {
      ...stalePayload,
      messageId: `msg-future-${randomUUID()}`,
      timestamp: futureTime,
    };
    await expect(adapter.handleAgentMailWebhook(futurePayload)).rejects.toThrow(
      'exceeds clock skew tolerance of 300000ms'
    );

    // C. Fresh webhook (within tolerance) -> succeeds
    const freshPayload: AgentMailWebhookPayload = {
      ...stalePayload,
      messageId: `msg-fresh-${randomUUID()}`,
      timestamp: fakeNow - 60_000, // 1 minute ago
    };
    const res = await adapter.handleAgentMailWebhook(freshPayload);
    expect(res.assignmentId).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Untrusted Sender Rule (DEMO-002, ADR-006 §12, Abuse case 4)
  // ─────────────────────────────────────────────────────────────────────────────
  it('3. Sender email spoofing does not grant authority (ADR-006 §12, DEMO-002)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const adapter = new AgentMailChannelAdapter({ store, service });

    // Senders spoofing CFO email or vendor address without pre-registered binding
    const spoofedCfoEmail = 'alice.cfo@blinka.com';
    const payload: AgentMailWebhookPayload = {
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId: `msg-spoofed-${randomUUID()}`,
      from: spoofedCfoEmail,
      to: 'ap@blinka.com',
      subject: 'Approve this immediately',
      text: 'Please approve payment of $10,000 to vendor',
    };

    const res = await adapter.handleAgentMailWebhook(payload);
    // Verified: assigned lowest privilege InboundSender role
    expect(res.principal.roles).toEqual(['InboundSender']);
    expect(res.principal.roles).not.toContain('FinanceAdmin');
    expect(res.principal.roles).not.toContain('APReviewer');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Revoked Principal Binding Defense (ADR-006 Abuse case 5)
  // ─────────────────────────────────────────────────────────────────────────────
  it('4. Revoked principal binding defense (ADR-006 Abuse case 5)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const adapter = new AgentMailChannelAdapter({ store, service });

    const revokedUser = 'former.contractor@vendor.com';

    // Register a revoked binding
    await store.registerPrincipalBinding({
      tenantId: TENANT_A,
      provider: 'AGENTMAIL',
      installationId: 'inst-agentmail-01',
      providerUserId: revokedUser,
      principalId: 'contractor-bob',
      roles: ['InboundSender'],
      bindingRevision: 'rev-2',
      revoked: true,
    });

    const payload: AgentMailWebhookPayload = {
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId: `msg-revoked-${randomUUID()}`,
      from: revokedUser,
      to: 'ap@blinka.com',
      subject: 'Attempted invoice intake after revocation',
    };

    await expect(adapter.handleAgentMailWebhook(payload)).rejects.toThrow(
      'is revoked'
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. File Signature & Magic Bytes Validation
  // ─────────────────────────────────────────────────────────────────────────────
  it('5. File signature & magic bytes validation (PDF, PNG, JPEG)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const adapter = new AgentMailChannelAdapter({ store, service });

    // A. Fake PDF (does not start with %PDF-) -> throws INVALID_FILE_SIGNATURE
    const fakePdfBytes = Buffer.from('NOT A REAL PDF FILE HEADER', 'utf8');
    const fakePdfPayload: AgentMailWebhookPayload = {
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId: `msg-fakepdf-${randomUUID()}`,
      from: 'vendor@billing.com',
      to: 'ap@blinka.com',
      subject: 'Invoice PDF',
      attachments: [
        {
          filename: 'invoice.pdf',
          mimeType: 'application/pdf',
          content: fakePdfBytes,
        },
      ],
    };

    await expect(adapter.handleAgentMailWebhook(fakePdfPayload)).rejects.toThrow(
      'lacks valid %PDF- magic signature'
    );

    // B. Fake PNG (does not have PNG magic bytes) -> throws INVALID_FILE_SIGNATURE
    const fakePngPayload: AgentMailWebhookPayload = {
      ...fakePdfPayload,
      messageId: `msg-fakepng-${randomUUID()}`,
      attachments: [
        {
          filename: 'receipt.png',
          mimeType: 'image/png',
          content: Buffer.from('HELLO PNG TEST', 'utf8'),
        },
      ],
    };

    await expect(adapter.handleAgentMailWebhook(fakePngPayload)).rejects.toThrow(
      'lacks valid PNG signature'
    );

    // C. Valid minimal PDF magic bytes -> passes
    const validMinimalPdf = Buffer.from('%PDF-1.4\n%synthetic test pdf content\n%%EOF', 'utf8');
    const validPdfPayload: AgentMailWebhookPayload = {
      ...fakePdfPayload,
      messageId: `msg-validpdf-${randomUUID()}`,
      attachments: [
        {
          filename: 'valid.pdf',
          mimeType: 'application/pdf',
          content: validMinimalPdf,
        },
      ],
    };

    const res = await adapter.handleAgentMailWebhook(validPdfPayload);
    expect(res.assignmentId).toBeDefined();
    expect(res.attachmentHashes.length).toBe(1);
    expect(res.attachmentHashes[0]).toBe(
      createHash('sha256').update(validMinimalPdf).digest('hex')
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Oversized Attachment Rejection (> 20 MB)
  // ─────────────────────────────────────────────────────────────────────────────
  it('6. Oversized attachment rejection (> 20 MB)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const adapter = new AgentMailChannelAdapter({ store, service });

    // Construct an oversized buffer exceeding 20 MB (20MB + 1KB)
    const oversizedBytes = new Uint8Array(20 * 1024 * 1024 + 1024);
    oversizedBytes.set(Buffer.from('%PDF-1.4'));

    const oversizedPayload: AgentMailWebhookPayload = {
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId: `msg-oversized-${randomUUID()}`,
      from: 'vendor@billing.com',
      to: 'ap@blinka.com',
      subject: 'Oversized invoice',
      attachments: [
        {
          filename: 'huge_invoice.pdf',
          mimeType: 'application/pdf',
          content: oversizedBytes,
        },
      ],
    };

    await expect(adapter.handleAgentMailWebhook(oversizedPayload)).rejects.toThrow(
      'exceeds maximum size limit of 20MB'
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Technical Idempotency & Tamper Detection (ADR-006 §36, Abuse case 3 & 9)
  // ─────────────────────────────────────────────────────────────────────────────
  it('7. Technical idempotency & conflicting payload detection (ADR-006 §36)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const adapter = new AgentMailChannelAdapter({ store, service });

    const messageId = `msg-idemp-${randomUUID()}`;
    const pdfBytes = Buffer.from('%PDF-1.4\nTest invoice\n%%EOF', 'utf8');

    const payload: AgentMailWebhookPayload = {
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId,
      from: 'vendor@billing.com',
      to: 'ap@blinka.com',
      subject: 'Invoice #4001',
      attachments: [
        {
          filename: 'inv.pdf',
          mimeType: 'application/pdf',
          content: pdfBytes,
        },
      ],
    };

    // First delivery -> creates assignment
    const first = await adapter.handleAgentMailWebhook(payload);
    expect(first.isDuplicate).toBe(false);

    // Replay identical delivery -> idempotent, returns winning assignment
    const replay = await adapter.handleAgentMailWebhook(payload);
    expect(replay.isDuplicate).toBe(true);
    expect(replay.assignmentId).toBe(first.assignmentId);

    // Tampered payload with same messageId/eventId -> throws CONFLICTING_EVENT_PAYLOAD
    const tamperedPayload: AgentMailWebhookPayload = {
      ...payload,
      text: 'TAMPERED BODY TEXT',
    };

    await expect(adapter.handleAgentMailWebhook(tamperedPayload)).rejects.toThrow();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Strict Cross-Tenant Isolation
  // ─────────────────────────────────────────────────────────────────────────────
  it('8. Cross-tenant isolation across AgentMail inbounds', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const adapter = new AgentMailChannelAdapter({ store, service });

    const messageId = `msg-tenant-${randomUUID()}`;
    const payloadA: AgentMailWebhookPayload = {
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId,
      from: 'vendor@billing.com',
      to: 'ap@blinka.com',
      subject: 'Tenant A Invoice',
    };

    const resA = await adapter.handleAgentMailWebhook(payloadA);
    expect(resA.principal.tenantId).toBe(TENANT_A);

    // Tenant B cannot load Tenant A's assignment
    const tenantBAssignment = await store.getAssignment(TENANT_B, resA.assignmentId);
    expect(tenantBAssignment).toBeNull();

    // Tenant B cannot load Tenant A's case
    const tenantBCase = await store.getCase(TENANT_B, resA.caseId);
    expect(tenantBCase).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Vercel AI SDK Tool Generation & Bounded Specialist Loop (Eve)
  // ─────────────────────────────────────────────────────────────────────────────
  it('9. Vercel AI SDK tool adaptation & bounded specialist loop execution', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const inbox = new InMemoryChannelInbox();

    const pdfBytes = Buffer.from('%PDF-1.4\nInvoice for Acme Corp\n%%EOF', 'utf8');
    const msgId = `msg-eve-${randomUUID()}`;

    // Seed message in inbox
    inbox.addMessage({
      id: msgId,
      connectionId: 'inst-agentmail-01',
      provider: 'AGENTMAIL',
      from: 'billing@acme.com',
      to: 'ap@blinka.com',
      subject: 'Acme Invoice #8801',
      text: 'Invoice attached',
      attachments: [
        {
          filename: 'acme-invoice.pdf',
          mimeType: 'application/pdf',
          content: pdfBytes,
        },
      ],
      receivedAt: new Date().toISOString(),
      status: 'PENDING',
    });

    // Create Eve tools
    const eveTools = createEveTools({
      store,
      service,
      inbox,
      evidencePort,
    });

    const executionCtx: TrustedExecutionContext = {
      principal: {
        tenantId: TENANT_A,
        principalId: 'eve-runner',
        roles: ['EveSpecialist'],
        bindingRevision: 'rev-1',
      },
      assignmentId: `asg-eve-${randomUUID()}`,
      workerPrincipalId: 'worker-ai-sdk',
      workerVersionId: 'v1.0.0',
      runId: `run-eve-${randomUUID()}`,
      ownershipEpoch: 1,
    };

    // Adapt to standard Vercel AI SDK tools
    const aiSdkTools = toAiSdkTools(eveTools, executionCtx);
    expect(aiSdkTools['eve_fetch_channel_inbox']).toBeDefined();
    expect(aiSdkTools['eve_inspect_inbound_message']).toBeDefined();
    expect(aiSdkTools['eve_extract_and_validate_attachment']).toBeDefined();
    expect(aiSdkTools['eve_ingest_document_to_l1']).toBeDefined();
    expect(aiSdkTools['eve_correlate_payable_case']).toBeDefined();

    // Execute bounded loop using AiSdkSpecialistRunner
    const runner = new AiSdkSpecialistRunner({ limits: { maxSteps: 6, timeoutMs: 15_000 } });

    const result = await runner.executeBoundedLoop(
      'EVE',
      aiSdkTools,
      [
        {
          toolName: 'eve_fetch_channel_inbox',
          params: { status: 'PENDING', limit: 5 },
        },
        {
          toolName: 'eve_inspect_inbound_message',
          params: { messageId: msgId },
        },
        {
          toolName: 'eve_extract_and_validate_attachment',
          params: { messageId: msgId, filename: 'acme-invoice.pdf' },
        },
        {
          toolName: 'eve_correlate_payable_case',
          params: { messageId: msgId },
        },
      ],
      executionCtx
    );

    expect(result.role).toBe('EVE');
    expect(result.stepsExecuted).toBe(4);
    expect(result.history.length).toBe(4);

    // Verify step 2 output inspected sender
    const step2Record = result.history[1]!;
    expect(step2Record.toolName).toBe('eve_inspect_inbound_message');
    expect(step2Record.outputSummary).toContain('UNVERIFIED_EXTERNAL_SENDER');

    // Verify step 3 validated attachment
    const step3Record = result.history[2]!;
    expect(step3Record.toolName).toBe('eve_extract_and_validate_attachment');
    expect(step3Record.outputSummary).toContain('"isValidDocument":true');

    // Verify message marked processed in inbox
    const updatedMsg = await inbox.getMessage(msgId);
    expect(updatedMsg?.status).toBe('PROCESSED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. AI SDK Bounds Enforcement (maxSteps and timeoutMs)
  // ─────────────────────────────────────────────────────────────────────────────
  it('10. AI SDK bounds enforcement: maxSteps and timeout bounds fail closed', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const inbox = new InMemoryChannelInbox();
    const eveTools = createEveTools({ store, service, inbox });

    const executionCtx: TrustedExecutionContext = {
      principal: {
        tenantId: TENANT_A,
        principalId: 'test-runner',
        roles: ['EveSpecialist'],
        bindingRevision: 'rev-1',
      },
      assignmentId: `asg-limit-${randomUUID()}`,
      workerPrincipalId: 'worker-limit',
      workerVersionId: 'v1.0.0',
      runId: `run-limit-${randomUUID()}`,
      ownershipEpoch: 1,
    };

    const aiSdkTools = toAiSdkTools(eveTools, executionCtx);

    // A. maxSteps exceeded throws MAX_STEPS_EXCEEDED
    const tightRunner = new AiSdkSpecialistRunner({ limits: { maxSteps: 2, timeoutMs: 15_000 } });
    await expect(
      tightRunner.executeBoundedLoop(
        'EVE',
        aiSdkTools,
        [
          { toolName: 'eve_fetch_channel_inbox', params: {} },
          { toolName: 'eve_fetch_channel_inbox', params: {} },
          { toolName: 'eve_fetch_channel_inbox', params: {} }, // 3rd step exceeds budget of 2
        ],
        executionCtx
      )
    ).rejects.toThrow('exceeded maximum step budget of 2 steps');

    // B. timeoutMs exceeded throws EXECUTION_DEADLINE_EXCEEDED
    const timeoutRunner = new AiSdkSpecialistRunner({ limits: { maxSteps: 5, timeoutMs: 0 } });
    await expect(
      timeoutRunner.executeBoundedLoop(
        'EVE',
        aiSdkTools,
        [
          { toolName: 'eve_fetch_channel_inbox', params: {} },
          { toolName: 'eve_fetch_channel_inbox', params: {} },
        ],
        executionCtx
      )
    ).rejects.toThrow('exceeded wall-clock timeout deadline');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. End-to-End Real L1 Integration Flow
  // ─────────────────────────────────────────────────────────────────────────────
  it('11. End-to-end real L1 invoice processing through AgentMail adapter', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const adapter = new AgentMailChannelAdapter({
      store,
      service,
      evidencePort,
    });

    const realPdfBytes = await readFile(new URL('01.pdf', demoSourcesRoot));
    const messageId = `msg-e2e-${randomUUID()}`;

    const payload: AgentMailWebhookPayload = {
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId,
      from: 'billing@apex-office.com',
      to: 'ap@blinka.com',
      subject: 'Monthly Supply Invoice #1042',
      text: 'Please find attached the monthly supply invoice.',
      attachments: [
        {
          filename: 'Apex-Invoice-1042.pdf',
          mimeType: 'application/pdf',
          content: realPdfBytes,
        },
      ],
    };

    const result = await adapter.handleAgentMailWebhook(payload);
    expect(result.assignmentId).toBeDefined();
    expect(result.caseId).toBeDefined();
    expect(result.isDuplicate).toBe(false);
    expect(result.evidenceRef).toBeDefined();

    // Verify L1 evidence was generated
    const evRef = result.evidenceRef!;
    expect(evRef.sourceId).toBeDefined();
    expect(evRef.sourceHashSha256).toBe(
      createHash('sha256').update(realPdfBytes).digest('hex')
    );
    expect(evRef.sourceDisposition).toBe('INVOICE_OR_UNCERTAIN');
    expect(evRef.envelopeIds.length).toBeGreaterThanOrEqual(1);

    // Verify PayableCase links the document evidence
    const c = await store.getCase(TENANT_A, result.caseId);
    expect(c).toBeDefined();
    expect(c!.sourceLinks.length).toBe(1);
    expect(c!.sourceLinks[0]!.kind).toBe('DOCUMENT');

    // Verify Assignment exists in QUEUED state
    const assignment = await store.getAssignment(TENANT_A, result.assignmentId);
    expect(assignment).toBeDefined();
    expect(assignment!.state).toBe('QUEUED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Strict Zero-Paid-Equivalent Assertion (ADR-007 delta #4)
  // ─────────────────────────────────────────────────────────────────────────────
  it('12. Zero paid-equivalent assertion across AgentMail and Eve surfaces (ADR-007 delta #4)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const inbox = new InMemoryChannelInbox();
    const adapter = new AgentMailChannelAdapter({ store, service });

    const payload: AgentMailWebhookPayload = {
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId: `msg-paidcheck-${randomUUID()}`,
      from: 'billing@vendor.com',
      to: 'ap@blinka.com',
      subject: 'Invoice settlement check',
      text: 'Invoice marked for processing',
    };

    const res = await adapter.handleAgentMailWebhook(payload);
    const serialized = JSON.stringify(res);

    // Hard financial safety: NEVER emit PAID or paid-equivalent language
    expect(serialized).not.toMatch(/"state":"PAID"/);
    expect(serialized).not.toMatch(/"status":"PAID"/);
    expect(serialized).not.toMatch(/"outcome":"PAID"/);
    expect(serialized).not.toMatch(/"outcome":"PAGO"/i);

    const eveTools = createEveTools({ store, service, inbox });
    for (const tool of eveTools) {
      expect(tool.description).not.toMatch(/\bpaid\b/i);
    }
  });
});

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('AgentMail & AI SDK Intake — Neon PostgreSQL operational boundary', () => {
  let sqlStore: any;

  beforeAll(async () => {
    const { SqlHarnessStore } = await import('../src/index.js');
    sqlStore = await SqlHarnessStore.connect(databaseUrl!);
  });

  afterAll(async () => {
    await sqlStore?.close();
  });

  it('13. AgentMail transactional delivery & duplicate idempotency against live Neon PostgreSQL', async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const service = new AssignmentService({ store: sqlStore });
    const adapter = new AgentMailChannelAdapter({ store: sqlStore, service });

    const messageId = `msg-sql-${randomUUID()}`;
    const pdfBytes = Buffer.from('%PDF-1.4\nNeon PostgreSQL Live Intake Test\n%%EOF', 'utf8');

    const payload: AgentMailWebhookPayload = {
      tenantId,
      installationId: 'inst-neon-agentmail',
      messageId,
      from: 'neon-vendor@example.com',
      to: 'ap@neon-blinka.com',
      subject: 'Neon Inbound Invoice',
      attachments: [
        {
          filename: 'neon-invoice.pdf',
          mimeType: 'application/pdf',
          content: pdfBytes,
        },
      ],
    };

    // 1. First transactional delivery -> wins
    const first = await adapter.handleAgentMailWebhook(payload);
    expect(first.isDuplicate).toBe(false);
    expect(first.assignmentId).toBeDefined();

    // 2. Duplicate redelivery -> idempotent, returns winning assignment
    const replay = await adapter.handleAgentMailWebhook(payload);
    expect(replay.isDuplicate).toBe(true);
    expect(replay.assignmentId).toBe(first.assignmentId);

    // 3. Stored assignment matches
    const loaded = await sqlStore.getAssignment(tenantId, first.assignmentId);
    expect(loaded).toBeDefined();
    expect(loaded!.state).toBe('QUEUED');
  });
});

