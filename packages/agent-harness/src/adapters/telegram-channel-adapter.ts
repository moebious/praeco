import type { HarnessStore } from '../store.js';
import { HarnessError } from '../state-machine.js';
import type { FinancialOutcome } from '../types.js';

export interface TelegramWebhookUpdate {
  installationId: string;
  updateId: number;
  message?: {
    messageId: number;
    from: {
      id: number | string;
      username?: string;
      firstName?: string;
    };
    chat: {
      id: number | string;
      type: 'private' | 'group' | 'supergroup' | 'channel';
    };
    text?: string;
    date: number;
  };
}

export type TelegramActionOutcome =
  | 'ONBOARDING'
  | 'LINK_SUCCESS'
  | 'LINK_FAILED'
  | 'STATUS_REPORT'
  | 'ACCESS_DENIED'
  | 'APPROVAL_REJECTED'
  | 'UNHANDLED';

export interface TelegramResponse {
  chatId: number | string;
  text: string;
  actionOutcome: TelegramActionOutcome;
  tenantId?: string;
  caseId?: string;
  decisionId?: string;
  assignmentState?: string;
  financialOutcome?: FinancialOutcome;
}

export class TelegramChannelAdapter {
  constructor(private readonly store: HarnessStore) {}

  /**
   * Handles an incoming Telegram bot webhook update:
   * 1. /start: onboarding welcome, grants no financial rights (ADR-006 §13).
   * 2. /link <token>: consumes single-use linking challenge from authenticated web session (ADR-006 §22).
   * 3. /status <caseId>: checks linked tenant identity, blocks cross-tenant access (ADR-006 Abuse case 1).
   * 4. "approve" / /approve: rejects chat approvals; directs to Web FinanceAdmin dashboard (ADR-006 §30, Abuse case 6).
   * 5. Asserts strictly no "PAGÓ" or "PAID" wording on any surface (ADR-007 delta #4).
   */
  async handleUpdate(update: TelegramWebhookUpdate): Promise<TelegramResponse> {
    const message = update.message;
    if (!message || !message.text) {
      return {
        chatId: message?.chat.id ?? 0,
        text: 'Unsupported message format',
        actionOutcome: 'UNHANDLED',
      };
    }

    const chatId = message.chat.id;
    const userId = String(message.from.id);
    const text = message.text.trim();

    // 1. /start command
    if (text === '/start' || text.startsWith('/start ')) {
      return {
        chatId,
        text: 'Welcome to Praeco Financial Teammate. Use /link <token> with a token from your Praeco Web Dashboard to link your Telegram account.',
        actionOutcome: 'ONBOARDING',
      };
    }

    // 2. /link <token> command
    if (text.startsWith('/link')) {
      const parts = text.split(/\s+/);
      const token = parts[1];
      if (!token) {
        return {
          chatId,
          text: 'Usage: /link <one-time-token>',
          actionOutcome: 'LINK_FAILED',
        };
      }

      // Consume challenge and bind atomically in a single transaction
      const nowIso = new Date().toISOString();
      const result = await this.store.consumeLinkingChallenge({
        token,
        provider: 'TELEGRAM',
        installationId: update.installationId,
        consumedByUserId: userId,
        consumedAt: nowIso,
        bindingRevision: 'rev-1',
      });

      if (!result) {
        // Detailed error diagnostic
        const existing = await this.store.getLinkingChallenge(token);
        if (!existing) {
          return {
            chatId,
            text: 'Linking challenge not found or invalid.',
            actionOutcome: 'LINK_FAILED',
          };
        }
        if (
          existing.provider !== 'TELEGRAM' ||
          existing.installationId !== update.installationId
        ) {
          return {
            chatId,
            text: 'Linking challenge does not match this Telegram installation.',
            actionOutcome: 'LINK_FAILED',
          };
        }
        if (existing.revokedAt) {
          return {
            chatId,
            text: 'Linking challenge has been revoked.',
            actionOutcome: 'LINK_FAILED',
          };
        }
        if (Date.parse(existing.expiresAt) <= Date.now()) {
          return {
            chatId,
            text: 'Linking challenge has expired. Request a new token from the dashboard.',
            actionOutcome: 'LINK_FAILED',
          };
        }
        if (existing.consumedAt) {
          return {
            chatId,
            text: 'Linking challenge has already been used.',
            actionOutcome: 'LINK_FAILED',
          };
        }
        return {
          chatId,
          text: 'Linking challenge could not be consumed.',
          actionOutcome: 'LINK_FAILED',
        };
      }

      const { challenge } = result;

      return {
        chatId,
        tenantId: challenge.tenantId,
        text: `Account successfully linked to tenant ${challenge.tenantId} as principal ${challenge.principalId}.`,
        actionOutcome: 'LINK_SUCCESS',
      };
    }

    // 3. Approval rejection in chat (ADR-006 §30, Abuse case 6)
    if (
      text.toLowerCase() === 'approve' ||
      text.toLowerCase().startsWith('approve ') ||
      text.toLowerCase() === '/approve' ||
      text.toLowerCase().startsWith('/approve ')
    ) {
      return {
        chatId,
        text: 'Financial authorization cannot be granted via Telegram. Approvals strictly require an authenticated FinanceAdmin web session.',
        actionOutcome: 'APPROVAL_REJECTED',
      };
    }

    // 4. /status <caseId> command
    if (text.startsWith('/status')) {
      const parts = text.split(/\s+/);
      const caseId = parts[1];
      if (!caseId) {
        return {
          chatId,
          text: 'Usage: /status <caseId>',
          actionOutcome: 'UNHANDLED',
        };
      }

      // Lookup binding
      const bindings = await this.store.findPrincipalBindingsByUser(
        'TELEGRAM',
        update.installationId,
        userId
      );

      const activeBinding = bindings.find((b) => !b.revoked);
      if (!activeBinding) {
        return {
          chatId,
          text: 'Access denied: You must link your Telegram account via /link <token> before querying cases.',
          actionOutcome: 'ACCESS_DENIED',
        };
      }

      const tenantId = activeBinding.tenantId;

      // Cross-tenant defense: check case strictly within tenantId (ADR-006 Abuse case 1)
      const payableCase = await this.store.getCase(tenantId, caseId);
      if (!payableCase) {
        return {
          chatId,
          text: `Case ${caseId} not found or access denied.`,
          actionOutcome: 'ACCESS_DENIED',
        };
      }

      // Look up assignment for this case
      // Match by assignment.caseId within tenant
      const caseAssignments = await this.store.findAssignmentsByCase(tenantId, caseId);
      const assignment = caseAssignments[0] ?? null;

      let decisionOutcome: FinancialOutcome | undefined;
      let decisionId: string | undefined;

      if (assignment?.latestL2DecisionId) {
        const dec = await this.store.getFinancialDecision(
          tenantId,
          assignment.latestL2DecisionId
        );
        if (dec) {
          decisionOutcome = dec.outcome;
          decisionId = dec.decisionId;
        }
      }

      const responseText = this.formatStatusMessage(
        caseId,
        assignment?.state ?? 'UNKNOWN',
        decisionOutcome,
        decisionId
      );

      // Verify invariant: absolutely no "PAGÓ" or "PAID"
      this.assertNoForbiddenWording(responseText);

      return {
        chatId,
        tenantId,
        caseId,
        decisionId,
        assignmentState: assignment?.state,
        financialOutcome: decisionOutcome,
        text: responseText,
        actionOutcome: 'STATUS_REPORT',
      };
    }

    return {
      chatId,
      text: `Unrecognized command. Available commands: /start, /link <token>, /status <caseId>`,
      actionOutcome: 'UNHANDLED',
    };
  }

  private formatStatusMessage(
    caseId: string,
    state: string,
    outcome?: FinancialOutcome,
    decisionId?: string
  ): string {
    const lines = [
      `📋 Case Status: ${caseId}`,
      `Operational State: ${state}`,
    ];

    if (outcome) {
      if (outcome === 'AUTHORIZED_SIMULATED') {
        lines.push(
          `Decision: AUTHORIZED_SIMULATED (Simulated authorization; no funds transferred)`
        );
      } else {
        lines.push(`Decision: ${outcome}`);
      }
    }
    if (decisionId) {
      lines.push(`Decision Ref: ${decisionId}`);
    }

    return lines.join('\n');
  }

  private assertNoForbiddenWording(text: string): void {
    if (/\b(PAID|PAGÓ|PAGO|PAGADO|PAYMENT COMPLETED)\b/i.test(text)) {
      throw new HarnessError(
        'FORBIDDEN_PAID_EQUIVALENT_WORDING',
        `Telegram status response violated invariant: never print PAID or paid equivalents`
      );
    }
  }
}
