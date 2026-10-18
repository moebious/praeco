import { createHash, randomUUID } from 'node:crypto';
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

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  content: Uint8Array;
}

export interface EmailInboundWebhookPayload {
  tenantId: TenantId;
  installationId: string;
  providerEventId?: string;
  messageId?: string;
  threadId?: string;
  from: string; // sender address e.g. "billing@vendor.com" or "alice@blinka.com"
  to: string;   // recipient inbox e.g. "ap@blinka.com"
  subject?: string;
  bodyText?: string;
  attachments?: readonly EmailAttachment[];
}

export interface EmailIngestResult {
  assignmentId: string;
  caseId: string;
  isDuplicate: boolean;
  providerEventId: string;
  principal: TrustedPrincipal;
  attachmentHashes: readonly string[];
  evidenceRef?: EvidenceRunReference;
}

export class EmailChannelAdapter {
  constructor(
    private readonly store: HarnessStore,
    private readonly service: AssignmentService,
    private readonly evidencePort?: EvidencePort
  ) {}

  /**
   * Processes a direct inbound email webhook:
   * 1. Exact-byte SHA-256 hashing over all raw attachments (ADR-007 delta #4).
   * 2. Resolves principal binding for sender, strictly enforcing that sender email
   *    does not grant vendor or FinanceAdmin authority without a pre-registered binding (ADR-006 §12).
   * 3. Enforces revoked binding defense (ADR-006 Abuse case 5).
   * 4. Normalizes command and delegates to AssignmentService.createOrLoad for idempotency & digest matching.
   */
  async handleInboundEmail(
    payload: EmailInboundWebhookPayload
  ): Promise<EmailIngestResult> {
    const tenantId = payload.tenantId;

    // 1. Exact-byte attachment SHA-256 hashing
    const attachments = payload.attachments ?? [];
    const attachmentHashes = attachments.map((att) => {
      return createHash('sha256').update(att.content).digest('hex');
    });

    // 2. Resolve principal binding
    // Sender email address NEVER bestows authority by itself (ADR-006 §12, Abuse case 4)
    const binding = await this.store.getPrincipalBinding(
      tenantId,
      'EMAIL',
      payload.installationId,
      payload.from
    );

    let principal: TrustedPrincipal;
    if (binding) {
      if (binding.revoked) {
        throw new HarnessError(
          'REVOKED_CHANNEL_USER',
          `Email user binding for ${payload.from} on ${payload.installationId} is revoked`
        );
      }
      principal = {
        tenantId: binding.tenantId,
        principalId: binding.principalId,
        roles: binding.roles,
        bindingRevision: binding.bindingRevision,
      };
    } else {
      // Unauthenticated / external sender - assigned lowest privilege role
      // Sender cannot execute financial commands or approve invoices
      principal = {
        tenantId,
        principalId: `email-sender-${payload.from.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        roles: ['InboundSender'],
        bindingRevision: 'rev-0',
      };
    }

    const providerEventId =
      payload.providerEventId ?? (payload.messageId ? `evt-${payload.messageId}` : `evt-${randomUUID()}`);
    const messageId = payload.messageId ?? `msg-${providerEventId}`;
    const providerThreadId =
      payload.threadId ?? payload.messageId ?? `thread-${providerEventId}`;

    const rawCommand = {
      provider: 'EMAIL' as const,
      installationId: payload.installationId,
      providerEventId,
      providerUserId: payload.from,
      providerThreadId,
      messageId,
      text: payload.bodyText ?? payload.subject,
      attachmentRefs: attachmentHashes,
    };

    const payloadDigest = computeInboundPayloadDigest(rawCommand);

    const command: InboundMessageCommand = {
      ...rawCommand,
      payloadDigest,
    };

    const { assignment, isDuplicate } = await this.service.createOrLoad(
      command,
      principal
    );

    let evidenceRef: EvidenceRunReference | undefined;
    if (!isDuplicate && this.evidencePort && attachments.length > 0) {
      const firstAtt = attachments[0]!;
      const executionCtx: TrustedExecutionContext = {
        principal,
        assignmentId: assignment.assignmentId,
        workerPrincipalId: 'email-channel-worker',
        workerVersionId: 'v1.0.0',
        runId: `run-email-${providerEventId}`,
        ownershipEpoch: 1,
      };

      evidenceRef = await this.evidencePort.ingestSource(
        {
          bytes: firstAtt.content,
          channel: firstAtt.mimeType === 'application/pdf' ? 'PDF' : 'EMAIL',
          mimeType: firstAtt.mimeType,
          displayName: firstAtt.filename,
          originMessageId: messageId,
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
