import type { DocumentSource } from './contracts.js';
import type { ParsedDocument } from './document-processing-ports.js';
import { FIELD_LABELS } from './extraction.js';

/** Conservative deterministic admission for native supplementary messages.
 * Unknown or invoice-like inputs still yield an auditable non-ready envelope.
 * This is classification, not verification of the truth or authority of the chat.
 */
export function isSupplementalContext(source: DocumentSource, parsed: ParsedDocument): boolean {
  if ((source.channel !== 'CHAT' && source.channel !== 'EMAIL') || parsed.assurance !== 'NATIVE_TEXT' || parsed.pages.length !== 1) return false;
  const text = parsed.pages[0]!.text;
  if (!/^\s*(?:supplemental context|contexto complementario|contexto suplementario)\s*$/im.test(text)) return false;
  if (/ignore\s+(?:all|previous)|system\s+prompt|override\s+(?:policy|rules)|ignora\s+(?:las|todas)/i.test(text)) return false;
  const knownLabels = new Set(Object.values(FIELD_LABELS).flat());
  if (/^\s*(?:invoice|factura|cuenta de cobro)\s*$/im.test(text)) return false;
  return ![...text.matchAll(/^([^\r\n:]+):/gm)].some(match => knownLabels.has(match[1]!.trim().toLowerCase())
    || /^line\s+\d+\s+(?:description|quantity|unit price|total)$/i.test(match[1]!.trim()));
}
