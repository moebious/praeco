import { randomUUID } from 'node:crypto';
import type { DocumentSource, FinancialNormalization, InvoicePayload, VerificationCheck, VerificationReport, EvidenceReference } from './contracts.js';
import type { ExtractionDraft, ParsedDocument } from './ports.js';
import { digest, L1Error, sliceUtf8 } from './integrity.js';
import { FIELD_LABELS, labelsForField } from './extraction.js';
import { EvidenceSchema, InvoicePayloadSchema, SegmentSchema } from './schemas.js';
import { FileEvidenceStore } from './store.js';
import { normalize } from './money.js';
import type { FxRateSnapshot } from './contracts.js';
import { sourceDateToIso } from './dates.js';

export const VERIFIER_VERSION = 'source-grounding-v2';
export const DEFAULT_CRITICAL_FIELDS: readonly string[] = Object.freeze([
  'invoice.number', 'invoice.dueDate', 'beneficiary.legalName', 'beneficiary.taxId',
  'beneficiary.paymentAccount', 'financials.currency', 'financials.totalDue',
]);
interface Field { path: string; state: string; value: unknown; evidenceIds: readonly string[] }
function fields(value: unknown, path = ''): Field[] {
  if (value === null || typeof value !== 'object') return [];
  if ('state' in value) {
    const field = value as { state: string; value: unknown; evidenceIds?: string[] };
    return [{ path, state: field.state, value: field.value, evidenceIds: field.evidenceIds ?? [] }];
  }
  return Object.entries(value).flatMap(([key, item]) => fields(item, path ? `${path}.${key}` : key));
}
function leaves(value: unknown, path: string): { path: string; value: string }[] {
  if (typeof value === 'string' || typeof value === 'number') return [{ path, value: String(value) }];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => leaves(item, `${path}.${key}`));
}
function supports(text: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}.,])${escaped}(?![\\p{L}\\p{N}.,])`, 'u').test(text);
}
function labelForPath(path: string): readonly string[] {
  return labelsForField(path);
}
interface ResolvedCitation { text: string; contextLabel: string | null; page: number }

export class EvidenceVerifier {
  constructor(private readonly store: FileEvidenceStore, private readonly rates: readonly FxRateSnapshot[],
    private readonly now = () => new Date().toISOString(), private readonly critical = DEFAULT_CRITICAL_FIELDS) {}

  async verify(source: DocumentSource, parsed: ParsedDocument, draft: ExtractionDraft): Promise<{ invoice: InvoicePayload; normalization: FinancialNormalization | null; report: VerificationReport }> {
    const invoice = InvoicePayloadSchema.parse(draft.invoice);
    const checks: VerificationCheck[] = [];
    const add = (code: string, status: VerificationCheck['status'], severity: VerificationCheck['severity'], fieldPaths: string[] = [], evidenceIds: string[] = []) => {
      checks.push({ checkId: `check-${checks.length + 1}`, code, status, severity, fieldPaths, evidenceIds, facts: {} });
    };
    await this.store.sourceBytes(source);
    add('IMMUTABLE_SOURCE_BOUND', 'PASS', 'CRITICAL');
    const segment = draft.segment ? SegmentSchema.parse(draft.segment) : undefined;
    if (segment && (segment.sourceId !== source.sourceId || segment.endPage > parsed.pages.length)) add('INVALID_SEGMENT', 'FAIL', 'CRITICAL');
    if (parsed.assurance === 'OCR_REQUIRES_REVIEW') add('OCR_FIDELITY_UNVERIFIED', 'WARN', 'REVIEW');
    for (const issue of new Set(draft.issues ?? [])) add(issue, 'WARN', 'REVIEW');
    const allText = parsed.pages.map(p => p.text).join('\n');
    if (/ignore\s+(?:all|previous)|system\s+prompt|approve\s+all|override\s+(?:policy|rules)|ignora\s+(?:las|todas)/i.test(allText))
      add('DOCUMENT_INSTRUCTION_TEXT_REVIEW', 'WARN', 'REVIEW');
    // These heuristics only route for review. Isolation and deterministic checks, not this regex, enforce trust.
    if (!segment && parsed.pages.length > 1) add('PACKET_BOUNDARY_REVIEW', 'WARN', 'REVIEW');
    const resolved = new Map<string, ResolvedCitation>();
    const ids = new Set<string>();
    for (const untrusted of draft.evidence) {
      const evidence = EvidenceSchema.parse(untrusted);
      if (ids.has(evidence.evidenceId)) { add('DUPLICATE_EVIDENCE_ID', 'FAIL', 'CRITICAL'); continue; }
      ids.add(evidence.evidenceId);
      if (evidence.sourceId !== source.sourceId || evidence.sourceHashSha256 !== source.sourceHashSha256
        || (segment ? evidence.segmentId !== segment.segmentId : evidence.segmentId !== undefined)) {
        add('EVIDENCE_SOURCE_MISMATCH', 'FAIL', 'CRITICAL', [], [evidence.evidenceId]); continue;
      }
      try {
        const cite = await this.resolve(source, parsed, evidence);
        if (segment && (cite.page < segment.startPage || cite.page > segment.endPage)) throw new L1Error('CROSS_SEGMENT_CITATION', 'VERIFY');
        if (!evidence.quotedText || cite.text !== evidence.quotedText) throw new L1Error('EVIDENCE_QUOTE_MISMATCH', 'VERIFY');
        resolved.set(evidence.evidenceId, cite);
      } catch (error) {
        add(error instanceof L1Error ? error.code : 'INVALID_EVIDENCE', 'FAIL', 'CRITICAL', [], [evidence.evidenceId]);
      }
    }
    for (const field of fields(invoice)) {
      if (field.state !== 'OBSERVED') {
        if (this.critical.includes(field.path) || field.state === 'AMBIGUOUS' || field.state === 'CONFLICTING')
          add('CRITICAL_OR_CONFLICTING_FIELD', 'WARN', 'REVIEW', [field.path]);
        continue;
      }
      if (field.evidenceIds.some(id => !resolved.has(id))) { add('FIELD_EVIDENCE_UNRESOLVED', 'FAIL', 'CRITICAL', [field.path], [...field.evidenceIds]); continue; }
      for (const leaf of leaves(field.value, field.path)) {
        const citations = field.evidenceIds.map(id => resolved.get(id)!);
        const datePath = ['invoice.issueDate', 'invoice.dueDate', 'invoice.billingPeriod.start', 'invoice.billingPeriod.end'].includes(leaf.path);
        const supporting = citations.filter(c => supports(c.text, leaf.value) || (datePath && c.contextLabel !== null
          && sourceDateToIso(c.text.includes(':') ? c.text.slice(c.text.indexOf(':') + 1).trim() : c.text, c.contextLabel) === leaf.value));
        if (supporting.length === 0) { add('FIELD_VALUE_NOT_SUPPORTED', 'FAIL', 'CRITICAL', [leaf.path], [...field.evidenceIds]); continue; }
        const expectedLabels = labelForPath(leaf.path);
        if (expectedLabels.length === 0 || !supporting.some(c => c.contextLabel !== null && expectedLabels.includes(c.contextLabel)))
          add('FIELD_CONTEXT_REVIEW', 'WARN', 'REVIEW', [leaf.path], [...field.evidenceIds]);
        else add('FIELD_GROUNDED', 'PASS', 'CRITICAL', [leaf.path], [...field.evidenceIds]);
      }
    }
    // An adapter cannot suppress a conflicting total/currency/account by selecting only one citation.
    const relevantPages = segment ? parsed.pages.filter(p => p.page >= segment.startPage && p.page <= segment.endPage) : parsed.pages;
    for (const [path, labels] of Object.entries(FIELD_LABELS)) {
      const values = relevantPages.flatMap(p => [...p.text.matchAll(/^([^\r\n:]+):[ \t]*([^\r\n]*)/gm)]
        .filter(m => labels.includes(m[1]!.trim().toLowerCase())).map(m => m[2]!.trim()));
      if (new Set(values).size > 1) add('SOURCE_FIELD_CONFLICT', 'WARN', 'REVIEW', [path]);
    }
    let normalization: FinancialNormalization | null = null;
    try { normalization = normalize(invoice, this.rates); add('EXACT_NORMALIZATION', 'PASS', 'CRITICAL'); }
    catch (error) { add(error instanceof L1Error ? error.code : 'INVALID_FINANCIAL_INPUT', 'WARN', 'REVIEW'); }
    const status = checks.some(c => c.status === 'FAIL') ? 'REJECTED' : checks.some(c => c.status !== 'PASS' && c.severity !== 'INFO') ? 'REVIEW_REQUIRED' : 'ACCEPTED';
    const report: VerificationReport = { reportId: `report-${randomUUID()}`, sourceHashSha256: source.sourceHashSha256,
      invoiceDigestSha256: digest(invoice), verifierVersion: VERIFIER_VERSION, verifiedAt: this.now(), status,
      checks: [checks[0]!, ...checks.slice(1)], assurance: 'STRUCTURE_PROVENANCE_CONSISTENCY' };
    return { invoice, normalization, report };
  }
  private async resolve(source: DocumentSource, parsed: ParsedDocument, evidence: EvidenceReference): Promise<ResolvedCitation> {
    const locator = evidence.locator;
    if (locator.kind === 'PAGE_REGION') {
      if (!parsed.pages.some(p => p.page === locator.page)) throw new L1Error('INVALID_EVIDENCE_PAGE', 'VERIFY');
      // Valid geometry is not proof that the cropped pixels contain the claimed value.
      throw new L1Error('PAGE_REGION_REQUIRES_TRUSTED_TEXT_MAPPING', 'VERIFY');
    }
    let bytes: Uint8Array; let page: number;
    if (locator.kind === 'TEXT_SPAN') {
      const parsedPage = parsed.pages.find(p => p.artifact.artifactId === locator.artifactId);
      if (!parsedPage) throw new L1Error('UNBOUND_TEXT_ARTIFACT', 'VERIFY');
      bytes = await this.store.artifact(source, parsedPage.artifact); page = parsedPage.page;
      if (Buffer.from(bytes).toString('utf8') !== parsedPage.text) throw new L1Error('PARSE_ARTIFACT_MISMATCH', 'VERIFY');
    } else {
      if (!source.originMessageId || locator.messageId !== source.originMessageId || (source.channel !== 'CHAT' && source.channel !== 'EMAIL'))
        throw new L1Error('UNBOUND_MESSAGE', 'VERIFY');
      bytes = await this.store.sourceBytes(source); page = 1;
      if (parsed.pages.length !== 1) throw new L1Error('MESSAGE_PACKET_SPAN_UNSUPPORTED', 'VERIFY');
    }
    const text = sliceUtf8(bytes, locator.startUtf8Byte, locator.endUtf8Byte);
    const prefix = Buffer.from(bytes.subarray(0, locator.startUtf8Byte)).toString('utf8');
    const line = prefix.slice(prefix.lastIndexOf('\n') + 1) + text.split('\n')[0];
    const label = /^\s*([^:\r\n]+):/.exec(line)?.[1]?.trim().toLowerCase() ?? null;
    return { text, contextLabel: label, page };
  }
}
