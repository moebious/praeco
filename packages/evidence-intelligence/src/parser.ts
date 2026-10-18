import { LiteParse } from '@llamaindex/liteparse';
import type { DocumentSource } from './contracts.js';
import type { HostedParsePort, ParsedDocument } from './document-processing-ports.js';
import { FileEvidenceStore } from './store.js';
import { L1Error, utf8 } from './integrity.js';

export class AdaptiveParser {
  // LiteParse uses its bundled local Tesseract OCR only on pages that need it.
  // OCR-assisted output remains REVIEW_REQUIRED until a human validates it.
  private readonly lite = new LiteParse({ ocrEnabled: true, outputFormat: 'json', includeComplexity: true, maxPages: 50, poolSize: 1, parseTimeoutMs: 60_000 });
  constructor(private readonly store: FileEvidenceStore, private readonly hosted?: HostedParsePort) {}
  async close(): Promise<void> { await this.lite.close(); }
  async parse(source: DocumentSource, bytes: Uint8Array): Promise<ParsedDocument> {
    const buffer = Buffer.from(bytes);
    let texts: readonly string[], raw: unknown;
    let assurance: ParsedDocument['assurance'];
    let parser: ParsedDocument['parser'];
    const pdf = buffer.subarray(0, 5).toString('ascii') === '%PDF-';
    const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    if (source.channel === 'CHAT' || source.channel === 'EMAIL') {
      if (source.mimeType !== 'text/plain' || pdf || png || jpeg) throw new L1Error('UNSUPPORTED_NATIVE_CONTENT', 'PARSE');
      const text = utf8(bytes);
      if (/\u0000/.test(text)) throw new L1Error('UNSUPPORTED_NATIVE_CONTENT', 'PARSE');
      texts = text.split('\f');
      raw = { format: 'utf8-page-snapshots', pages: texts };
      assurance = 'NATIVE_TEXT'; parser = { provider: 'DIRECT_TEXT', version: 'utf8-v1' };
    } else if (pdf && source.channel === 'PDF' && source.mimeType === 'application/pdf') {
      let result: Awaited<ReturnType<LiteParse['parse']>>;
      try { result = await this.lite.parse(buffer); }
      catch { throw new L1Error('LITEPARSE_FAILED', 'PARSE', true); }
      if (result.totalPages > 50 || result.pages.length !== result.totalPages || result.pageErrors.length > 0)
        throw new L1Error('PDF_PAGE_LIMIT_OR_PARTIAL_PARSE', 'PARSE');
      // Keep page text separate to preserve original-page citation mapping.
      texts = result.pages.map(page => page.text);
      raw = result;
      // Sparse text alone is common on simple invoices, so it does not trigger OCR review.
      const complex = result.pages.some(page => {
        const c = page.complexity;
        return c && (c.fullPageImage || c.isGarbled || c.layout?.isComplex
          || (c.needsOcr && c.reasons.some(reason => reason !== 'sparse-text')));
      });
      assurance = !complex && texts.every(t => t.trim().length >= 30) ? 'DIGITAL_TEXT' : 'OCR_REQUIRES_REVIEW';
      parser = { provider: 'LITEPARSE', version: '2.15.1' };
      // Use LlamaParse text for both extraction and citation grounding; OCR stays review-only.
      if (this.hosted) {
        const hosted = await this.hosted.parse(source, bytes);
        texts = hosted.pages; raw = hosted.raw; parser = { provider: 'LLAMAPARSE', version: hosted.version };
      }
    } else if (source.channel === 'IMAGE' && ((png && source.mimeType === 'image/png') || (jpeg && source.mimeType === 'image/jpeg'))) {
      if (!this.hosted) throw new L1Error('LLAMAPARSE_NOT_CONFIGURED', 'PARSE');
      const hosted = await this.hosted.parse(source, bytes);
      texts = hosted.pages; raw = hosted.raw; assurance = 'OCR_REQUIRES_REVIEW'; parser = { provider: 'LLAMAPARSE', version: hosted.version };
    } else { throw new L1Error('SOURCE_FORMAT_MISMATCH', 'PARSE'); }
    if (texts.length === 0 || texts.length > 50 || texts.some(text => Buffer.byteLength(text) > 500_000))
      throw new L1Error('PARSE_OUTPUT_LIMIT', 'PARSE');
    const pages = [];
    for (const [index, text] of texts.entries()) {
      const artifact = await this.store.retain(source, 'PARSED_TEXT', Buffer.from(text), index + 1);
      pages.push({ page: index + 1, text, artifact });
    }
    return { pages, assurance, parser, raw: JSON.parse(JSON.stringify(raw)) as unknown };
  }
}
