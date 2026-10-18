import { randomUUID } from 'node:crypto';
import type {
  InboundMessageCommand,
  TrustedPrincipal,
} from './types.js';
import type { HarnessStore } from './store.js';
import type { AssignmentService } from './service.js';
import { HarnessError } from './state-machine.js';
import { computeInboundPayloadDigest } from './hashing.js';

export interface FakeChannelWebhookPayload {
  provider: InboundMessageCommand['provider'];
  installationId: string;
  providerEventId?: string;
  providerUserId: string;
  providerThreadId: string;
  messageId?: string;
  text?: string;
  attachmentRefs?: readonly string[];
}

export class FakeChannelAdapter {
  constructor(
    private readonly store: HarnessStore,
    private readonly service: AssignmentService
  ) {}

  /**
   * Simulates channel webhook ingestion:
   * 1. Resolves external user binding to an authenticated TrustedPrincipal.
   * 2. Checks revocation status.
   * 3. Normalizes command and calculates payload digest.
   * 4. Dispatches to AssignmentService.createOrLoad.
   */
  async handleInboundWebhook(
    tenantId: string,
    payload: FakeChannelWebhookPayload
  ): Promise<{
    assignmentId: string;
    caseId: string;
    isDuplicate: boolean;
    providerEventId: string;
    principal: TrustedPrincipal;
  }> {
    // 1. Resolve principal binding
    const binding = await this.store.getPrincipalBinding(
      tenantId,
      payload.provider,
      payload.installationId,
      payload.providerUserId
    );

    if (!binding) {
      throw new HarnessError(
        'UNAUTHENTICATED_CHANNEL_USER',
        `No external principal binding found for user ${payload.providerUserId} on ${payload.provider}:${payload.installationId}`
      );
    }

    if (binding.revoked) {
      throw new HarnessError(
        'REVOKED_CHANNEL_USER',
        `Channel user binding for ${payload.providerUserId} has been revoked`
      );
    }

    const principal: TrustedPrincipal = {
      tenantId: binding.tenantId,
      principalId: binding.principalId,
      roles: binding.roles,
      bindingRevision: binding.bindingRevision,
    };

    const providerEventId = payload.providerEventId ?? `evt-${randomUUID()}`;
    const messageId = payload.messageId ?? `msg-${randomUUID()}`;
    const attachmentRefs = payload.attachmentRefs ?? [];

    const rawCommand = {
      provider: payload.provider,
      installationId: payload.installationId,
      providerEventId,
      providerUserId: payload.providerUserId,
      providerThreadId: payload.providerThreadId,
      messageId,
      text: payload.text,
      attachmentRefs,
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

    return {
      assignmentId: assignment.assignmentId,
      caseId: assignment.caseId,
      isDuplicate,
      providerEventId,
      principal,
    };
  }
}
