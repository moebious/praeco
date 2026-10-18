import { randomUUID } from 'node:crypto';
import type {
  InboundMessageCommand,
  OutboxEvent,
  TenantId,
} from './types.js';
import type { HarnessStore } from './store.js';
import { HarnessError } from './state-machine.js';

export interface OutboundNotificationDelivery {
  deliveryId: string;
  tenantId: TenantId;
  outboxEventId: string;
  provider: InboundMessageCommand['provider'];
  installationId: string;
  recipientUserId: string;
  dispatchedAt: string;
  renderedText: string;
  isRedactedDueToRevocation: boolean;
}

export interface SendNotificationParams {
  event: OutboxEvent;
  provider: InboundMessageCommand['provider'];
  installationId: string;
  recipientUserId: string;
}

export class ChannelNotificationService {
  private readonly deliveries = new Map<string, OutboundNotificationDelivery>();

  constructor(private readonly store: HarnessStore) {}

  /**
   * Dispatches an outbound notification to a channel destination:
   * 1. Re-evaluates recipient permissions at send-time; if revoked between enqueue and send,
   *    strictly redacts private invoice/financial details (ADR-006 §31, Abuse case 10).
   * 2. Enforces outbound deduplication across retries (ADR-006 §36).
   * 3. Asserts zero-paid equivalent invariant: NEVER outputs "PAGÓ", "PAID", or "payment completed" (ADR-007 delta #4).
   * 4. Renders explicit simulated preview for AUTHORIZED_SIMULATED (ADR-006 §32).
   */
  async sendNotification(
    params: SendNotificationParams
  ): Promise<OutboundNotificationDelivery> {
    const { event, provider, installationId, recipientUserId } = params;
    const dedupKey = `${event.tenantId}:${event.eventId}:${installationId}:${recipientUserId}:${provider}`;

    // 1. Outbound deduplication
    const existing = this.deliveries.get(dedupKey);
    if (existing) {
      return existing;
    }

    // 2. Re-check recipient permissions at send time (ADR-006 §31, Abuse case 10)
    const binding = await this.store.getPrincipalBinding(
      event.tenantId,
      provider,
      installationId,
      recipientUserId
    );

    let renderedText: string;
    let isRedactedDueToRevocation = false;

    if (!binding || binding.revoked) {
      // Recipient was revoked after enqueue or lacks valid link - redact private details
      isRedactedDueToRevocation = true;
      renderedText = `[Praeco Security Notice] A financial notification was generated for tenant ${event.tenantId}. Details are withheld because your channel link is unverified or has been revoked. Log in to the Praeco Web Dashboard to view this item.`;
    } else {
      // Recipient is valid and verified
      renderedText = this.renderEventNotification(event);
    }

    // 3. Strict financial invariant: never output "PAID" or "PAGÓ" (ADR-007 delta #4)
    this.assertNoForbiddenWording(renderedText);

    const delivery: OutboundNotificationDelivery = {
      deliveryId: `deliv-${randomUUID()}`,
      tenantId: event.tenantId,
      outboxEventId: event.eventId,
      provider,
      installationId,
      recipientUserId,
      dispatchedAt: new Date().toISOString(),
      renderedText,
      isRedactedDueToRevocation,
    };

    this.deliveries.set(dedupKey, delivery);
    return delivery;
  }

  /**
   * Formats the domain event into human-readable notification text.
   */
  private renderEventNotification(event: OutboxEvent): string {
    const payload = event.payload;
    const lines = [
      `🔔 Praeco Financial Notification: ${event.eventType}`,
      `Tenant: ${event.tenantId}`,
    ];

    if (payload.assignmentId) {
      lines.push(`Assignment: ${payload.assignmentId}`);
    }
    if (payload.caseId) {
      lines.push(`Case: ${payload.caseId}`);
    }

    if (payload.outcome) {
      const outcome = String(payload.outcome);
      if (outcome === 'AUTHORIZED_SIMULATED') {
        lines.push(
          `Status: AUTHORIZED_SIMULATED (Simulated authorization; no funds transferred)`
        );
      } else {
        lines.push(`Status: ${outcome}`);
      }
    } else if (payload.state) {
      lines.push(`State: ${payload.state}`);
    }

    if (payload.decisionId) {
      lines.push(`Decision Ref: ${payload.decisionId}`);
    }

    return lines.join('\n');
  }

  /**
   * Asserts no paid equivalent appears in rendered message.
   */
  private assertNoForbiddenWording(text: string): void {
    if (/\b(PAID|PAGÓ|PAGO|PAGADO|PAYMENT COMPLETED)\b/i.test(text)) {
      throw new HarnessError(
        'FORBIDDEN_PAID_EQUIVALENT_WORDING',
        `Channel notification violated invariant: never print PAID or paid equivalents`
      );
    }
  }

  /**
   * Returns all recorded outbound deliveries.
   */
  getDeliveries(): readonly OutboundNotificationDelivery[] {
    return Array.from(this.deliveries.values());
  }
}
