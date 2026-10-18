/**
 * Normalizes vendor tax IDs by stripping non-alphanumeric characters and converting to uppercase.
 * Example: "CO-900.123.456-7" -> "CO9001234567"
 */
export function canonicalizeTaxId(rawTaxId: string): string {
  return rawTaxId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/**
 * Builds the canonical business key for an obligation using length-prefixing
 * to prevent delimiter-collision / injection attacks (e.g. invoice numbers containing ':').
 * Format: `${tenantId.length}:${tenantId}:${cleanTaxId.length}:${cleanTaxId}:${cleanInvNum.length}:${cleanInvNum}`
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
  const cleanInvNum = invoiceNumber.trim();
  return `${tenantId.length}:${tenantId}:${cleanTaxId.length}:${cleanTaxId}:${cleanInvNum.length}:${cleanInvNum}`;
}
