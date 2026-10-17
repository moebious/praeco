/**
 * Praeco L1 — canonical, provider-independent financial evidence contract.
 * Design and interface baseline; runtime implementation remains pending.
 * All inbound documents and model outputs are untrusted.
 *
 * Contract version is a wire-format discriminator, not a repository release label.
 */
export const L1_CONTRACT_VERSION = '3.0.0' as const;
export type ISODate = string;        // YYYY-MM-DD, validated at runtime
export type ISOInstant = string;     // RFC 3339 UTC, validated at runtime
export type DecimalString = string; // Base-10 decimal, never JS floating point math
export type CurrencyCode = string;  // ISO 4217, validated against configured currencies
/** Required demo currencies; others may be explicitly configured. */
export type DemoCurrency = 'USD' | 'COP' | 'MXN';
export type Sha256Hex = string; // Lowercase 64-character SHA-256 hex digest
export type NonEmpty<T> = readonly [T, ...T[]];

export type IntakeChannel = 'PDF' | 'IMAGE' | 'EMAIL' | 'CHAT';
export interface DocumentSource {
  tenantId: string;
  sourceId: string;
  sourceHashSha256: Sha256Hex;
  storageKey: string; // Access-controlled immutable artifact locator
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

/** Bounding box normalized to original page/image, where each coordinate is 0..1. */
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
  /** Untrusted extraction assertion; verifier makes independent findings. */
  proposedBy: string;
}

export interface Candidate<T> { value: T; evidenceIds: readonly string[] }
/** OBSERVED is an extraction assertion, NOT trusted verification. */
export type ObservedField<T> =
  | { state: 'OBSERVED'; value: T; evidenceIds: NonEmpty<string> }
  | { state: 'MISSING'; value: null }
  | { state: 'AMBIGUOUS' | 'CONFLICTING'; value: null; candidates: NonEmpty<Candidate<T>> };

export interface Money { amount: DecimalString; currency: CurrencyCode }
export interface PaymentAccountClaim {
  rail: 'BANK' | 'WALLET' | 'OTHER';
  institution?: string;
  accountIdentifier: string; // Restricted; never expose in public audit output
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
 * One USD = quotePerBase units of quoteCurrency.
 * Demo: USD/COP = 4000 and USD/MXN = 20, both fictional.
 * quoteCurrency must match invoice currency; USD uses identity with null FX.
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
  method: 'USD_IDENTITY' | 'DIVIDE_BY_USD_QUOTE_RATE' | 'NOT_CALCULABLE';
  inputPaths: readonly string[];
  calculationVersion: string;
  /** Exact formula, operands, rate and rounding; never JS Number arithmetic. */
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
/** Persisted by the trusted verifier, never directly authored by LLM agents. */
export interface VerificationReport {
  reportId: string;
  sourceHashSha256: Sha256Hex;
  invoiceDigestSha256: Sha256Hex;
  verifierVersion: string;
  verifiedAt: ISOInstant;
  status: VerificationStatus;
  checks: NonEmpty<VerificationCheck>;
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
  message: string; // No secrets or private source content
}
export interface ProcessingProvenance {
  pipelineVersion: string;
  parser: { provider: 'DIRECT_TEXT' | 'LITEPARSE' | 'LLAMAPARSE'; version: string };
  classification: { provider: 'DOCJEV' | 'SKIPPED' | 'RULE'; version?: string };
  extraction: { provider: string; version: string; configurationDigestSha256: Sha256Hex };
  normalizationVersion: string;
}

/** L1 cannot issue any payment authorization. Non-ready is never auto-authorizable. */
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

/** Adapter-independent entrypoint; may produce multiple invoices for a packet. */
export interface DocumentIntelligencePort {
  process(source: DocumentSource): Promise<readonly InvoiceEnvelope[]>;
}
