import { z } from 'zod';
import { L1_CONTRACT_VERSION } from './contracts.js';
import type { DocumentSource, InvoicePayload, InvoiceEnvelope, EvidenceReference, FinancialNormalization, VerificationReport } from './contracts.js';

export const IdSchema = z.string().min(1).max(200);
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const DecimalSchema = z.string().regex(/^(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/);
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const DateSchema = z.iso.date();
export const InstantSchema = z.iso.datetime();
const nonemptyIds = z.tuple([IdSchema], IdSchema);
const observed = <T extends z.ZodType>(value: T) => z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('OBSERVED'), value, evidenceIds: nonemptyIds }),
  z.strictObject({ state: z.literal('MISSING'), value: z.null() }),
  z.strictObject({ state: z.enum(['AMBIGUOUS', 'CONFLICTING']), value: z.null(),
    candidates: z.tuple([z.strictObject({ value, evidenceIds: z.array(IdSchema) })],
      z.strictObject({ value, evidenceIds: z.array(IdSchema) })) }),
]);
export const MoneySchema = z.strictObject({ amount: DecimalSchema, currency: CurrencySchema });
const text = z.string().trim().min(1).max(2000);
export const InvoicePayloadSchema: z.ZodType<InvoicePayload> = z.strictObject({
  documentType: z.enum(['INVOICE', 'CUENTA_DE_COBRO']),
  invoice: z.strictObject({ number: observed(text), issueDate: observed(DateSchema), dueDate: observed(DateSchema),
    billingPeriod: observed(z.strictObject({ start: DateSchema, end: DateSchema }).refine(v => v.start <= v.end)) }),
  beneficiary: z.strictObject({ legalName: observed(text), taxId: observed(text),
    paymentAccount: observed(z.strictObject({ rail: z.enum(['BANK', 'WALLET', 'OTHER']),
      accountIdentifier: text, institution: text.optional(), routingIdentifier: text.optional(), country: text.optional() })) }),
  commercial: z.strictObject({ contractReference: observed(text), purchaseOrderReference: observed(text), conceptSummary: observed(text),
    lineItems: z.array(z.strictObject({ lineNumber: z.number().int().positive(), description: observed(text),
      quantity: observed(DecimalSchema), unitPrice: observed(MoneySchema), lineTotal: observed(MoneySchema) })).max(1000),
    lineItemsCompleteness: z.enum(['COMPLETE', 'PARTIAL', 'NOT_PRESENT', 'UNKNOWN']) }),
  financials: z.strictObject({ currency: observed(CurrencySchema), subtotal: observed(MoneySchema), taxes: observed(MoneySchema),
    discounts: observed(MoneySchema), totalDue: observed(MoneySchema), amountAlreadyPaid: observed(MoneySchema), outstandingBalance: observed(MoneySchema) }),
});
export const DocumentSourceSchema: z.ZodType<DocumentSource> = z.strictObject({
  tenantId: IdSchema, sourceId: IdSchema, sourceHashSha256: HashSchema, storageKey: IdSchema,
  channel: z.enum(['PDF', 'IMAGE', 'EMAIL', 'CHAT']), mimeType: z.string().min(1).max(100), byteLength: z.number().int().positive().max(20_000_000),
  receivedAt: InstantSchema, displayName: z.string().max(200).optional(), originMessageId: IdSchema.optional(),
});
const box = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1) })
  .refine(v => v.x + v.width <= 1 && v.y + v.height <= 1);
export const EvidenceSchema: z.ZodType<EvidenceReference> = z.strictObject({
  evidenceId: IdSchema, sourceId: IdSchema, sourceHashSha256: HashSchema, segmentId: IdSchema.optional(),
  locator: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('PAGE_REGION'), page: z.number().int().positive(), box }),
    z.strictObject({ kind: z.literal('TEXT_SPAN'), artifactId: IdSchema, startUtf8Byte: z.number().int().nonnegative(), endUtf8Byte: z.number().int().positive() }),
    z.strictObject({ kind: z.literal('MESSAGE_SPAN'), messageId: IdSchema, startUtf8Byte: z.number().int().nonnegative(), endUtf8Byte: z.number().int().positive() }),
  ]), quotedText: z.string().max(20_000).optional(), proposedBy: IdSchema,
});
export const NormalizationSchema: z.ZodType<FinancialNormalization> = z.strictObject({
  candidatePayable: MoneySchema.nullable(), basis: z.enum(['OUTSTANDING_BALANCE', 'TOTAL_DUE', 'UNDETERMINED']),
  usdEquivalent: MoneySchema.nullable(), fx: z.strictObject({ rateId: IdSchema, baseCurrency: z.literal('USD'), quoteCurrency: CurrencySchema,
    quotePerBase: DecimalSchema, effectiveAt: InstantSchema, source: z.literal('HACKATHON_FIXED'), rounding: z.literal('HALF_EVEN'), outputScale: z.literal(2) }).nullable(),
  method: z.enum(['USD_IDENTITY', 'DIVIDE_BY_USD_QUOTE_RATE', 'NOT_CALCULABLE']), inputPaths: z.array(IdSchema),
  calculationVersion: IdSchema, calculationTrace: z.array(z.string().max(2000)).max(100),
});
export const ReportSchema: z.ZodType<VerificationReport> = z.strictObject({
  reportId: IdSchema, sourceHashSha256: HashSchema, invoiceDigestSha256: HashSchema, verifierVersion: IdSchema,
  verifiedAt: InstantSchema, status: z.enum(['ACCEPTED', 'REVIEW_REQUIRED', 'REJECTED']), assurance: z.literal('STRUCTURE_PROVENANCE_CONSISTENCY'),
  checks: z.tuple([z.strictObject({ checkId: IdSchema, status: z.enum(['PASS', 'WARN', 'FAIL', 'SKIPPED']), severity: z.enum(['INFO', 'REVIEW', 'CRITICAL']),
    code: IdSchema, fieldPaths: z.array(IdSchema), evidenceIds: z.array(IdSchema), facts: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()])) })],
  z.strictObject({ checkId: IdSchema, status: z.enum(['PASS', 'WARN', 'FAIL', 'SKIPPED']), severity: z.enum(['INFO', 'REVIEW', 'CRITICAL']),
    code: IdSchema, fieldPaths: z.array(IdSchema), evidenceIds: z.array(IdSchema), facts: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()])) })),
});
export const ArtifactSchema = z.strictObject({ artifactId: IdSchema, kind: z.enum(['ORIGINAL', 'PARSED_TEXT', 'PAGE_IMAGE', 'EXTRACTION_RAW', 'VERIFICATION_REPORT']), sha256: HashSchema, storageKey: IdSchema });
export const SegmentSchema = z.strictObject({ segmentId: IdSchema, sourceId: IdSchema, startPage: z.number().int().positive(), endPage: z.number().int().positive(),
  category: z.enum(['INVOICE', 'CUENTA_DE_COBRO', 'CONTRACT', 'PURCHASE_ORDER', 'OTHER', 'UNKNOWN']), classifiedBy: z.enum(['DOCJEV', 'RULE', 'HUMAN', 'NOT_REQUIRED']) }).refine(v => v.endPage >= v.startPage);
const EnvelopeStructureSchema = z.strictObject({
  schemaVersion: z.literal(L1_CONTRACT_VERSION), processingStatus: z.enum(['READY_FOR_POLICY_EVALUATION', 'REVIEW_REQUIRED', 'REJECTED', 'PROCESSING_FAILED']),
  envelopeId: IdSchema, pipelineRunId: IdSchema, source: DocumentSourceSchema, segment: SegmentSchema.optional(), invoice: InvoicePayloadSchema.nullable(),
  normalization: NormalizationSchema.nullable(), evidence: z.array(EvidenceSchema).max(10_000), verification: ReportSchema.nullable(), artifacts: z.array(ArtifactSchema),
  provenance: z.strictObject({ pipelineVersion: IdSchema, parser: z.strictObject({ provider: z.enum(['DIRECT_TEXT', 'LITEPARSE', 'LLAMAPARSE']), version: IdSchema }),
    classification: z.strictObject({ provider: z.enum(['DOCJEV', 'SKIPPED', 'RULE']), version: IdSchema.optional() }),
    extraction: z.strictObject({ provider: IdSchema, version: IdSchema, configurationDigestSha256: HashSchema }), normalizationVersion: IdSchema }),
  completedAt: InstantSchema, errors: z.array(z.strictObject({ code: IdSchema, stage: z.enum(['INTAKE', 'PARSE', 'CLASSIFY', 'EXTRACT', 'VERIFY', 'NORMALIZE']), retryable: z.boolean(), message: z.string().max(2000) })),
}).superRefine((v, ctx) => {
  if (v.processingStatus !== 'READY_FOR_POLICY_EVALUATION') return;
  if (!v.invoice || !v.normalization?.candidatePayable || !v.normalization.usdEquivalent || v.normalization.method === 'NOT_CALCULABLE'
    || v.normalization.usdEquivalent.currency !== 'USD' || v.verification?.status !== 'ACCEPTED' || v.evidence.length === 0 || v.artifacts.length === 0
    || v.errors.length > 0 || v.verification.checks.some(c => c.status !== 'PASS' && c.severity !== 'INFO'))
    ctx.addIssue({ code: 'custom', message: 'Ready envelope has unresolved verification or normalization' });
  if (v.invoice && [v.invoice.invoice.number, v.invoice.invoice.dueDate, v.invoice.beneficiary.legalName, v.invoice.beneficiary.taxId,
    v.invoice.beneficiary.paymentAccount, v.invoice.financials.currency, v.invoice.financials.totalDue].some(field => field.state !== 'OBSERVED'))
    ctx.addIssue({ code: 'custom', message: 'Ready envelope requires all critical fields' });
});
export function parseEnvelope(input: unknown): InvoiceEnvelope {
  return EnvelopeStructureSchema.parse(input) as InvoiceEnvelope;
}
