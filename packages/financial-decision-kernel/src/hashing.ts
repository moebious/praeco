import { createHash, createHmac } from 'node:crypto';
import type { PaymentAccountClaim } from '@praeco/evidence-intelligence';

export const DEFAULT_SYNTHETIC_HMAC_KEY = 'praeco-synthetic-hmac-key-32bytes!';

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Canonical JSON v1: sorted object keys, array order preserved, no undefined/NaN. */
export function canonicalJson(value: unknown): string {
  function visit(input: unknown): unknown {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') {
      return input;
    }
    if (typeof input === 'number' && Number.isFinite(input)) {
      return input;
    }
    if (Array.isArray(input)) {
      return input.map(visit);
    }
    if (typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, visit(item)])
      );
    }
    throw new Error('NON_CANONICAL_VALUE');
  }
  return JSON.stringify(visit(value));
}

export function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Keyed HMAC-SHA256 account fingerprint matching L1 accountAuditReference */
export function computeAccountFingerprint(
  tenantId: string,
  account: PaymentAccountClaim,
  key: Uint8Array | string = DEFAULT_SYNTHETIC_HMAC_KEY
): string {
  const keyBytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  if (keyBytes.byteLength < 32) {
    throw new Error('ACCOUNT_FINGERPRINT_KEY_TOO_SHORT');
  }
  const hmac = createHmac('sha256', keyBytes)
    .update(canonicalJson({ tenantId, account }))
    .digest('hex');
  return `acct-${hmac}`;
}

export function redactAccountNumber(accountIdentifier: string): string {
  return `***${accountIdentifier.slice(-4)}`;
}

export interface IntentDigestPayload {
  tenantId: string;
  canonicalPayableKey: string;
  amount: string;
  currency: string;
  usdEquivalent: string;
  accountFingerprint: string;
  contractRef: string | null;
  budgetPeriod: string;
  policyRevisionId: string;
  grantRevisionId: string;
}

export function computeIntentDigest(payload: IntentDigestPayload): string {
  return digest(payload);
}
