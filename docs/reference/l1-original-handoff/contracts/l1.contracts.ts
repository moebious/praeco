/**
 * BLINKA L1 v3.0.0 — canonical, provider-independent contract.
 * Architecture and interfaces frozen by design; production implementation pending.
 * All input documents and model outputs are untrusted.
 */
export const L1_CONTRACT_VERSION = '3.0.0' as const;
export type ISODate = string;        // YYYY-MM-DD, validated at runtime
export type ISOInstant = string;     // RFC 3339 UTC, validated at runtime
export type DecimalString = string; // Base-10 decimal, never JS floating point math
export type CurrencyCode = string;  // ISO 4217, validated against configured currencies
/** Minimum currencies supported by the Hackathon acceptance suite; others may be configured. */
export type DemoCurrency = 'USD' | 'COP' | 'MXN';
export type Sha256Hex = string;     // Lowercase 64-character SHA-256 hex digest
export type NonEmpty<T> = readonly [T, ...T[]];

export type IntakeChannel = 'PDF' | 'IMAGE' | 'EMAIL' | 'CHAT';
export interface DocumentSource {
  tenantId: string;
  sourceId: string;
  sourceHashSha256: Sha256Hex;
  storageKey: string; // Internal, access-controlled artifact locator; never a public URL
  channel: IntakeChannel;
  mimeType: string;
  byteLength: number;
  receivedAt: ISOInstant;
  displayName?: string;
  originMessageId?: string;
}

/** Inclusive original-source page range for a sub-document. */
export interface DocumentSegment {
  segmentId: string;
  sourceId: string;
  startPage: number;
  endPage: number;
  category: 'INVOICE' | 'CUENTA_DE_COBRO' | 'CONTRACT' | 'PURCHASE_ORDER' | 'OTHER' | 'UNKNOWN';
  classifiedBy: 'DOCJEV' | 'RULE' | 'HUMAN' | 'NOT_REQUIRED';
}

/** Normalized bounding box relative to original page/image: x,y,w,h each 0..1. */
export interface RelativeBox { x: number; y: number; width: number; height: number }
export type EvidenceLocator =
  | { kind: 'PAGE_REGION'; page: number; box: RelativeBox }
  | { kind: 'TEXT_SPAN'; artifactId: string; startUtf8Byte: number; endUtf8Byte: number }
  | { kind: 'MESSAGE_SPAN'; messageId: string; startUtf8Byte: number; endUtf8Byte: number };
export interface EvidenceReference {
  evidenceId: string;
  sourceId: string;
  sourceHashSha256: Sha256Hex;
  segmentId?: string;
  locator: EvidenceLocator;
  quotedText?: string;
  /** What the model/extractor CLAIMS; verifier makes independent findings. */
  proposedBy: string;
}

export interface Candidate<T> { value: T; evidenceIds: readonly string[] }
/** OBSERVED is only an extraction assertion, never verification or authorization. */
export type ObservedField<T> =
  | { state: 'OBSERVED'; value: T; evidenceIds: NonEmpty<string> }
  | { state: 'MISSING'; value: null }
  | { state: 'AMBIGUOUS' | 'CONFLICTING'; value: null; candidates: NonEmpty<Candidate<T>> };

export interface Money { amount: DecimalString; currency: CurrencyCode }
export interface PaymentAccountClaim {
  rail: 'BANK' | 'WALLET' | 'OTHER';
  institution?: string;
  accountIdentifier: string; // Restricted artifact. Never disclose in public audit output.
  routingIdentifier?: string;
  country?: string;
}
export interface BillingPeriod { start: ISODate; end: ISODate }
export interface InvoiceLineItem {
  lineNumber: number;
  description: ObservedField<string>;
  quantity: ObservedField<DecimalString>;
  unitPrice: ObservedField<Money>;
  lineTotal: ObservedField<Money>;
}
export interface InvoicePayload {
  documentType: 'INVOICE' | 'CUENTA_DE_COBRO';
  invoice: {
    number: ObservedField<string>;
    issueDate: ObservedField<ISODate>;
    dueDate: ObservedField<ISODate>;
    billingPeriod: ObservedField<BillingPeriod>;
  };
  beneficiary: {
    legalName: ObservedField<string>;
    taxId: ObservedField<string>;
    paymentAccount: ObservedField<PaymentAccountClaim>;
  };
  commercial: {
    contractReference: ObservedField<string>;
    purchaseOrderReference: ObservedField<string>;
    conceptSummary: ObservedField<string>;
    lineItems: readonly InvoiceLineItem[];
    lineItemsCompleteness: 'COMPLETE' | 'PARTIAL' | 'NOT_PRESENT' | 'UNKNOWN';
  };
  financials: {
    currency: ObservedField<CurrencyCode>;
    subtotal: ObservedField<Money>;
    taxes: ObservedField<Money>;
    discounts: ObservedField<Money>;
    totalDue: ObservedField<Money>;
    amountAlreadyPaid: ObservedField<Money>;
    outstandingBalance: ObservedField<Money>;
  };
}

/**
 * Canonical demo FX quote: 1 USD = quotePerBase units of quoteCurrency.
 * Example: USD/COP quotePerBase=4000; USD/MXN quotePerBase=20.
 * quoteCurrency MUST equal the invoice's source currency when converting to USD.
 * For USD itself, use the USD_IDENTITY method and null FX snapshot.
 */
export interface FxRateSnapshot {
  rateId: string;
  baseCurrency: 'USD';
  quoteCurrency: CurrencyCode;
  quotePerBase: DecimalString;
  effectiveAt: ISOInstant;
  source: 'HACKATHON_FIXED';
  rounding: 'HALF_EVEN';
  outputScale: 2;
}
export interface FinancialNormalization {
  candidatePayable: Money | null;
  basis: 'OUTSTANDING_BALANCE' | 'TOTAL_DUE' | 'UNDETERMINED';
  usdEquivalent: Money | null;
  fx: FxRateSnapshot | null;
  /** Currency-independent method. Never accept an LLM-computed conversion. */
  method: 'USD_IDENTITY' | 'DIVIDE_BY_USD_QUOTE_RATE' | 'NOT_CALCULABLE';
  inputPaths: readonly string[];
  calculationVersion: string;
  /** Exact formula, rate, operands, and rounding. Never JS number arithmetic. */
  calculationTrace: readonly string[];
}

export type VerificationStatus = 'ACCEPTED' | 'REVIEW_REQUIRED' | 'REJECTED';
export interface VerificationCheck {
  checkId: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'SKIPPED';
  severity: 'INFO' | 'REVIEW' | 'CRITICAL';
  code: string;
  fieldPaths: readonly string[];
  evidenceIds: readonly string[];
  facts: Readonly<Record<string, string | number | boolean | null>>;
}
/** Created and persisted only by the trusted verifier, never directly by agents. */
export interface VerificationReport {
  reportId: string;
  sourceHashSha256: Sha256Hex;
  invoiceDigestSha256: Sha256Hex;
  verifierVersion: string;
  verifiedAt: ISOInstant;
  status: VerificationStatus;
  checks: NonEmpty<VerificationCheck>;
  /** Defines the scope: it does not claim OCR is infallible. */
  assurance: 'STRUCTURE_PROVENANCE_CONSISTENCY';
}

export interface ArtifactRef {
  artifactId: string;
  kind: 'ORIGINAL' | 'PARSED_TEXT' | 'PAGE_IMAGE' | 'EXTRACTION_RAW' | 'VERIFICATION_REPORT';
  sha256: Sha256Hex;
  storageKey: string;
}
export interface ProcessingError {
  code: string;
  stage: 'INTAKE' | 'PARSE' | 'CLASSIFY' | 'EXTRACT' | 'VERIFY' | 'NORMALIZE';
  retryable: boolean;
  message: string; // Must not leak credentials or confidential document content
}
export interface ProcessingProvenance {
  pipelineVersion: string;
  parser: { provider: 'DIRECT_TEXT' | 'LITEPARSE' | 'LLAMAPARSE'; version: string };
  classification: { provider: 'DOCJEV' | 'SKIPPED' | 'RULE'; version?: string };
  extraction: { provider: string; version: string; configurationDigestSha256: Sha256Hex };
  normalizationVersion: string;
}

/** L1 success or safe failure. Policy may never authorize from non-ready status. */
export type InvoiceEnvelope =
  | {
      schemaVersion: typeof L1_CONTRACT_VERSION;
      processingStatus: 'READY_FOR_POLICY_EVALUATION';
      envelopeId: string; pipelineRunId: string; source: DocumentSource;
      segment?: DocumentSegment;
      invoice: InvoicePayload;
      normalization: FinancialNormalization;
      evidence: readonly EvidenceReference[];
      verification: VerificationReport & { status: 'ACCEPTED' };
      artifacts: readonly ArtifactRef[];
      provenance: ProcessingProvenance;
      completedAt: ISOInstant;
      errors: readonly ProcessingError[];
    }
  | {
      schemaVersion: typeof L1_CONTRACT_VERSION;
      processingStatus: 'REVIEW_REQUIRED' | 'REJECTED' | 'PROCESSING_FAILED';
      envelopeId: string; pipelineRunId: string; source: DocumentSource;
      segment?: DocumentSegment;
      invoice: InvoicePayload | null;
      normalization: FinancialNormalization | null;
      evidence: readonly EvidenceReference[];
      verification: VerificationReport | null;
      artifacts: readonly ArtifactRef[];
      provenance: ProcessingProvenance;
      completedAt: ISOInstant;
      errors: readonly ProcessingError[];
    };

export interface L1EvaluationCase {
  fixtureId: string;
  sourceFixturePath: string;
  expectedStatus: InvoiceEnvelope['processingStatus'];
  groundTruthPath: string;
  labels: readonly string[];
  criticalFieldPaths: readonly string[];
}
export interface L1EvaluationSuite {
  suiteId: string;
  contractVersion: typeof L1_CONTRACT_VERSION;
  cases: NonEmpty<L1EvaluationCase>;
  releaseConditions: {
    unsafeReadyCasesMax: 0;
    missingCriticalEvidenceAcceptedMax: 0;
    nondeterministicFxTestsFailedMax: 0;
  };
}

export interface DocumentIntelligencePort {
  process(source: DocumentSource): Promise<readonly InvoiceEnvelope[]>;
}
