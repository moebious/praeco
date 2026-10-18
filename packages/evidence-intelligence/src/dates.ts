/** Lossless representation conversion only. Locale comes from an explicit
 * Spanish field label, not from a model guess about an ambiguous date.
 */
export function sourceDateToIso(value: string, label: string): string {
  if (!['fecha emision', 'fecha emisión', 'fecha vencimiento', 'inicio periodo', 'fin periodo'].includes(label)) return value;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : value;
}
