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
export interface ExtractionResult { drafts: readonly ExtractionDraft[]; raw: unknown; sourceDisposition?: 'SUPPLEMENTAL_CONTEXT' }
export interface ExtractionPort {
  readonly provider: string;
  readonly version: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  extract(input: { source: DocumentSource; bytes: Uint8Array; parsed: ParsedDocument }): Promise<ExtractionResult>;
}
export interface HostedParsePort {
  parse(source: DocumentSource, bytes: Uint8Array): Promise<{ pages: readonly string[]; version: string; raw: unknown }>;
}

/** Backend adapter contract: atomic immutable insert, identical replay succeeds;
 * a conflicting value for an existing key must fail. Keys are tenant-scoped by
 * the repository. A Neon adapter may store records here while delegating blob
 * bytes to controlled object storage. No SQL/client types enter L1 contracts.
 */
export interface ImmutablePersistencePort {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}
