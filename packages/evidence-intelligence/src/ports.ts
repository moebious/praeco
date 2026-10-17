import type { ArtifactRef, DocumentSource, DocumentSegment, EvidenceReference, InvoicePayload, ProcessingProvenance } from './contracts.js';

/** Internal adapter data; never crosses the canonical InvoiceEnvelope boundary. */
export interface ParsedPage { page: number; text: string; artifact: ArtifactRef }
export interface ParsedDocument {
  pages: readonly ParsedPage[];
  assurance: 'NATIVE_TEXT' | 'DIGITAL_TEXT' | 'OCR_REQUIRES_REVIEW';
  parser: ProcessingProvenance['parser'];
  raw: unknown;
}
export interface ExtractionDraft { invoice: InvoicePayload; evidence: readonly EvidenceReference[]; segment?: DocumentSegment; issues?: readonly string[] }
export interface ExtractionResult { drafts: readonly ExtractionDraft[]; raw: unknown }
export interface ExtractionPort {
  readonly provider: string;
  readonly version: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  extract(input: { source: DocumentSource; bytes: Uint8Array; parsed: ParsedDocument }): Promise<ExtractionResult>;
}
export interface HostedParsePort {
  parse(source: DocumentSource, bytes: Uint8Array): Promise<{ pages: readonly string[]; version: string; raw: unknown }>;
}
