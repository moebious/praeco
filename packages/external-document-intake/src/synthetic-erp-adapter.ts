import { z } from 'zod';
import { createExternalDocumentIntake } from './external-document-intake.js';
import type { ExternalDocumentIntakeOptions, ExternalDocumentResult } from './external-document-intake.js';
import { ExternalDocumentReferenceSchema, ExternalDocumentIntakeError, IntegrationIdSchema, parseIntegration } from './external-document-provenance.js';
import type { ExternalDocumentReference } from './external-document-provenance.js';

const SyntheticErpBillSchema = z.strictObject({
  billId: IntegrationIdSchema,
  revision: IntegrationIdSchema.optional(),
  updatedAt: z.iso.datetime().optional(),
  recordedAmount: z.strictObject({ amount: z.string().regex(/^\d{1,15}(\.\d{1,6})?$/), currency: z.string().regex(/^[A-Z]{3}$/) }),
  beneficiaryReference: IntegrationIdSchema.optional(),
  attachment: z.strictObject({ attachmentId: IntegrationIdSchema, bytes: z.instanceof(Uint8Array),
    channel: z.enum(['PDF', 'IMAGE', 'EMAIL', 'CHAT']), mimeType: z.string().min(1).max(100) }).optional(),
});
export type SyntheticErpBill = z.infer<typeof SyntheticErpBillSchema>;
export type SyntheticErpImportResult =
  | { kind: 'DOCUMENT_REQUIRED'; externalReference: ExternalDocumentReference; accountingRecord: Omit<SyntheticErpBill, 'attachment'> }
  | { kind: 'SUPPLEMENTAL_CONTEXT_IMPORTED'; document: ExternalDocumentResult; accountingRecord: Omit<SyntheticErpBill, 'attachment'> }
  | { kind: 'DOCUMENT_IMPORTED'; document: ExternalDocumentResult; accountingRecord: Omit<SyntheticErpBill, 'attachment'> };

export function createSyntheticErpAdapter(options: Omit<ExternalDocumentIntakeOptions, 'resolveConnection'> & {
  connectionId: string;
  connectionStatus(): Promise<'ACTIVE' | 'REVOKED' | 'UNAVAILABLE'>;
}) {
  const connectionId = parseIntegration(IntegrationIdSchema, options.connectionId, 'INVALID_EXTERNAL_REFERENCE');
  const intake = createExternalDocumentIntake({ ...options, resolveConnection: async input => {
    if (input.tenantId !== options.authenticatedTenantId || input.provider !== 'MOCK_ERP' || input.connectionId !== connectionId) return 'NOT_FOUND';
    return options.connectionStatus();
  } });
  return {
    intake,
    async importBill(input: SyntheticErpBill): Promise<SyntheticErpImportResult> {
      const bill = parseIntegration(SyntheticErpBillSchema, input, 'INVALID_SYNTHETIC_ERP_RECORD');
      let status: string;
      try { status = await options.connectionStatus(); }
      catch { throw new ExternalDocumentIntakeError('EXTERNAL_CONNECTION_UNAVAILABLE'); }
      if (status !== 'ACTIVE') throw new ExternalDocumentIntakeError(status === 'REVOKED' ? 'EXTERNAL_CONNECTION_REVOKED' : 'EXTERNAL_CONNECTION_UNAVAILABLE');
      const reference = parseIntegration(ExternalDocumentReferenceSchema, { provider: 'MOCK_ERP', connectionId, externalEntityType: 'BILL', externalEntityId: bill.billId,
        ...(bill.revision ? { externalRevision: bill.revision } : {}), ...(bill.updatedAt ? { externalUpdatedAt: bill.updatedAt } : {}),
        ...(bill.attachment ? { externalAttachmentId: bill.attachment.attachmentId } : {}) }, 'INVALID_EXTERNAL_REFERENCE');
      const { attachment, ...record } = bill;
      const accountingRecord = structuredClone(record);
      if (!attachment) return { kind: 'DOCUMENT_REQUIRED', externalReference: reference, accountingRecord };
      const document = await intake.ingest({ externalReference: reference, documentBytes: attachment.bytes,
        channel: attachment.channel, mimeType: attachment.mimeType });
      return { kind: document.sourceDisposition === 'SUPPLEMENTAL_CONTEXT' ? 'SUPPLEMENTAL_CONTEXT_IMPORTED' : 'DOCUMENT_IMPORTED', document, accountingRecord };
    },
  };
}
