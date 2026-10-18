import { createHash } from 'node:crypto';

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Canonical JSON v1: sorted object keys, array order preserved, no undefined/NaN. */
export function canonicalJson(value: unknown): string {
  function visit(input: unknown): unknown {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(visit);
    if (typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, visit(item)]));
    }
    throw new L1Error('NON_CANONICAL_VALUE', 'VERIFY');
  }
  return JSON.stringify(visit(value));
}

export function digest(value: unknown): string { return sha256(canonicalJson(value)); }

export class L1Error extends Error {
  constructor(
    public readonly code: string,
    public readonly stage: 'INTAKE' | 'PARSE' | 'CLASSIFY' | 'EXTRACT' | 'VERIFY' | 'NORMALIZE',
    public readonly retryable = false,
  ) { super(code); this.name = 'L1Error'; }
}

export function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new L1Error('INVALID_UTF8', 'PARSE'); }
}

export function sliceUtf8(bytes: Uint8Array, start: number, end: number): string {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > bytes.length)
    throw new L1Error('INVALID_EVIDENCE_SPAN', 'VERIFY');
  // Decode prefixes as well: a span cannot start/end inside a multibyte codepoint.
  utf8(bytes.subarray(0, start));
  utf8(bytes.subarray(0, end));
  return utf8(bytes.subarray(start, end));
}
