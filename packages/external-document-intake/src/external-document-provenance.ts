import { createHash } from 'node:crypto';
import { z } from 'zod';

export const IntegrationIdSchema = z.string().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instantSchema = z.iso.datetime();
export const ExternalObjectReferenceSchema = z.strictObject({
  provider: z.enum(['MOCK_ERP', 'QUICKBOOKS', 'XERO', 'BLINKA']),
  connectionId: IntegrationIdSchema,
  externalEntityType: z.enum(['BILL', 'ATTACHMENT', 'DOCUMENT']),
  externalEntityId: IntegrationIdSchema,
});
export const ExternalDocumentReferenceSchema = ExternalObjectReferenceSchema.extend({
  externalRevision: IntegrationIdSchema.optional(),
  externalUpdatedAt: instantSchema.optional(),
  externalAttachmentId: IntegrationIdSchema.optional(),
});
export const ExternalDocumentBindingSchema = ExternalDocumentReferenceSchema.extend({
  bindingVersion: z.literal('1'),
  bindingId: hashSchema,
  tenantId: IntegrationIdSchema,
  sourceId: IntegrationIdSchema,
  sourceHashSha256: hashSchema,
  capturedAt: instantSchema,
});
export const ExternalDocumentReceiptSchema = z.strictObject({
  bindingId: hashSchema,
  sourceId: IntegrationIdSchema,
  sourceHashSha256: hashSchema,
  envelopes: z.array(z.strictObject({
    envelopeId: IntegrationIdSchema,
    pipelineRunId: IntegrationIdSchema,
    processingStatus: z.enum(['READY_FOR_POLICY_EVALUATION', 'REVIEW_REQUIRED', 'REJECTED', 'PROCESSING_FAILED']),
  })).max(50),
  completedAt: instantSchema,
});

export type ExternalObjectReference = z.infer<typeof ExternalObjectReferenceSchema>;
export type ExternalDocumentReference = z.infer<typeof ExternalDocumentReferenceSchema>;
export type ExternalDocumentBinding = z.infer<typeof ExternalDocumentBindingSchema>;
export type ExternalDocumentReceipt = z.infer<typeof ExternalDocumentReceiptSchema>;
export type BindingCapture = ExternalDocumentReference & Pick<ExternalDocumentBinding, 'tenantId' | 'sourceId' | 'sourceHashSha256'>;

export interface ExternalDocumentProvenanceStore {
  capture(input: BindingCapture): Promise<ExternalDocumentBinding>;
  load(tenantId: string, bindingId: string): Promise<ExternalDocumentBinding>;
  history(tenantId: string, reference: ExternalObjectReference): Promise<readonly ExternalDocumentBinding[]>;
  loadReceipt(tenantId: string, bindingId: string): Promise<ExternalDocumentReceipt | null>;
  saveReceipt(tenantId: string, receipt: ExternalDocumentReceipt): Promise<ExternalDocumentReceipt>;
}

export class ExternalDocumentIntakeError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ExternalDocumentIntakeError'; }
}

export function integrationHash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function externalObjectIdentity(reference: ExternalObjectReference): readonly string[] {
  return [reference.provider, reference.connectionId, reference.externalEntityType, reference.externalEntityId];
}

export function externalBindingId(input: BindingCapture): string {
  return integrationHash(JSON.stringify([input.tenantId, ...externalObjectIdentity(input), input.externalRevision ?? null,
    input.externalUpdatedAt ?? null, input.externalAttachmentId ?? null, input.sourceId, input.sourceHashSha256]));
}

export function parseIntegration<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ExternalDocumentIntakeError(code);
  return result.data;
}
