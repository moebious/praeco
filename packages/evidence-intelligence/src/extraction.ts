import type { Candidate, DocumentSource, EvidenceReference, InvoicePayload, ObservedField } from './contracts.js';
import type { ExtractionPort, ExtractionResult, ParsedDocument, ParsedPage } from './ports.js';
import { digest, L1Error } from './integrity.js';

/** Deliberately bounded offline adapter for explicit labelled synthetic invoices, not an LLM. */
export const FIELD_LABELS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'invoice.number': ['invoice number', 'invoice no', 'numero factura', 'número factura'],
  'invoice.issueDate': ['issue date', 'fecha emision', 'fecha emisión'],
  'invoice.dueDate': ['due date', 'fecha vencimiento'],
  'invoice.billingPeriod.start': ['period start', 'inicio periodo'],
  'invoice.billingPeriod.end': ['period end', 'fin periodo'],
  'beneficiary.legalName': ['beneficiary', 'beneficiario', 'legal name'],
  'beneficiary.taxId': ['tax id', 'nit', 'rfc'],
  'beneficiary.paymentAccount.accountIdentifier': ['account', 'cuenta'],
  'beneficiary.paymentAccount.rail': ['payment rail', 'medio pago'],
  'commercial.contractReference': ['contract', 'contrato'],
  'commercial.purchaseOrderReference': ['purchase order', 'orden compra'],
  'commercial.conceptSummary': ['description', 'concepto'],
  'financials.currency': ['currency', 'moneda'],
  'financials.subtotal.amount': ['subtotal'],
  'financials.taxes.amount': ['taxes', 'impuestos'],
  'financials.discounts.amount': ['discounts', 'descuentos'],
  'financials.totalDue.amount': ['total due', 'total', 'total a pagar'],
  'financials.amountAlreadyPaid.amount': ['already paid', 'pagado'],
  'financials.outstandingBalance.amount': ['outstanding balance', 'saldo pendiente'],
});

export function missing<T>(): ObservedField<T> { return { state: 'MISSING', value: null }; }
export function emptyInvoice(): InvoicePayload {
  return { documentType: 'INVOICE', invoice: { number: missing(), issueDate: missing(), dueDate: missing(), billingPeriod: missing() },
    beneficiary: { legalName: missing(), taxId: missing(), paymentAccount: missing() },
    commercial: { contractReference: missing(), purchaseOrderReference: missing(), conceptSummary: missing(), lineItems: [], lineItemsCompleteness: 'NOT_PRESENT' },
    financials: { currency: missing(), subtotal: missing(), taxes: missing(), discounts: missing(), totalDue: missing(), amountAlreadyPaid: missing(), outstandingBalance: missing() } };
}

export function textEvidence(source: DocumentSource, page: ParsedPage, start: number, end: number, provider: string): EvidenceReference {
  const quote = page.text.slice(start, end);
  const offset = Buffer.byteLength(page.text.slice(0, start));
  return { evidenceId: `ev-${digest({ sourceId: source.sourceId, artifactId: page.artifact.artifactId, offset, quote })}`,
    sourceId: source.sourceId, sourceHashSha256: source.sourceHashSha256,
    locator: { kind: 'TEXT_SPAN', artifactId: page.artifact.artifactId, startUtf8Byte: offset, endUtf8Byte: offset + Buffer.byteLength(quote) },
    quotedText: quote, proposedBy: provider };
}

export function combine<A, B, T>(a: ObservedField<A>, b: ObservedField<B>, make: (a: A, b: B) => T): ObservedField<T> {
  if (a.state === 'MISSING' || b.state === 'MISSING') return missing();
  const aa: readonly Candidate<A>[] = a.state === 'OBSERVED' ? [{ value: a.value, evidenceIds: a.evidenceIds }] : a.candidates;
  const bb: readonly Candidate<B>[] = b.state === 'OBSERVED' ? [{ value: b.value, evidenceIds: b.evidenceIds }] : b.candidates;
  const candidates = aa.flatMap(x => bb.map(y => ({ value: make(x.value, y.value), evidenceIds: [...x.evidenceIds, ...y.evidenceIds] })));
  if (a.state === 'OBSERVED' && b.state === 'OBSERVED')
    return { state: 'OBSERVED', value: make(a.value, b.value), evidenceIds: [...a.evidenceIds, ...b.evidenceIds] };
  return { state: 'CONFLICTING', value: null, candidates: [candidates[0]!, ...candidates.slice(1)] };
}

export class LabelledTextExtractor implements ExtractionPort {
  readonly provider = 'SYNTHETIC_LABELLED_TEXT';
  readonly version = '1.0.0';
  readonly configuration = { format: 'explicit-label-value-v1' };
  async extract({ source, parsed }: { source: DocumentSource; bytes: Uint8Array; parsed: ParsedDocument }): Promise<ExtractionResult> {
    const populated = parsed.pages.filter(p => p.text.trim());
    const isPacket = populated.length > 1 && populated.every(page => /^\s*(?:invoice number|invoice no|n[uú]mero factura)\s*:/im.test(page.text));
    // Unknown packet boundaries are never guessed or merged across invoices.
    if (populated.length > 1 && !isPacket) throw new L1Error('UNCERTAIN_PACKET_BOUNDARIES', 'CLASSIFY');
    const drafts = populated.map(page => {
      const evidence: EvidenceReference[] = [];
      const get = (path: string): ObservedField<string> => {
        const candidates: Candidate<string>[] = [];
        for (const match of page.text.matchAll(/^([^\r\n:]+):[ \t]*([^\r\n]*)/gm)) {
          const label = match[1]!.trim().toLowerCase(), value = match[2]!.trim();
          if (!FIELD_LABELS[path]?.includes(label) || !value) continue;
          const valueOffset = match.index + match[0].lastIndexOf(match[2]!) + match[2]!.indexOf(value);
          const citation = textEvidence(source, page, valueOffset, valueOffset + value.length, this.provider);
          evidence.push(citation); candidates.push({ value, evidenceIds: [citation.evidenceId] });
        }
        if (candidates.length === 0) return missing();
        const unique = [...new Set(candidates.map(c => c.value))];
        if (unique.length === 1) return { state: 'OBSERVED', value: candidates[0]!.value, evidenceIds: [candidates[0]!.evidenceIds[0]!, ...candidates.slice(1).map(c => c.evidenceIds[0]!)] };
        return { state: 'CONFLICTING', value: null, candidates: [candidates[0]!, ...candidates.slice(1)] };
      };
      const invoice = emptyInvoice();
      if (/^\s*cuenta de cobro\s*$/im.test(page.text)) invoice.documentType = 'CUENTA_DE_COBRO';
      invoice.invoice.number = get('invoice.number'); invoice.invoice.issueDate = get('invoice.issueDate'); invoice.invoice.dueDate = get('invoice.dueDate');
      invoice.invoice.billingPeriod = combine(get('invoice.billingPeriod.start'), get('invoice.billingPeriod.end'), (start, end) => ({ start, end }));
      invoice.beneficiary.legalName = get('beneficiary.legalName'); invoice.beneficiary.taxId = get('beneficiary.taxId');
      const rail = get('beneficiary.paymentAccount.rail');
      if (rail.state === 'OBSERVED' && !['BANK', 'WALLET', 'OTHER'].includes(rail.value)) throw new L1Error('INVALID_PAYMENT_RAIL', 'EXTRACT');
      invoice.beneficiary.paymentAccount = combine(get('beneficiary.paymentAccount.accountIdentifier'), rail,
        (accountIdentifier, rail) => ({ accountIdentifier, rail: rail as 'BANK' | 'WALLET' | 'OTHER' }));
      invoice.commercial.contractReference = get('commercial.contractReference');
      invoice.commercial.purchaseOrderReference = get('commercial.purchaseOrderReference'); invoice.commercial.conceptSummary = get('commercial.conceptSummary');
      invoice.financials.currency = get('financials.currency');
      for (const field of ['subtotal', 'taxes', 'discounts', 'totalDue', 'amountAlreadyPaid', 'outstandingBalance'] as const)
        invoice.financials[field] = combine(get(`financials.${field}.amount`), invoice.financials.currency, (amount, currency) => ({ amount, currency }));
      const uniqueEvidence = [...new Map(evidence.map(item => [item.evidenceId, item])).values()];
      if (!isPacket) return { invoice, evidence: uniqueEvidence };
      const segment = { segmentId: `seg-${page.page}`, sourceId: source.sourceId, startPage: page.page, endPage: page.page,
        category: invoice.documentType, classifiedBy: 'RULE' as const };
      return { invoice, segment, evidence: uniqueEvidence.map(item => ({ ...item, segmentId: segment.segmentId })) };
    });
    if (drafts.length === 0) drafts.push({ invoice: emptyInvoice(), evidence: [] });
    return { drafts, raw: { adapter: this.provider, drafts } };
  }
}
