/**
 * Normalizes vendor tax IDs by stripping non-alphanumeric characters and converting to uppercase.
 * Example: "CO-900.123.456-7" -> "CO9001234567"
 */
export function canonicalizeTaxId(rawTaxId: string): string {
  return rawTaxId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/**
 * Builds the canonical business key for an obligation.
 * Format: `${tenantId}:${canonicalTaxId}:${invoiceNumber}`
 */
export function buildCanonicalPayableKey(
  tenantId: string,
  rawTaxId: string,
  invoiceNumber: string
): string {
  const cleanTaxId = canonicalizeTaxId(rawTaxId);
  if (!cleanTaxId) {
    throw new Error('TAX_ID_EMPTY_OR_UNRESOLVABLE');
  }
  return `${tenantId}:${cleanTaxId}:${invoiceNumber.trim()}`;
}
