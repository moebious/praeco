import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createL1, type L1Runtime } from '@praeco/evidence-intelligence';
import { DEMO_TENANT_ID } from '@praeco/financial-decision-kernel';

import { z } from 'zod';
import {
  InMemoryHarnessStore,
  AssignmentService,
  L1EvidencePortAdapter,
  AgentMailChannelAdapter,
  createEveTools,
  toAiSdkTools,
  AiSdkSpecialistRunner,
  InMemoryChannelInbox,
  computeAgentMailSignature,
  computeAgentMailContentDigest,
  type AgentMailWebhookPayload,
  type TrustedExecutionContext,
  type SpecialistToolDefinition,
} from '../src/index.js';

describe('L3 AgentMail & Vercel AI SDK Channel Ingestion Pipeline', { timeout: 60_000 }, () => {
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

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Webhook HMAC-SHA256 Signature Verification & Tamper Resistance
  // ─────────────────────────────────────────────────────────────────────────────
  it('1. Webhook HMAC-SHA256 signature verification (valid, tampered, raw body, missing, forged)', async () => {
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

    // A. Valid canonical content digest signature passes
    const basePayload: AgentMailWebhookPayload = {
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId,
      from,
      to: 'ap@blinka.com',
      subject: 'Invoice #1001',
      text: 'Please find attached invoice #1001',
      timestamp: now,
      attachments: [
        {
          filename: 'invoice-1001.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('%PDF-1.4\nInvoice 1001 content\n%%EOF', 'utf8'),
        },
      ],
    };

    const digest = computeAgentMailContentDigest(basePayload);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);

    const validSignature = computeAgentMailSignature(basePayload, WEBHOOK_SECRET);
    const validPayload: AgentMailWebhookPayload = {
      ...basePayload,
      signature: validSignature,
    };

    const res = await adapter.handleAgentMailWebhook(validPayload);
    expect(res.assignmentId).toBeDefined();
    expect(res.isDuplicate).toBe(false);

    // B. Tampering with body text invalidates signature
    const tamperedBodyPayload: AgentMailWebhookPayload = {
      ...validPayload,
      text: 'Tampered invoice amount $999,999 to foreign account',
    };
    await expect(adapter.handleAgentMailWebhook(tamperedBodyPayload)).rejects.toThrow(
      'AgentMail webhook signature verification failed'
    );

    // C. Tampering with invoice attachment invalidates signature
    const tamperedAttachmentPayload: AgentMailWebhookPayload = {
      ...validPayload,
      attachments: [
        {
          filename: 'invoice-1001.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('%PDF-1.4\nMalicious substituted PDF bytes\n%%EOF', 'utf8'),
        },
      ],
    };
    await expect(adapter.handleAgentMailWebhook(tamperedAttachmentPayload)).rejects.toThrow(
      'AgentMail webhook signature verification failed'
    );

    // D. Raw body signature verification passes with matching raw payload
    const rawMsgId = `msg-raw-${randomUUID()}`;
    const rawBodyJson = JSON.stringify({ messageId: rawMsgId, from, to: 'ap@blinka.com', subject: 'Invoice #raw', amount: 500 });
    const rawBodySig = computeAgentMailSignature(basePayload, WEBHOOK_SECRET, rawBodyJson);
    const rawBodyPayload: AgentMailWebhookPayload = {
      ...basePayload,
      messageId: rawMsgId,
      subject: 'Invoice #raw',
      signature: rawBodySig,
    };
    const rawRes = await adapter.handleAgentMailWebhook(rawBodyPayload, undefined, rawBodyJson);
    expect(rawRes.assignmentId).toBeDefined();

    // E. Tampering with rawBody causes signature mismatch
    await expect(
      adapter.handleAgentMailWebhook(rawBodyPayload, undefined, rawBodyJson + ' ')
    ).rejects.toThrow('AgentMail webhook signature verification failed');

    // F. Missing signature throws INVALID_WEBHOOK_SIGNATURE
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

    // G. Forged / invalid signature throws INVALID_WEBHOOK_SIGNATURE
    const forgedSigPayload: AgentMailWebhookPayload = {
      ...missingSigPayload,
      signature: 'deadbeef1234567890abcdefdeadbeef1234567890abcdefdeadbeef12345678',
    };
    await expect(adapter.handleAgentMailWebhook(forgedSigPayload)).rejects.toThrow(
      'AgentMail webhook signature verification failed'
    );

    // H. Adversarial: Raw-body authentication mismatch attack (signed Tenant A raw body, passed modified payload targeting Tenant B)
    const rawBodyTenantA = JSON.stringify({
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId: `msg-mismatch-${randomUUID()}`,
      from: 'vendor@billing.com',
      to: 'ap@blinka.com',
      subject: 'Invoice for Tenant A',
      timestamp: now,
    });
    const sigTenantA = computeAgentMailSignature(basePayload, WEBHOOK_SECRET, rawBodyTenantA);
    const spoofedPayloadTenantB: AgentMailWebhookPayload = {
      tenantId: TENANT_B,
      installationId: 'inst-agentmail-01',
      messageId: `msg-mismatch-${randomUUID()}`,
      from: 'vendor@billing.com',
      to: 'ap@blinka.com',
      subject: 'Invoice for Tenant A',
      timestamp: now,
      signature: sigTenantA,
    };
    await expect(
      adapter.handleAgentMailWebhook(spoofedPayloadTenantB, undefined, rawBodyTenantA)
    ).rejects.toThrow(`Supplied payload tenantId (${TENANT_B}) does not match authenticated rawBody tenantId (${TENANT_A})`);

    // Zero side-effects assertion: no assignments or cases created in either tenant
    expect(await store.listAssignments(TENANT_B)).toHaveLength(0);

    // I. Adversarial: Correlation target binding (modifying threadId invalidates signature)
    const payloadWithThread: AgentMailWebhookPayload = {
      ...basePayload,
      messageId: `msg-thread-${randomUUID()}`,
      threadId: 'thread-case-alpha',
    };
    const sigWithThread = computeAgentMailSignature(payloadWithThread, WEBHOOK_SECRET);
    const alteredThreadPayload: AgentMailWebhookPayload = {
      ...payloadWithThread,
      threadId: 'thread-case-beta', // attacker re-targets invoice to different payable case
      signature: sigWithThread,
    };
    await expect(adapter.handleAgentMailWebhook(alteredThreadPayload)).rejects.toThrow(
      'AgentMail webhook signature verification failed'
    );

    // J. Adversarial: Canonical JSON encoding resists delimiter injection collisions
    const combo1: AgentMailWebhookPayload = {
      ...basePayload,
      tenantId: 'tenant-a|custom',
      installationId: 'inst-1',
    };
    const combo2: AgentMailWebhookPayload = {
      ...basePayload,
      tenantId: 'tenant-a',
      installationId: 'custom|inst-1',
    };
    const digest1 = computeAgentMailContentDigest(combo1);
    const digest2 = computeAgentMailContentDigest(combo2);
    expect(digest1).not.toBe(digest2);

    // K. Trusted tenant and installation configuration
    const trustedAdapter = new AgentMailChannelAdapter({
      store,
      service,
      webhookSecret: WEBHOOK_SECRET,
      trustedTenantId: TENANT_A,
      trustedInstallationId: 'inst-trusted-only',
    });

    const untrustedTenantPayload: AgentMailWebhookPayload = {
      ...basePayload,
      tenantId: TENANT_B,
      installationId: 'inst-trusted-only',
      messageId: `msg-untrusted-${randomUUID()}`,
    };
    const untrustedSig = computeAgentMailSignature(untrustedTenantPayload, WEBHOOK_SECRET);
    await expect(
      trustedAdapter.handleAgentMailWebhook({ ...untrustedTenantPayload, signature: untrustedSig })
    ).rejects.toThrow('Tenant tenant-competitor-corp is unauthorized');

    const untrustedInstPayload: AgentMailWebhookPayload = {
      ...basePayload,
      tenantId: TENANT_A,
      installationId: 'inst-unauthorized',
      messageId: `msg-untrusted-inst-${randomUUID()}`,
    };
    const untrustedInstSig = computeAgentMailSignature(untrustedInstPayload, WEBHOOK_SECRET);
    await expect(
      trustedAdapter.handleAgentMailWebhook({ ...untrustedInstPayload, signature: untrustedInstSig })
    ).rejects.toThrow('Installation inst-unauthorized is unauthorized');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Timestamp Replay Defense & Mandatory Timestamp Enforcement
  // ─────────────────────────────────────────────────────────────────────────────
  it('2. Timestamp replay defense: rejects missing, stale, or future-skewed webhooks', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const fakeNow = 1_700_000_000_000;
    const adapter = new AgentMailChannelAdapter({
      store,
      service,
      webhookSecret: WEBHOOK_SECRET,
      clockSkewToleranceMs: 300_000, // 5 minutes
      now: () => fakeNow,
    });

    const from = 'billing@vendor.com';

    // A. Missing timestamp when webhookSecret is configured -> rejects with MISSING_WEBHOOK_TIMESTAMP
    const missingTimestampPayload: AgentMailWebhookPayload = {
      tenantId: TENANT_A,
      installationId: 'inst-agentmail-01',
      messageId: `msg-nots-${randomUUID()}`,
      from,
      to: 'ap@blinka.com',
      subject: 'Omitted timestamp attack',
      signature: 'dummy-signature',
    };
    await expect(adapter.handleAgentMailWebhook(missingTimestampPayload)).rejects.toThrow(
      'AgentMail webhook timestamp is mandatory when webhookSecret is configured'
    );

    // B. Stale webhook (6 minutes old) -> rejects with STALE_WEBHOOK_TIMESTAMP
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
    const staleSig = computeAgentMailSignature(stalePayload, WEBHOOK_SECRET);
    await expect(
      adapter.handleAgentMailWebhook({ ...stalePayload, signature: staleSig })
    ).rejects.toThrow('exceeds clock skew tolerance of 300000ms');

    // C. Future-dated webhook (> 5 minutes ahead) -> rejects
    const futureTime = fakeNow + 360_000;
    const futurePayload: AgentMailWebhookPayload = {
      ...stalePayload,
      messageId: `msg-future-${randomUUID()}`,
      timestamp: futureTime,
    };
    const futureSig = computeAgentMailSignature(futurePayload, WEBHOOK_SECRET);
    await expect(
      adapter.handleAgentMailWebhook({ ...futurePayload, signature: futureSig })
    ).rejects.toThrow('exceeds clock skew tolerance of 300000ms');

    // D. Fresh webhook (within tolerance) -> succeeds
    const freshPayload: AgentMailWebhookPayload = {
      ...stalePayload,
      messageId: `msg-fresh-${randomUUID()}`,
      timestamp: fakeNow - 60_000, // 1 minute ago
    };
    const freshSig = computeAgentMailSignature(freshPayload, WEBHOOK_SECRET);
    const res = await adapter.handleAgentMailWebhook({ ...freshPayload, signature: freshSig });
    expect(res.assignmentId).toBeDefined();

    // E. Malformed / non-numeric timestamp rejects with INVALID_WEBHOOK_TIMESTAMP
    const malformedMsgId = `msg-malformed-ts-${randomUUID()}`;
    const malformedPayload = {
      ...stalePayload,
      messageId: malformedMsgId,
      timestamp: 'not-a-timestamp' as any,
    };
    const malformedSig = computeAgentMailSignature(malformedPayload as any, WEBHOOK_SECRET);
    await expect(
      adapter.handleAgentMailWebhook({ ...malformedPayload, signature: malformedSig } as any)
    ).rejects.toThrow('is not a valid date or timestamp');

    // Assert zero side-effects: no assignment was created for the malformed timestamp attempt
    const malformedAssignment = await store.getAssignment(TENANT_A, malformedMsgId);
    expect(malformedAssignment).toBeNull();
  });


  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Untrusted Sender Rule (DEMO-002, ADR-006 §12, Abuse case 4)
  // ─────────────────────────────────────────────────────────────────────────────
  it('3. Sender email spoofing does not grant authority (ADR-006 §12, DEMO-002)', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const adapter = new AgentMailChannelAdapter({ store, service, allowUnsignedSyntheticWebhook: true });

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
    const adapter = new AgentMailChannelAdapter({ store, service, allowUnsignedSyntheticWebhook: true });

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
    const adapter = new AgentMailChannelAdapter({ store, service, allowUnsignedSyntheticWebhook: true });

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
    const adapter = new AgentMailChannelAdapter({ store, service, allowUnsignedSyntheticWebhook: true });

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
    const adapter = new AgentMailChannelAdapter({ store, service, allowUnsignedSyntheticWebhook: true });

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
  // 8. Strict Cross-Tenant Isolation Across Inbounds, Inboxes, and Eve Tools
  // ─────────────────────────────────────────────────────────────────────────────
  it('8. Cross-tenant isolation across AgentMail inbounds, inbox, and Eve specialist tools', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const adapter = new AgentMailChannelAdapter({ store, service, allowUnsignedSyntheticWebhook: true });
    const inbox = new InMemoryChannelInbox();

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

    // A. Tenant B cannot load Tenant A's assignment
    const tenantBAssignment = await store.getAssignment(TENANT_B, resA.assignmentId);
    expect(tenantBAssignment).toBeNull();

    // B. Tenant B cannot load Tenant A's case
    const tenantBCase = await store.getCase(TENANT_B, resA.caseId);
    expect(tenantBCase).toBeNull();

    // C. Verify InMemoryChannelInbox enforces tenant isolation
    inbox.addMessage({
      id: messageId,
      tenantId: TENANT_A,
      connectionId: 'inst-agentmail-01',
      provider: 'AGENTMAIL',
      from: 'vendor@billing.com',
      to: 'ap@blinka.com',
      subject: 'Tenant A Confidential Mail',
      attachments: [
        {
          filename: 'confidential.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('%PDF-1.4\nConfidential A\n%%EOF', 'utf8'),
        },
      ],
      receivedAt: new Date().toISOString(),
      status: 'PENDING',
    });

    // Tenant A sees its message
    const msgsA = await inbox.listMessages(TENANT_A);
    expect(msgsA.length).toBe(1);
    expect(await inbox.getMessage(TENANT_A, messageId)).toBeDefined();

    // Tenant B cannot see Tenant A's message
    const msgsB = await inbox.listMessages(TENANT_B);
    expect(msgsB.length).toBe(0);
    expect(await inbox.getMessage(TENANT_B, messageId)).toBeUndefined();

    // D. Eve specialist tools strictly enforce tenant boundary
    const eveToolsB = createEveTools({ store, service, inbox });
    const ctxTenantB: TrustedExecutionContext = {
      principal: {
        tenantId: TENANT_B,
        principalId: 'eve-runner-b',
        roles: ['EveSpecialist'],
        bindingRevision: 'rev-1',
      },
      assignmentId: `asg-b-${randomUUID()}`,
      workerPrincipalId: 'worker-b',
      workerVersionId: 'v1.0.0',
      runId: `run-b-${randomUUID()}`,
      ownershipEpoch: 1,
    };

    const inspectTool = eveToolsB.find((t) => t.name === 'eve_inspect_inbound_message')!;
    await expect(inspectTool.execute({ messageId }, ctxTenantB)).rejects.toThrow(
      `Channel message ${messageId} not found in inbox`
    );

    const extractTool = eveToolsB.find((t) => t.name === 'eve_extract_and_validate_attachment')!;
    await expect(
      extractTool.execute({ messageId, filename: 'confidential.pdf' }, ctxTenantB)
    ).rejects.toThrow(`Channel message ${messageId} not found in inbox`);

    const correlateTool = eveToolsB.find((t) => t.name === 'eve_correlate_payable_case')!;
    await expect(correlateTool.execute({ messageId }, ctxTenantB)).rejects.toThrow(
      `Channel message ${messageId} not found in inbox`
    );
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

    // Seed message in inbox with tenantId
    inbox.addMessage({
      id: msgId,
      tenantId: TENANT_A,
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
    const aiSdkTools = toAiSdkTools(eveTools, executionCtx, 'EVE');
    expect(aiSdkTools['eve_fetch_channel_inbox']).toBeDefined();
    expect(aiSdkTools['eve_inspect_inbound_message']).toBeDefined();
    expect(aiSdkTools['eve_extract_and_validate_attachment']).toBeDefined();
    expect(aiSdkTools['eve_ingest_document_to_l1']).toBeDefined();
    expect(aiSdkTools['eve_correlate_payable_case']).toBeDefined();

    // Verify Vercel AI SDK v7 compatibility (inputSchema) and v5/v6 compatibility (parameters)
    expect(aiSdkTools['eve_fetch_channel_inbox']!.inputSchema).toBeDefined();
    expect(aiSdkTools['eve_fetch_channel_inbox']!.parameters).toBeDefined();

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

    // Audit records are redacted: they carry structure and timing only.
    const step2Record = result.history[1]!;
    expect(step2Record.toolName).toBe('eve_inspect_inbound_message');
    expect(step2Record.inputSummary).toBe('(redacted)');
    expect(step2Record.outputSummary).toBe('(redacted)');

    const step3Record = result.history[2]!;
    expect(step3Record.toolName).toBe('eve_extract_and_validate_attachment');
    expect(step3Record.outputSummary).toBe('(redacted)');

    // Semantic outcomes are verified by executing the tools directly, not from the audit trail.
    const inspectView = (await aiSdkTools['eve_inspect_inbound_message']!.execute(
      { messageId: msgId },
      { toolCallId: 'verify-inspect', messages: [] }
    )) as { senderSecurityStatus: string };
    expect(inspectView.senderSecurityStatus).toBe('UNVERIFIED_EXTERNAL_SENDER');

    const extractView = (await aiSdkTools['eve_extract_and_validate_attachment']!.execute(
      { messageId: msgId, filename: 'acme-invoice.pdf' },
      { toolCallId: 'verify-extract', messages: [] }
    )) as { isValidDocument: boolean };
    expect(extractView.isValidDocument).toBe(true);

    // Verify message marked processed in inbox
    const updatedMsg = await inbox.getMessage(TENANT_A, msgId);
    expect(updatedMsg?.status).toBe('PROCESSED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. AI SDK Bounds Enforcement & In-Flight Timeout Cancellation
  // ─────────────────────────────────────────────────────────────────────────────
  it('10. AI SDK bounds enforcement: maxSteps and in-flight timeout bounds fail closed', async () => {
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

    const aiSdkTools = toAiSdkTools(eveTools, executionCtx, 'EVE');

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

    // C. In-flight hung tool timeout abortion via AbortController
    let hungToolAborted = false;
    const hangingTool: SpecialistToolDefinition<Record<string, unknown>, unknown> = {
      name: 'eve_hanging_tool',
      description: 'Hanging tool simulation',
      allowedRoles: ['EVE'],
      schema: z.object({}).passthrough(),
      execute: async (_params, ctx) => {
        return new Promise((_resolve, reject) => {
          if (ctx.signal) {
            ctx.signal.addEventListener('abort', () => {
              hungToolAborted = true;
              reject(new Error('Tool aborted by signal'));
            });
          }
          // Never resolves without abort
        });
      },
    };

    const hangingAiSdkTools = toAiSdkTools([hangingTool], executionCtx, 'EVE');
    const hungRunner = new AiSdkSpecialistRunner({ limits: { maxSteps: 5, timeoutMs: 200 } });
    const hungStart = Date.now();
    await expect(
      hungRunner.executeBoundedLoop(
        'EVE',
        hangingAiSdkTools,
        [{ toolName: 'eve_hanging_tool', params: {} }],
        executionCtx
      )
    ).rejects.toThrow('exceeded wall-clock timeout deadline of 200ms during tool eve_hanging_tool');
    const hungElapsed = Date.now() - hungStart;
    expect(hungElapsed).toBeLessThan(1500); // Confirms fast abort rather than hanging indefinitely
    expect(hungToolAborted).toBe(true);

    // D. Adversarial: In-flight timeout cancellation prevents post-timeout mutations and zero side-effects
    // Directly reproduces finding: delay message retrieval, trigger short timeout,
    // and verify zero assignments created and inbox message status remains PENDING.
    const delayedInbox = new InMemoryChannelInbox();
    const delayedMsgId = `msg-delayed-${randomUUID()}`;
    delayedInbox.addMessage({
      id: delayedMsgId,
      tenantId: TENANT_A,
      connectionId: 'inst-agentmail-01',
      provider: 'AGENTMAIL',
      from: 'billing@vendor.com',
      to: 'ap@blinka.com',
      subject: 'Delayed Invoice',
      attachments: [],
      receivedAt: new Date().toISOString(),
      status: 'PENDING',
    });

    // Wrap getMessage with 60ms delay
    const origGetMessage = delayedInbox.getMessage.bind(delayedInbox);
    delayedInbox.getMessage = async (tId, mId, opts) => {
      await new Promise((r) => setTimeout(r, 60));
      return origGetMessage(tId, mId, opts);
    };

    const delayedStore = new InMemoryHarnessStore();
    const delayedService = new AssignmentService({ store: delayedStore });
    const delayedEveTools = createEveTools({
      store: delayedStore,
      service: delayedService,
      inbox: delayedInbox,
    });
    const delayedAiSdkTools = toAiSdkTools(delayedEveTools, executionCtx, 'EVE');

    const fastRunner = new AiSdkSpecialistRunner({ limits: { maxSteps: 5, timeoutMs: 15 } });

    await expect(
      fastRunner.executeBoundedLoop(
        'EVE',
        delayedAiSdkTools,
        [{ toolName: 'eve_correlate_payable_case', params: { messageId: delayedMsgId } }],
        executionCtx
      )
    ).rejects.toThrow('exceeded wall-clock timeout deadline of 15ms during tool eve_correlate_payable_case');

    // Wait 100ms for the delayed promise to settle
    await new Promise((r) => setTimeout(r, 100));

    // Assert ZERO post-timeout mutations and zero side-effects:
    // 1. Zero assignments were created in the store
    const assignmentsInStore = await delayedStore.listAssignments(TENANT_A);
    expect(assignmentsInStore).toHaveLength(0);

    // 2. The message was NOT marked PROCESSED; remains PENDING
    const delayedMsgState = await delayedInbox.getMessage(TENANT_A, delayedMsgId);
    expect(delayedMsgState?.status).toBe('PENDING');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. End-to-End Real L1 Integration Flow
  // ─────────────────────────────────────────────────────────────────────────────
  it('11. End-to-end real L1 invoice processing through AgentMail adapter', { timeout: 60_000 }, async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const adapter = new AgentMailChannelAdapter({
      store,
      service,
      evidencePort,
      allowUnsignedSyntheticWebhook: true,
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
    const adapter = new AgentMailChannelAdapter({ store, service, allowUnsignedSyntheticWebhook: true });

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
    const adapter = new AgentMailChannelAdapter({ store: sqlStore, service, allowUnsignedSyntheticWebhook: true });

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

    // 1. Concurrent competing deliveries (race condition test)
    const [resA, resB] = await Promise.all([
      adapter.handleAgentMailWebhook(payload),
      adapter.handleAgentMailWebhook(payload),
    ]);

    expect(resA.assignmentId).toBe(resB.assignmentId);
    expect(resA.caseId).toBe(resB.caseId);
    // Exactly one won the creation race, the other was identified as idempotent duplicate
    const duplicates = [resA.isDuplicate, resB.isDuplicate];
    expect(duplicates).toContain(false);
    expect(duplicates).toContain(true);

    // 2. Stored assignment matches
    const loaded = await sqlStore.getAssignment(tenantId, resA.assignmentId);
    expect(loaded).toBeDefined();
    expect(loaded!.state).toBe('QUEUED');

    // 3. Multi-tenant live Neon SQL isolation: other tenant cannot read this case or assignment
    const competitorTenant = `tenant-comp-${randomUUID()}`;
    const competitorCase = await sqlStore.getCase(competitorTenant, resA.caseId);
    expect(competitorCase).toBeNull();
    const competitorAssignment = await sqlStore.getAssignment(competitorTenant, resA.assignmentId);
    expect(competitorAssignment).toBeNull();

    // 4. Conflicting payload delivery under same messageId fails
    const tamperedPayload: AgentMailWebhookPayload = {
      ...payload,
      text: 'Conflicting payload content on live Neon',
    };
    await expect(adapter.handleAgentMailWebhook(tamperedPayload)).rejects.toThrow();
  });
});

