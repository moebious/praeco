import { randomUUID } from 'node:crypto';
import type {
  Assignment,
  Checkpoint,
  FinancialDecisionReference,
  InboundMessageCommand,
  LinkingChallenge,
  PayableCase,
  TrustedPrincipal,
} from '../types.js';
import type { HarnessStore } from '../store.js';
import type { AssignmentService } from '../service.js';
import { HarnessError } from '../state-machine.js';
import { computeInboundPayloadDigest } from '../hashing.js';

export interface CaseInspectionView {
  payableCase: PayableCase;
  assignments: readonly Assignment[];
  checkpoints: readonly Checkpoint[];
  decisions: readonly FinancialDecisionReference[];
}

export interface WebSubmitParams {
  installationId: string;
  providerEventId?: string;
  messageId?: string;
  threadId?: string;
  text?: string;
  attachmentRefs?: readonly string[];
}

export class WebChannelAdapter {
  constructor(
    private readonly store: HarnessStore,
    private readonly service: AssignmentService
  ) {}

  /**
   * Generates a single-use, short-lived linking challenge for an external channel
   * like Telegram (ADR-006 §22).
   */
  async createLinkingChallenge(
    principal: TrustedPrincipal,
    params: {
      provider: InboundMessageCommand['provider'];
      installationId: string;
      ttlSeconds?: number;
    }
  ): Promise<LinkingChallenge> {
    // Only authenticated users with admin/reviewer roles can mint linking challenges
    if (
      !principal.roles.includes('FinanceAdmin') &&
      !principal.roles.includes('APReviewer')
    ) {
      throw new HarnessError(
        'UNAUTHORIZED_CHALLENGE_CREATOR',
        `Principal ${principal.principalId} lacks role to generate linking challenges`
      );
    }

    const ttlMs = (params.ttlSeconds ?? 600) * 1000; // default 10 min
    const token = `link-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const challenge: LinkingChallenge = {
      token,
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      roles: [...principal.roles],
      provider: params.provider,
      installationId: params.installationId,
      expiresAt,
    };

    await this.store.saveLinkingChallenge(challenge);
    return challenge;
  }

  /**
   * Revokes an existing principal binding for a channel user (ADR-006 §20).
   */
  async revokePrincipalBinding(
    principal: TrustedPrincipal,
    params: {
      provider: string;
      installationId: string;
      providerUserId: string;
    }
  ): Promise<void> {
    if (!principal.roles.includes('FinanceAdmin')) {
      throw new HarnessError(
        'UNAUTHORIZED_REVOCATION',
        `Principal ${principal.principalId} lacks FinanceAdmin role to revoke bindings`
      );
    }

    await this.store.revokePrincipalBinding(
      principal.tenantId,
      params.provider,
      params.installationId,
      params.providerUserId
    );
  }

  /**
   * Submits an invoice or message from the authenticated web workspace.
   */
  async submitWebCase(
    principal: TrustedPrincipal,
    params: WebSubmitParams
  ): Promise<{
    assignment: Assignment;
    isDuplicate: boolean;
  }> {
    const providerEventId = params.providerEventId ?? `evt-web-${randomUUID()}`;
    const messageId = params.messageId ?? `msg-web-${randomUUID()}`;
    const providerThreadId =
      params.threadId ?? `thread-web-${randomUUID()}`;

    const rawCommand = {
      provider: 'WEB' as const,
      installationId: params.installationId,
      providerEventId,
      providerUserId: principal.principalId,
      providerThreadId,
      messageId,
      text: params.text,
      attachmentRefs: params.attachmentRefs ?? [],
    };

    const payloadDigest = computeInboundPayloadDigest(rawCommand);

    const command: InboundMessageCommand = {
      ...rawCommand,
      payloadDigest,
    };

    return this.service.createOrLoad(command, principal);
  }

  /**
   * Inspects a case within the principal's tenant.
   * Strictly enforces cross-tenant boundary (ADR-006 Abuse case 1).
   */
  async inspectCase(
    principal: TrustedPrincipal,
    caseId: string
  ): Promise<CaseInspectionView> {
    const payableCase = await this.store.getCase(principal.tenantId, caseId);
    if (!payableCase) {
      throw new HarnessError(
        'CASE_NOT_FOUND',
        `Case ${caseId} does not exist in tenant ${principal.tenantId}`
      );
    }

    // Gather assignments for this case
    const assignments = await this.store.findAssignmentsByCase(principal.tenantId, caseId);

    // Gather checkpoints and decisions
    const checkpoints: Checkpoint[] = [];
    const decisions: FinancialDecisionReference[] = [];

    for (const assignment of assignments) {
      const cps = await this.store.getCheckpoints(
        principal.tenantId,
        assignment.assignmentId
      );
      checkpoints.push(...cps);

      if (assignment.latestL2DecisionId) {
        const dec = await this.store.getFinancialDecision(
          principal.tenantId,
          assignment.latestL2DecisionId
        );
        if (dec) {
          decisions.push(dec);
        }
      }
    }

    return {
      payableCase,
      assignments,
      checkpoints,
      decisions,
    };
  }
}
