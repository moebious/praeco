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
  /** Explicit synthetic-only bypass for offline fixtures. Never expose on a network-facing endpoint. */
  readonly allowUnsignedSyntheticWebhook?: boolean;
  readonly clockSkewToleranceMs?: number; // default 300_000ms (5 mins)
  readonly now?: () => number;
  readonly trustedTenantId?: TenantId;
  readonly trustedInstallationId?: string;
  readonly resolveTenant?: (
    installationId: string,
    from: string,
    to: string
  ) => Promise<TenantId> | TenantId;
}

export interface AgentMailIngestResult {
  readonly assignmentId: string;
  readonly caseId: string;
  readonly isDuplicate: boolean;
  readonly providerEventId: string;
  readonly principal: TrustedPrincipal;
  readonly attachmentHashes: readonly string[];
  readonly evidenceRef?: EvidenceRunReference;
  /** Every processed attachment, in payload order; the first entry mirrors evidenceRef. */
  readonly evidenceRefs: readonly EvidenceRunReference[];
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

  // Only PDF, PNG, and JPEG documents are accepted; anything else fails closed.
  throw new HarnessError(
    'UNSUPPORTED_ATTACHMENT_TYPE',
    `Attachment ${filename} has unsupported type ${mimeType}; only PDF, PNG, and JPEG documents are accepted`
  );
}

/**
 * Computes an unambiguous deterministic canonical digest of an AgentMail webhook's entire content.
 * Binds every behavior-affecting field (tenantId, installationId, messageId, threadId, from, to, subject,
 * text hash, html hash, and deterministic sorted attachment hashes) using an unambiguous canonical encoding.
 */
export function computeAgentMailContentDigest(payload: AgentMailWebhookPayload): string {
  const attachments = (payload.attachments ?? []).map((att) => ({
    filename: att.filename,
    mimeType: att.mimeType,
    sizeBytes: att.content.length,
    sha256: createHash('sha256').update(att.content).digest('hex'),
  })).sort((a, b) => a.filename.localeCompare(b.filename) || a.sha256.localeCompare(b.sha256));

  const textDigest = payload.text !== undefined
    ? createHash('sha256').update(payload.text).digest('hex')
    : null;

  const htmlDigest = payload.html !== undefined
    ? createHash('sha256').update(payload.html).digest('hex')
    : null;

  const canonical = {
    v: 1,
    tenantId: payload.tenantId,
    installationId: payload.installationId,
    messageId: payload.messageId,
    threadId: payload.threadId ?? null,
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    textDigest,
    htmlDigest,
    attachments,
  };

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Computes the expected HMAC-SHA256 signature for an AgentMail webhook payload.
 * When rawBody is provided, signs timestamp + '.' + rawBody.
 * Otherwise, signs timestamp + '.' + canonical content digest.
 */
export function computeAgentMailSignature(
  payload: AgentMailWebhookPayload,
  secret: string,
  rawBody?: string
): string {
  const timestamp = String(payload.timestamp ?? '');
  const signedContent =
    rawBody !== undefined
      ? `${timestamp}.${rawBody}`
      : `${timestamp}.${computeAgentMailContentDigest(payload)}`;
  return createHmac('sha256', secret).update(signedContent).digest('hex');
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
  private readonly trustedTenantId?: TenantId;
  private readonly trustedInstallationId?: string;
  private readonly resolveTenant?: (
    installationId: string,
    from: string,
    to: string
  ) => Promise<TenantId> | TenantId;

  constructor(options: AgentMailAdapterOptions) {
    this.store = options.store;
    this.service = options.service;
    this.evidencePort = options.evidencePort;
    this.webhookSecret = options.webhookSecret;
    if (options.webhookSecret && options.allowUnsignedSyntheticWebhook) {
      throw new HarnessError(
        'INVALID_WEBHOOK_CONFIGURATION',
        'Signed and unsigned intake modes cannot be combined'
      );
    }
    if (!options.webhookSecret && !options.allowUnsignedSyntheticWebhook) {
      throw new HarnessError(
        'WEBHOOK_SECRET_REQUIRED',
        'Configure a webhook secret or explicit synthetic-only intake'
      );
    }
    this.clockSkewToleranceMs = options.clockSkewToleranceMs ?? 300_000; // 5 minutes
    this.now = options.now ?? (() => Date.now());
    this.trustedTenantId = options.trustedTenantId;
    this.trustedInstallationId = options.trustedInstallationId;
    this.resolveTenant = options.resolveTenant;
  }

  /**
   * Verifies HMAC-SHA256 webhook signature and timestamp replay tolerance.
   */
  verifyWebhook(
    payload: AgentMailWebhookPayload,
    signatureHeader?: string,
    rawBody?: string
  ): void {
    // 1. Mandatory timestamp when webhookSecret is configured (replay defense)
    if (this.webhookSecret && payload.timestamp === undefined) {
      throw new HarnessError(
        'MISSING_WEBHOOK_TIMESTAMP',
        'AgentMail webhook timestamp is mandatory when webhookSecret is configured'
      );
    }

    if (payload.timestamp !== undefined) {
      const ts =
        typeof payload.timestamp === 'number'
          ? payload.timestamp
          : new Date(payload.timestamp).getTime();
      if (!Number.isFinite(ts) || Number.isNaN(ts)) {
        throw new HarnessError(
          'INVALID_WEBHOOK_TIMESTAMP',
          `AgentMail webhook timestamp ${payload.timestamp} is not a valid date or timestamp`
        );
      }
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

      const expectedHmac = computeAgentMailSignature(payload, this.webhookSecret, rawBody);
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
    signatureHeader?: string,
    rawBody?: string
  ): Promise<AgentMailIngestResult> {
    // 1. Verify webhook signature & timestamp replay
    this.verifyWebhook(payload, signatureHeader, rawBody);

    // 2. When rawBody is provided, verify raw bytes, then parse and normalize those verified bytes internally
    let verifiedPayload: AgentMailWebhookPayload = payload;
    if (rawBody !== undefined) {
      const rawString = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
      let parsedRaw: any;
      try {
        parsedRaw = JSON.parse(rawString);
      } catch (err) {
        throw new HarnessError(
          'INVALID_RAW_BODY_JSON',
          `Failed to parse verified rawBody as JSON: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Detect any spoofing or mismatch between supplied payload and verified raw body
      if (payload) {
        if (payload.tenantId && parsedRaw.tenantId && payload.tenantId !== parsedRaw.tenantId) {
          throw new HarnessError(
            'PAYLOAD_RAW_BODY_MISMATCH',
            `Supplied payload tenantId (${payload.tenantId}) does not match authenticated rawBody tenantId (${parsedRaw.tenantId})`
          );
        }
        if (payload.installationId && parsedRaw.installationId && payload.installationId !== parsedRaw.installationId) {
          throw new HarnessError(
            'PAYLOAD_RAW_BODY_MISMATCH',
            `Supplied payload installationId (${payload.installationId}) does not match authenticated rawBody installationId (${parsedRaw.installationId})`
          );
        }
        if (payload.messageId && parsedRaw.messageId && payload.messageId !== parsedRaw.messageId) {
          throw new HarnessError(
            'PAYLOAD_RAW_BODY_MISMATCH',
            `Supplied payload messageId (${payload.messageId}) does not match authenticated rawBody messageId (${parsedRaw.messageId})`
          );
        }
        if (payload.from && parsedRaw.from && payload.from !== parsedRaw.from) {
          throw new HarnessError(
            'PAYLOAD_RAW_BODY_MISMATCH',
            `Supplied payload from (${payload.from}) does not match authenticated rawBody from (${parsedRaw.from})`
          );
        }
        if (payload.to && parsedRaw.to && payload.to !== parsedRaw.to) {
          throw new HarnessError(
            'PAYLOAD_RAW_BODY_MISMATCH',
            `Supplied payload to (${payload.to}) does not match authenticated rawBody to (${parsedRaw.to})`
          );
        }
        if (payload.threadId && parsedRaw.threadId && payload.threadId !== parsedRaw.threadId) {
          throw new HarnessError(
            'PAYLOAD_RAW_BODY_MISMATCH',
            `Supplied payload threadId (${payload.threadId}) does not match authenticated rawBody threadId (${parsedRaw.threadId})`
          );
        }
        if (payload.subject && parsedRaw.subject && payload.subject !== parsedRaw.subject) {
          throw new HarnessError(
            'PAYLOAD_RAW_BODY_MISMATCH',
            `Supplied payload subject does not match authenticated rawBody subject`
          );
        }
      }

      const parsedAttachments: AgentMailAttachment[] = Array.isArray(parsedRaw.attachments)
        ? parsedRaw.attachments.map((att: any) => ({
            filename: String(att.filename ?? ''),
            mimeType: String(att.mimeType ?? ''),
            content: att.content instanceof Uint8Array
              ? att.content
              : typeof att.content === 'string'
                ? Buffer.from(att.content, att.contentEncoding === 'base64' ? 'base64' : 'utf8')
                : new Uint8Array(),
          }))
        : (payload.attachments ?? []);

      verifiedPayload = {
        tenantId: parsedRaw.tenantId ?? payload.tenantId,
        installationId: parsedRaw.installationId ?? payload.installationId,
        messageId: parsedRaw.messageId ?? payload.messageId,
        threadId: parsedRaw.threadId ?? payload.threadId,
        from: parsedRaw.from ?? payload.from,
        to: parsedRaw.to ?? payload.to,
        subject: parsedRaw.subject ?? payload.subject,
        text: parsedRaw.text ?? payload.text,
        html: parsedRaw.html ?? payload.html,
        attachments: parsedAttachments,
        timestamp: parsedRaw.timestamp ?? payload.timestamp,
        signature: parsedRaw.signature ?? payload.signature,
      };
    }

    // 3. Resolve tenant/installation through trusted configuration
    let tenantId = verifiedPayload.tenantId;
    if (this.trustedTenantId) {
      if (verifiedPayload.tenantId && verifiedPayload.tenantId !== this.trustedTenantId) {
        throw new HarnessError(
          'UNAUTHORIZED_TENANT',
          `Tenant ${verifiedPayload.tenantId} is unauthorized (must be ${this.trustedTenantId})`
        );
      }
      tenantId = this.trustedTenantId;
    } else if (this.resolveTenant) {
      tenantId = await this.resolveTenant(
        verifiedPayload.installationId,
        verifiedPayload.from,
        verifiedPayload.to
      );
    }

    if (this.trustedInstallationId) {
      if (
        verifiedPayload.installationId &&
        verifiedPayload.installationId !== this.trustedInstallationId
      ) {
        throw new HarnessError(
          'UNAUTHORIZED_INSTALLATION',
          `Installation ${verifiedPayload.installationId} is unauthorized (must be ${this.trustedInstallationId})`
        );
      }
    }

    // 4. Validate all attachments (magic bytes, size bounds, and exact-byte SHA-256)
    const attachments = verifiedPayload.attachments ?? [];
    const attachmentHashes: string[] = [];

    for (const att of attachments) {
      validateAttachmentSignature(att.mimeType, att.filename, att.content);
      const hash = createHash('sha256').update(att.content).digest('hex');
      attachmentHashes.push(hash);
    }

    // 5. Resolve principal binding (revocation enforcement only)
    let binding = await this.store.getPrincipalBinding(
      tenantId,
      'AGENTMAIL',
      verifiedPayload.installationId,
      verifiedPayload.from
    );

    // Also check standard EMAIL provider if not found under AGENTMAIL
    if (!binding) {
      binding = await this.store.getPrincipalBinding(
        tenantId,
        'EMAIL',
        verifiedPayload.installationId,
        verifiedPayload.from
      );
    }

    if (binding?.revoked) {
      throw new HarnessError(
        'REVOKED_CHANNEL_USER',
        `AgentMail user binding for ${verifiedPayload.from} on ${verifiedPayload.installationId} is revoked`
      );
    }

    // A signed webhook authenticates transport delivery, not the identity in an
    // email From header (DEMO-002: remitters are never verified merely by their
    // email address). The binding is consulted only to enforce revocation; it
    // never grants vendor or FinanceAdmin authority.
    const principal: TrustedPrincipal = {
      tenantId,
      principalId: `agentmail-sender-${verifiedPayload.from.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      roles: ['InboundSender'],
      bindingRevision: binding ? `revocation-checked:${binding.bindingRevision}` : 'unverified-address',
    };

    const providerEventId = `agentmail-evt-${verifiedPayload.messageId}`;
    const providerThreadId = verifiedPayload.threadId ?? `thread-${verifiedPayload.messageId}`;

    const rawCommand = {
      provider: 'AGENTMAIL' as const,
      installationId: verifiedPayload.installationId,
      providerEventId,
      providerUserId: verifiedPayload.from,
      providerThreadId,
      messageId: verifiedPayload.messageId,
      text: verifiedPayload.text ?? verifiedPayload.subject,
      attachmentRefs: attachmentHashes,
    };

    const payloadDigest = computeInboundPayloadDigest(rawCommand);

    const command: InboundMessageCommand = {
      ...rawCommand,
      payloadDigest,
    };

    // 6. Process every attachment through L1 BEFORE the intake is accepted.
    // A failed ingestion leaves no assignment, receipt, or queued outbox event,
    // and deterministic per-attachment origin IDs make redelivery idempotent.
    const evidenceRefs: EvidenceRunReference[] = [];
    if (this.evidencePort && attachments.length > 0) {
      const executionCtx: TrustedExecutionContext = {
        principal,
        assignmentId: `intake-${providerEventId}`,
        workerPrincipalId: 'agentmail-worker',
        workerVersionId: 'v1.0.0',
        runId: `run-${providerEventId}`,
        ownershipEpoch: 1,
      };

      for (const [index, att] of attachments.entries()) {
        const hash = attachmentHashes[index]!;
        const evidence = await this.evidencePort.ingestSource(
          {
            bytes: att.content,
            channel: att.mimeType === 'application/pdf' ? 'PDF' : 'EMAIL',
            mimeType: att.mimeType,
            displayName: att.filename,
            originMessageId: `${providerEventId}:${hash.slice(0, 16)}`,
          },
          executionCtx
        );
        if (evidence.sourceHashSha256 !== hash) {
          throw new HarnessError(
            'EVIDENCE_SOURCE_HASH_MISMATCH',
            'L1 reference does not match the exact attachment bytes'
          );
        }
        evidenceRefs.push(evidence);
      }
    }

    // 7. Create or load; documentary links persist in the same store transaction
    // as the assignment, receipt, command receipt, and queued outbox event.
    const { assignment, isDuplicate } = await this.service.createOrLoad(
      command,
      principal,
      {
        sourceLinks: evidenceRefs.map((evidence) => ({ kind: 'DOCUMENT' as const, evidence })),
      }
    );

    return {
      assignmentId: assignment.assignmentId,
      caseId: assignment.caseId,
      isDuplicate,
      providerEventId,
      principal,
      attachmentHashes,
      evidenceRef: evidenceRefs[0],
      evidenceRefs,
    };
  }
}

