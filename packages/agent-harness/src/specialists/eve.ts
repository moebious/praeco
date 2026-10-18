import { z } from 'zod';
import { createHash } from 'node:crypto';
import type {
  EvidencePort,
  InboundMessageCommand,
  SpecialistRole,
  TenantId,
  TrustedPrincipal,
} from '../types.js';
import type { HarnessStore } from '../store.js';
import type { AssignmentService } from '../service.js';
import { HarnessError } from '../state-machine.js';
import { computeInboundPayloadDigest } from '../hashing.js';
import {
  validateAttachmentSignature,
  type AgentMailAttachment,
} from '../adapters/agentmail-channel-adapter.js';
import type { SpecialistToolDefinition } from './types.js';

export interface InboundChannelMessage {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly connectionId: string;
  readonly provider: 'AGENTMAIL' | 'EMAIL' | 'WEB' | 'TELEGRAM' | string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly attachments: readonly AgentMailAttachment[];
  readonly receivedAt: string;
  status: 'PENDING' | 'PROCESSED';
}

export interface ChannelInboxPort {
  listMessages(
    tenantId: TenantId,
    filter?: {
      connectionId?: string;
      status?: 'PENDING' | 'PROCESSED' | 'ALL';
      limit?: number;
      signal?: AbortSignal;
    }
  ): Promise<readonly InboundChannelMessage[]>;
  getMessage(
    tenantId: TenantId,
    messageId: string,
    options?: { signal?: AbortSignal }
  ): Promise<InboundChannelMessage | undefined>;
  markProcessed(
    tenantId: TenantId,
    messageId: string,
    options?: { signal?: AbortSignal }
  ): Promise<void>;
}

export class InMemoryChannelInbox implements ChannelInboxPort {
  private readonly messages = new Map<string, InboundChannelMessage>();

  private makeKey(tenantId: TenantId, messageId: string): string {
    return `${tenantId}:${messageId}`;
  }

  addMessage(message: InboundChannelMessage): void {
    this.messages.set(this.makeKey(message.tenantId, message.id), { ...message });
  }

  async listMessages(
    tenantId: TenantId,
    filter?: {
      connectionId?: string;
      status?: 'PENDING' | 'PROCESSED' | 'ALL';
      limit?: number;
      signal?: AbortSignal;
    }
  ): Promise<readonly InboundChannelMessage[]> {
    if (filter?.signal?.aborted) {
      throw new HarnessError('EXECUTION_ABORTED', 'listMessages was aborted by cancellation signal');
    }
    let result = Array.from(this.messages.values()).filter((m) => m.tenantId === tenantId);
    if (filter?.connectionId) {
      result = result.filter((m) => m.connectionId === filter.connectionId);
    }
    if (filter?.status && filter.status !== 'ALL') {
      result = result.filter((m) => m.status === filter.status);
    }
    if (filter?.limit) {
      result = result.slice(0, filter.limit);
    }
    return result;
  }

  async getMessage(
    tenantId: TenantId,
    messageId: string,
    options?: { signal?: AbortSignal }
  ): Promise<InboundChannelMessage | undefined> {
    if (options?.signal?.aborted) {
      throw new HarnessError('EXECUTION_ABORTED', 'getMessage was aborted by cancellation signal');
    }
    return this.messages.get(this.makeKey(tenantId, messageId));
  }

  async markProcessed(
    tenantId: TenantId,
    messageId: string,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    if (options?.signal?.aborted) {
      throw new HarnessError('EXECUTION_ABORTED', 'markProcessed was aborted by cancellation signal');
    }
    const msg = this.messages.get(this.makeKey(tenantId, messageId));
    if (msg) {
      msg.status = 'PROCESSED';
    }
  }
}

export interface EveToolsOptions {
  readonly store: HarnessStore;
  readonly service: AssignmentService;
  readonly inbox: ChannelInboxPort;
  readonly evidencePort?: EvidencePort;
}

export interface EveMessageInspectionView {
  readonly messageId: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly senderSecurityStatus: 'VERIFIED_PRINCIPAL' | 'UNVERIFIED_EXTERNAL_SENDER';
  readonly isRevoked: boolean;
  readonly bodySnippet: string;
  readonly attachments: ReadonlyArray<{
    readonly filename: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly attachmentHashSha256: string;
  }>;
}

export interface EveAttachmentValidationView {
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly isValidDocument: boolean;
  readonly signatureMatched: boolean;
  readonly attachmentHashSha256: string;
  readonly validationError?: string;
}

export interface EveL1IngestView {
  readonly sourceId: string;
  readonly sourceHashSha256: string;
  readonly pipelineRunId: string;
  readonly sourceDisposition: 'INVOICE_OR_UNCERTAIN' | 'SUPPLEMENTAL_CONTEXT';
  readonly envelopesCount: number;
}

export interface EveCaseCorrelationView {
  readonly caseId: string;
  readonly assignmentId: string;
  readonly isDuplicate: boolean;
  readonly status: string;
}

/**
 * Creates Eve's specialist tool inventory for channel ingestion & invoice retrieval.
 *
 * Eve acts as the Channel Ingestion Specialist:
 * - Inspects channel inboxes and incoming webhook mailboxes.
 * - Enforces untrusted email sender security rules (ADR-006 §12, DEMO-002).
 * - Extracts and cryptographically verifies raw attachments (magic bytes + exact-byte SHA-256).
 * - Ingests verified documents into L1 Evidence Intelligence.
 * - Correlates with PayableCase and enqueues assignments via AssignmentService.
 */
export function createEveTools(options: EveToolsOptions): SpecialistToolDefinition<any, any>[] {
  const allowedRoles: readonly SpecialistRole[] = ['EVE'];

  function assertNotCancelled(signal?: AbortSignal, stepName?: string): void {
    if (signal?.aborted) {
      throw new HarnessError(
        'EXECUTION_ABORTED',
        `Eve operation ${stepName ?? 'step'} was aborted by cancellation signal`
      );
    }
  }

  // Tool 1: Fetch channel inbox
  const fetchInboxTool: SpecialistToolDefinition<
    { connectionId?: string; limit?: number; status?: 'PENDING' | 'PROCESSED' | 'ALL' },
    { messages: ReadonlyArray<{ messageId: string; from: string; to: string; subject: string; receivedAt: string; attachmentCount: number }> }
  > = {
    name: 'eve_fetch_channel_inbox',
    description: 'Fetches pending or processed messages from the channel inbox (AgentMail/Email).',
    allowedRoles,
    schema: z.object({
      connectionId: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional().default(10),
      status: z.enum(['PENDING', 'PROCESSED', 'ALL']).optional().default('PENDING'),
    }),
    async execute(params, context) {
      assertNotCancelled(context.signal, 'eve_fetch_channel_inbox:start');
      const messages = await options.inbox.listMessages(context.principal.tenantId, {
        ...params,
        signal: context.signal,
      });
      assertNotCancelled(context.signal, 'eve_fetch_channel_inbox:end');
      return {
        messages: messages.map((m) => ({
          messageId: m.id,
          from: m.from,
          to: m.to,
          subject: m.subject,
          receivedAt: m.receivedAt,
          attachmentCount: m.attachments.length,
        })),
      };
    },
  };

  // Tool 2: Inspect inbound message
  const inspectMessageTool: SpecialistToolDefinition<
    { messageId: string },
    EveMessageInspectionView
  > = {
    name: 'eve_inspect_inbound_message',
    description: 'Inspects an inbound channel message, resolving sender identity, security posture, and attachment inventory.',
    allowedRoles,
    schema: z.object({
      messageId: z.string().min(1, 'messageId is required'),
    }),
    async execute(params, context) {
      assertNotCancelled(context.signal, 'eve_inspect_inbound_message:start');
      const tenantId = context.principal.tenantId;
      const msg = await options.inbox.getMessage(tenantId, params.messageId, { signal: context.signal });
      assertNotCancelled(context.signal, 'eve_inspect_inbound_message:after_get_message');
      if (!msg) {
        throw new HarnessError('MESSAGE_NOT_FOUND', `Channel message ${params.messageId} not found in inbox`);
      }

      // Resolve principal binding for sender
      let binding = await options.store.getPrincipalBinding(
        tenantId,
        'AGENTMAIL',
        msg.connectionId,
        msg.from
      );
      assertNotCancelled(context.signal, 'eve_inspect_inbound_message:after_agentmail_binding');
      if (!binding) {
        binding = await options.store.getPrincipalBinding(
          tenantId,
          'EMAIL',
          msg.connectionId,
          msg.from
        );
        assertNotCancelled(context.signal, 'eve_inspect_inbound_message:after_email_binding');
      }

      const isRevoked = Boolean(binding?.revoked);
      const senderSecurityStatus = binding && !isRevoked ? 'VERIFIED_PRINCIPAL' : 'UNVERIFIED_EXTERNAL_SENDER';

      const attachments = msg.attachments.map((att) => {
        const hash = createHash('sha256').update(att.content).digest('hex');
        return {
          filename: att.filename,
          mimeType: att.mimeType,
          sizeBytes: att.content.length,
          attachmentHashSha256: hash,
        };
      });

      const bodyText = msg.text ?? msg.subject ?? '';
      const bodySnippet = bodyText.length > 200 ? `${bodyText.slice(0, 200)}...` : bodyText;

      return {
        messageId: msg.id,
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        senderSecurityStatus,
        isRevoked,
        bodySnippet,
        attachments,
      };
    },
  };

  // Tool 3: Extract and validate attachment
  const extractValidateAttachmentTool: SpecialistToolDefinition<
    { messageId: string; filename: string },
    EveAttachmentValidationView
  > = {
    name: 'eve_extract_and_validate_attachment',
    description: 'Extracts an attachment from a channel message, verifying magic bytes, size limits, and SHA-256 integrity.',
    allowedRoles,
    schema: z.object({
      messageId: z.string().min(1, 'messageId is required'),
      filename: z.string().min(1, 'filename is required'),
    }),
    async execute(params, context) {
      assertNotCancelled(context.signal, 'eve_extract_and_validate_attachment:start');
      const tenantId = context.principal.tenantId;
      const msg = await options.inbox.getMessage(tenantId, params.messageId, { signal: context.signal });
      assertNotCancelled(context.signal, 'eve_extract_and_validate_attachment:after_get_message');
      if (!msg) {
        throw new HarnessError('MESSAGE_NOT_FOUND', `Channel message ${params.messageId} not found in inbox`);
      }

      const att = msg.attachments.find((a) => a.filename === params.filename);
      if (!att) {
        throw new HarnessError(
          'ATTACHMENT_NOT_FOUND',
          `Attachment ${params.filename} not found in message ${params.messageId}`
        );
      }

      const hash = createHash('sha256').update(att.content).digest('hex');

      try {
        validateAttachmentSignature(att.mimeType, att.filename, att.content);
        return {
          filename: att.filename,
          mimeType: att.mimeType,
          sizeBytes: att.content.length,
          isValidDocument: true,
          signatureMatched: true,
          attachmentHashSha256: hash,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          filename: att.filename,
          mimeType: att.mimeType,
          sizeBytes: att.content.length,
          isValidDocument: false,
          signatureMatched: false,
          attachmentHashSha256: hash,
          validationError: message,
        };
      }
    },
  };

  // Tool 4: Ingest document to L1
  const ingestDocumentTool: SpecialistToolDefinition<
    { messageId: string; filename: string },
    EveL1IngestView
  > = {
    name: 'eve_ingest_document_to_l1',
    description: 'Ingests a validated documentary attachment into L1 Evidence Intelligence.',
    allowedRoles,
    schema: z.object({
      messageId: z.string().min(1, 'messageId is required'),
      filename: z.string().min(1, 'filename is required'),
    }),
    async execute(params, context) {
      assertNotCancelled(context.signal, 'eve_ingest_document_to_l1:start');
      if (!options.evidencePort) {
        throw new HarnessError('EVIDENCE_PORT_UNAVAILABLE', 'L1 EvidencePort is not configured on Eve specialist');
      }

      const tenantId = context.principal.tenantId;
      const msg = await options.inbox.getMessage(tenantId, params.messageId, { signal: context.signal });
      assertNotCancelled(context.signal, 'eve_ingest_document_to_l1:after_get_message');
      if (!msg) {
        throw new HarnessError('MESSAGE_NOT_FOUND', `Channel message ${params.messageId} not found in inbox`);
      }

      const att = msg.attachments.find((a) => a.filename === params.filename);
      if (!att) {
        throw new HarnessError(
          'ATTACHMENT_NOT_FOUND',
          `Attachment ${params.filename} not found in message ${params.messageId}`
        );
      }

      // Enforce file signature before L1 ingestion
      validateAttachmentSignature(att.mimeType, att.filename, att.content);

      assertNotCancelled(context.signal, 'eve_ingest_document_to_l1:before_l1_ingest');

      const channel = att.mimeType === 'application/pdf' ? 'PDF' : 'EMAIL';
      const ref = await options.evidencePort.ingestSource(
        {
          bytes: att.content,
          channel,
          mimeType: att.mimeType,
          displayName: att.filename,
          originMessageId: msg.id,
        },
        context
      );

      assertNotCancelled(context.signal, 'eve_ingest_document_to_l1:after_l1_ingest');

      return {
        sourceId: ref.sourceId,
        sourceHashSha256: ref.sourceHashSha256,
        pipelineRunId: ref.pipelineRunId,
        sourceDisposition: ref.sourceDisposition,
        envelopesCount: ref.envelopeIds.length,
      };
    },
  };

  // Tool 5: Correlate payable case
  const correlatePayableCaseTool: SpecialistToolDefinition<
    { messageId: string; filename?: string; preferredCaseId?: string },
    EveCaseCorrelationView
  > = {
    name: 'eve_correlate_payable_case',
    description: 'Correlates an inbound message to a PayableCase, creating or loading an Assignment transactionally.',
    allowedRoles,
    schema: z.object({
      messageId: z.string().min(1, 'messageId is required'),
      filename: z.string().optional(),
      preferredCaseId: z.string().optional(),
    }),
    async execute(params, context) {
      assertNotCancelled(context.signal, 'eve_correlate_payable_case:start');
      const tenantId = context.principal.tenantId;
      const msg = await options.inbox.getMessage(tenantId, params.messageId, { signal: context.signal });
      assertNotCancelled(context.signal, 'eve_correlate_payable_case:after_get_message');
      if (!msg) {
        throw new HarnessError('MESSAGE_NOT_FOUND', `Channel message ${params.messageId} not found in inbox`);
      }

      // Check principal binding
      let binding = await options.store.getPrincipalBinding(
        tenantId,
        'AGENTMAIL',
        msg.connectionId,
        msg.from
      );
      assertNotCancelled(context.signal, 'eve_correlate_payable_case:after_agentmail_binding');
      if (!binding) {
        binding = await options.store.getPrincipalBinding(
          tenantId,
          'EMAIL',
          msg.connectionId,
          msg.from
        );
        assertNotCancelled(context.signal, 'eve_correlate_payable_case:after_email_binding');
      }

      if (binding?.revoked) {
        throw new HarnessError(
          'REVOKED_CHANNEL_USER',
          `User binding for ${msg.from} on ${msg.connectionId} is revoked`
        );
      }

      const principal: TrustedPrincipal = binding
        ? {
            tenantId: binding.tenantId,
            principalId: binding.principalId,
            roles: binding.roles,
            bindingRevision: binding.bindingRevision,
          }
        : {
            tenantId,
            principalId: `agentmail-sender-${msg.from.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
            roles: ['InboundSender'],
            bindingRevision: 'rev-0',
          };

      const attachmentHashes = msg.attachments.map((a) =>
        createHash('sha256').update(a.content).digest('hex')
      );

      const providerEventId = `eve-evt-${msg.id}`;
      const rawCommand = {
        provider: 'AGENTMAIL' as const,
        installationId: msg.connectionId,
        providerEventId,
        providerUserId: msg.from,
        providerThreadId: `thread-${msg.id}`,
        messageId: msg.id,
        text: msg.text ?? msg.subject,
        attachmentRefs: attachmentHashes,
      };

      const payloadDigest = computeInboundPayloadDigest(rawCommand);
      const command: InboundMessageCommand = {
        ...rawCommand,
        payloadDigest,
      };

      // FENCE BEFORE MUTATION 1: Prevent assignment creation if already cancelled
      assertNotCancelled(context.signal, 'eve_correlate_payable_case:before_create_or_load');

      const { assignment, isDuplicate } = await options.service.createOrLoad(
        command,
        principal,
        { signal: context.signal }
      );

      // FENCE BEFORE MUTATION 2: Prevent inbox status update if cancelled
      assertNotCancelled(context.signal, 'eve_correlate_payable_case:before_mark_processed');

      // Mark message processed in inbox
      await options.inbox.markProcessed(tenantId, msg.id, { signal: context.signal });

      assertNotCancelled(context.signal, 'eve_correlate_payable_case:after_mark_processed');

      return {
        caseId: assignment.caseId,
        assignmentId: assignment.assignmentId,
        isDuplicate,
        status: assignment.state,
      };
    },
  };

  return [
    fetchInboxTool,
    inspectMessageTool,
    extractValidateAttachmentTool,
    ingestDocumentTool,
    correlatePayableCaseTool,
  ];
}
