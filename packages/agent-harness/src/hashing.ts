import { createHash } from 'node:crypto';
import type { InboundMessageCommand } from './types.js';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Computes deterministic SHA-256 digest of inbound message content.
 * Any modification of text, attachments, or IDs produces a distinct hash.
 */
export function computeInboundPayloadDigest(cmd: Omit<InboundMessageCommand, 'payloadDigest'>): string {
  const normalized = {
    provider: cmd.provider,
    installationId: cmd.installationId,
    providerEventId: cmd.providerEventId,
    providerUserId: cmd.providerUserId,
    providerThreadId: cmd.providerThreadId,
    messageId: cmd.messageId,
    text: cmd.text?.trim() ?? '',
    attachmentRefs: [...cmd.attachmentRefs].sort(),
  };
  return sha256Hex(JSON.stringify(normalized));
}

/**
 * Derives stable L2 idempotency key as mandated by ADR-002 and ADR-005:
 * sha256(tenantId + ":" + canonicalPayableKey + ":" + intentDigestSha256)
 */
export function deriveL2IdempotencyKey(
  tenantId: string,
  canonicalPayableKey: string,
  intentDigestSha256: string
): string {
  return sha256Hex(`${tenantId}:${canonicalPayableKey}:${intentDigestSha256}`);
}
