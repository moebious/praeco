import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  EvidencePort,
  EvidenceRunReference,
  InboundMessageCommand,
  TenantId,
  TrustedExecutionContext,
  TrustedPrincipal,
} from '../types.js';
import type { HarnessStore } from '../store.js';
import type { AssignmentService } from '../service.js';
import { HarnessError } from '../state-machine.js';
import { computeInboundPayloadDigest } from '../hashing.js';

export interface AgentMailAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Uint8Array;
}

export interface AgentMailWebhookPayload {
  readonly tenantId: TenantId;
  readonly installationId: string;
  readonly messageId: string;
  readonly threadId?: string;
  readonly from: string; // sender email e.g. "billing@vendor.com"
  readonly to: string;   // recipient inbox e.g. "ap@blinka.com"
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly attachments?: readonly AgentMailAttachment[];
  readonly timestamp?: string | number;
  readonly signature?: string;
}

export interface AgentMailAdapterOptions {
  readonly store: HarnessStore;
  readonly service: AssignmentService;
  readonly evidencePort?: EvidencePort;
  readonly webhookSecret?: string;
  readonly clockSkewToleranceMs?: number; // default 300_000ms (5 mins)
  readonly now?: () => number;
}

export interface AgentMailIngestResult {
  readonly assignmentId: string;
  readonly caseId: string;
  readonly isDuplicate: boolean;
  readonly providerEventId: string;
  readonly principal: TrustedPrincipal;
  readonly attachmentHashes: readonly string[];
  readonly evidenceRef?: EvidenceRunReference;
}

const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB limit per ADR-001/007

/**
 * Validates document magic bytes (file signature) against asserted MIME type.
 * Fails closed if the file content signature contradicts the declared file format.
 */
export function validateAttachmentSignature(mimeType: string, filename: string, bytes: Uint8Array): void {
  if (bytes.length > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new HarnessError(
      'ATTACHMENT_TOO_LARGE',
      `Attachment ${filename} exceeds maximum size limit of 20MB (got ${bytes.length} bytes)`
    );
  }

  const isPdf = mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');
  if (isPdf) {
    if (bytes.length < 5) {
      throw new HarnessError('INVALID_FILE_SIGNATURE', `File ${filename} is too small to be a valid PDF`);
    }
    const header = String.fromCharCode(...bytes.slice(0, 5));
    if (header !== '%PDF-') {
      throw new HarnessError(
        'INVALID_FILE_SIGNATURE',
        `File ${filename} declared as PDF lacks valid %PDF- magic signature (got ${header})`
      );
    }
    return;
  }

  const isPng = mimeType === 'image/png' || filename.toLowerCase().endsWith('.png');
  if (isPng) {
    if (bytes.length < 8) {
      throw new HarnessError('INVALID_FILE_SIGNATURE', `File ${filename} is too small to be a valid PNG`);
    }
    const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const matches = pngMagic.every((val, idx) => bytes[idx] === val);
    if (!matches) {
      throw new HarnessError(
        'INVALID_FILE_SIGNATURE',
        `File ${filename} declared as PNG lacks valid PNG signature`
      );
    }
    return;
  }

  const isJpeg =
    mimeType === 'image/jpeg' ||
    mimeType === 'image/jpg' ||
    filename.toLowerCase().endsWith('.jpg') ||
    filename.toLowerCase().endsWith('.jpeg');
  if (isJpeg) {
    if (bytes.length < 3) {
      throw new HarnessError('INVALID_FILE_SIGNATURE', `File ${filename} is too small to be a valid JPEG`);
    }
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new HarnessError(
        'INVALID_FILE_SIGNATURE',
        `File ${filename} declared as JPEG lacks valid JPEG signature`
      );
    }
    return;
  }
}

/**
 * AgentMail Inbound Adapter.
 *
 * Implements ADR-006 & DEMO-002:
 * 1. Webhook HMAC-SHA256 signature verification & timestamp replay defenses.
 * 2. Untrusted sender principal resolution: sender email NEVER grants authority by itself.
 * 3. Immediate defense against revoked principal bindings (ADR-006 Abuse case 5).
 * 4. Exact-byte SHA-256 attachment hashing and file signature validation (ADR-007 delta #4).
 * 5. Strict 20MB attachment size limit enforcement.
 * 6. Technical idempotency & conflicting payload detection via AssignmentService (ADR-006 §36).
 * 7. L1 Evidence registration and PayableCase source linking.
 */
export class AgentMailChannelAdapter {
  private readonly store: HarnessStore;
  private readonly service: AssignmentService;
  private readonly evidencePort?: EvidencePort;
  private readonly webhookSecret?: string;
  private readonly clockSkewToleranceMs: number;
  private readonly now: () => number;

  constructor(options: AgentMailAdapterOptions) {
    this.store = options.store;
    this.service = options.service;
    this.evidencePort = options.evidencePort;
    this.webhookSecret = options.webhookSecret;
    this.clockSkewToleranceMs = options.clockSkewToleranceMs ?? 300_000; // 5 minutes
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Verifies HMAC-SHA256 webhook signature and timestamp replay tolerance.
   */
  verifyWebhook(payload: AgentMailWebhookPayload, signatureHeader?: string): void {
    // 1. Timestamp replay defense
    if (payload.timestamp !== undefined) {
      const ts =
        typeof payload.timestamp === 'number'
          ? payload.timestamp
          : new Date(payload.timestamp).getTime();
      const current = this.now();
      const diff = Math.abs(current - ts);
      if (diff > this.clockSkewToleranceMs) {
        throw new HarnessError(
          'STALE_WEBHOOK_TIMESTAMP',
          `AgentMail webhook timestamp ${payload.timestamp} exceeds clock skew tolerance of ${this.clockSkewToleranceMs}ms (diff: ${diff}ms)`
        );
      }
    }

    // 2. Signature verification
    if (this.webhookSecret) {
      const signatureToVerify = signatureHeader ?? payload.signature;
      if (!signatureToVerify) {
        throw new HarnessError(
          'INVALID_WEBHOOK_SIGNATURE',
          'AgentMail webhook signature is missing but webhookSecret is configured'
        );
      }

      const signedPayload = `${payload.messageId}:${payload.from}:${payload.timestamp ?? ''}`;
      const expectedHmac = createHmac('sha256', this.webhookSecret)
        .update(signedPayload)
        .digest('hex');

      const expectedBuffer = Buffer.from(expectedHmac, 'utf8');
      const providedBuffer = Buffer.from(signatureToVerify, 'utf8');

      if (
        expectedBuffer.length !== providedBuffer.length ||
        !timingSafeEqual(expectedBuffer, providedBuffer)
      ) {
        throw new HarnessError(
          'INVALID_WEBHOOK_SIGNATURE',
          'AgentMail webhook signature verification failed'
        );
      }
    }
  }

  /**
   * Ingests an incoming AgentMail webhook.
   */
  async handleAgentMailWebhook(
    payload: AgentMailWebhookPayload,
    signatureHeader?: string
  ): Promise<AgentMailIngestResult> {
    // 1. Verify webhook signature & timestamp replay
    this.verifyWebhook(payload, signatureHeader);

    const tenantId = payload.tenantId;

    // 2. Validate all attachments (magic bytes, size bounds, and exact-byte SHA-256)
    const attachments = payload.attachments ?? [];
    const attachmentHashes: string[] = [];

    for (const att of attachments) {
      validateAttachmentSignature(att.mimeType, att.filename, att.content);
      const hash = createHash('sha256').update(att.content).digest('hex');
      attachmentHashes.push(hash);
    }

    // 3. Resolve principal binding
    // Sender email address NEVER confers vendor or FinanceAdmin authority by itself (ADR-006 §12, Abuse case 4)
    let binding = await this.store.getPrincipalBinding(
      tenantId,
      'AGENTMAIL',
      payload.installationId,
      payload.from
    );

    // Also check standard EMAIL provider if not found under AGENTMAIL
    if (!binding) {
      binding = await this.store.getPrincipalBinding(
        tenantId,
        'EMAIL',
        payload.installationId,
        payload.from
      );
    }

    let principal: TrustedPrincipal;
    if (binding) {
      if (binding.revoked) {
        throw new HarnessError(
          'REVOKED_CHANNEL_USER',
          `AgentMail user binding for ${payload.from} on ${payload.installationId} is revoked`
        );
      }
      principal = {
        tenantId: binding.tenantId,
        principalId: binding.principalId,
        roles: binding.roles,
        bindingRevision: binding.bindingRevision,
      };
    } else {
      // Unlinked / external sender: assigned lowest privilege InboundSender role
      // Cannot execute financial commands or approve invoices
      principal = {
        tenantId,
        principalId: `agentmail-sender-${payload.from.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        roles: ['InboundSender'],
        bindingRevision: 'rev-0',
      };
    }

    const providerEventId = `agentmail-evt-${payload.messageId}`;
    const providerThreadId = payload.threadId ?? `thread-${payload.messageId}`;

    const rawCommand = {
      provider: 'AGENTMAIL' as const,
      installationId: payload.installationId,
      providerEventId,
      providerUserId: payload.from,
      providerThreadId,
      messageId: payload.messageId,
      text: payload.text ?? payload.subject,
      attachmentRefs: attachmentHashes,
    };

    const payloadDigest = computeInboundPayloadDigest(rawCommand);

    const command: InboundMessageCommand = {
      ...rawCommand,
      payloadDigest,
    };

    // 4. Create or load via AssignmentService (transactional idempotency + digest matching)
    const { assignment, isDuplicate } = await this.service.createOrLoad(
      command,
      principal
    );

    // 5. If fresh inbound delivery and attachments exist, ingest first document into L1
    let evidenceRef: EvidenceRunReference | undefined;
    if (!isDuplicate && this.evidencePort && attachments.length > 0) {
      const firstAtt = attachments[0]!;
      const executionCtx: TrustedExecutionContext = {
        principal,
        assignmentId: assignment.assignmentId,
        workerPrincipalId: 'agentmail-worker',
        workerVersionId: 'v1.0.0',
        runId: `run-${providerEventId}`,
        ownershipEpoch: 1,
      };

      evidenceRef = await this.evidencePort.ingestSource(
        {
          bytes: firstAtt.content,
          channel: firstAtt.mimeType === 'application/pdf' ? 'PDF' : 'EMAIL',
          mimeType: firstAtt.mimeType,
          displayName: firstAtt.filename,
          originMessageId: payload.messageId,
        },
        executionCtx
      );

      await this.store.attachSourceLink(tenantId, assignment.caseId, {
        kind: 'DOCUMENT',
        evidence: evidenceRef,
      });
    }

    return {
      assignmentId: assignment.assignmentId,
      caseId: assignment.caseId,
      isDuplicate,
      providerEventId,
      principal,
      attachmentHashes,
      evidenceRef,
    };
  }
}
