import type {
  PaymentAccountClaim,
} from '@praeco/evidence-intelligence';
import type {
  ReadyInvoiceEnvelope,
} from './types.js';
import { makeSyntheticAccount } from './scenarios.js';

export interface SyntheticEnvelopeOptions {
  tenantId?: string;
  envelopeId?: string;
  invoiceNumber?: string;
  issueDate?: string | null;
  dueDate?: string;
  legalName?: string;
  taxId?: string;
  account?: PaymentAccountClaim;
  amount: string;
  currency: string;
  contractRef?: string;
  receivedAt?: string;
}

export function createSyntheticEnvelope(opts: SyntheticEnvelopeOptions): ReadyInvoiceEnvelope {
  const tenantId = opts.tenantId ?? 'tenant-acme';
  const envelopeId = opts.envelopeId ?? `env-${Math.random().toString(36).substring(2, 9)}`;
  const invoiceNumber = opts.invoiceNumber ?? 'INV-2026-001';
  const dueDate = opts.dueDate ?? '2026-10-31';
  const legalName = opts.legalName ?? 'Bogotá Contractor LLC';
  const taxId = opts.taxId ?? 'CO-900.123.456-7';
  const account = opts.account ?? makeSyntheticAccount();
  const receivedAt = opts.receivedAt ?? '2026-10-17T12:00:00Z';

  return {
    schemaVersion: '3.0.0',
    processingStatus: 'READY_FOR_POLICY_EVALUATION',
    envelopeId,
    pipelineRunId: `run-${envelopeId}`,
    source: {
      tenantId,
      sourceId: `src-${envelopeId}`,
      sourceHashSha256: 'a'.repeat(64),
      storageKey: `sources/${tenantId}/${envelopeId}.pdf`,
      channel: 'PDF',
      mimeType: 'application/pdf',
      byteLength: 1024,
      receivedAt,
    },
    invoice: {
      documentType: 'INVOICE',
      invoice: {
        number: { state: 'OBSERVED', value: invoiceNumber, evidenceIds: ['ev-inv-num'] },
        issueDate: opts.issueDate === null
          ? { state: 'MISSING', value: null }
          : { state: 'OBSERVED', value: opts.issueDate ?? '2026-10-01', evidenceIds: ['ev-issue-date'] },
        dueDate: { state: 'OBSERVED', value: dueDate, evidenceIds: ['ev-due-date'] },
        billingPeriod: { state: 'OBSERVED', value: { start: '2026-10-01', end: '2026-10-31' }, evidenceIds: ['ev-period'] },
      },
      beneficiary: {
        legalName: { state: 'OBSERVED', value: legalName, evidenceIds: ['ev-legal-name'] },
        taxId: { state: 'OBSERVED', value: taxId, evidenceIds: ['ev-tax-id'] },
        paymentAccount: { state: 'OBSERVED', value: account, evidenceIds: ['ev-account'] },
      },
      commercial: {
        contractReference: opts.contractRef
          ? { state: 'OBSERVED', value: opts.contractRef, evidenceIds: ['ev-contract'] }
          : { state: 'MISSING', value: null },
        purchaseOrderReference: { state: 'MISSING', value: null },
        conceptSummary: { state: 'OBSERVED', value: 'Monthly services', evidenceIds: ['ev-concept'] },
        lineItems: [],
        lineItemsCompleteness: 'NOT_PRESENT',
      },
      financials: {
        currency: { state: 'OBSERVED', value: opts.currency, evidenceIds: ['ev-curr'] },
        subtotal: { state: 'OBSERVED', value: { amount: opts.amount, currency: opts.currency }, evidenceIds: ['ev-tot'] },
        taxes: { state: 'OBSERVED', value: { amount: '0.00', currency: opts.currency }, evidenceIds: ['ev-tax'] },
        discounts: { state: 'OBSERVED', value: { amount: '0.00', currency: opts.currency }, evidenceIds: ['ev-disc'] },
        totalDue: { state: 'OBSERVED', value: { amount: opts.amount, currency: opts.currency }, evidenceIds: ['ev-tot'] },
        amountAlreadyPaid: { state: 'MISSING', value: null },
        outstandingBalance: { state: 'MISSING', value: null },
      },
    },
    normalization: {
      candidatePayable: { amount: opts.amount, currency: opts.currency },
      basis: 'TOTAL_DUE',
      usdEquivalent: { amount: opts.amount, currency: 'USD' },
      fx: opts.currency === 'USD' ? null : {
        rateId: `synthetic-${opts.currency.toLowerCase()}`,
        baseCurrency: 'USD',
        quoteCurrency: opts.currency,
        quotePerBase: opts.currency === 'COP' ? '4000' : '20',
        effectiveAt: '2026-10-01T00:00:00Z',
        source: 'HACKATHON_FIXED',
        rounding: 'HALF_EVEN',
        outputScale: 2,
      },
      method: opts.currency === 'USD' ? 'USD_IDENTITY' : 'DIVIDE_BY_USD_QUOTE_RATE',
      inputPaths: ['financials.totalDue'],
      calculationVersion: 'exact-decimal-v1',
      calculationTrace: [],
    },
    evidence: [
      {
        evidenceId: 'ev-tot',
        sourceId: `src-${envelopeId}`,
        sourceHashSha256: 'a'.repeat(64),
        locator: { kind: 'PAGE_REGION', page: 1, box: { x: 0, y: 0, width: 1, height: 1 } },
        proposedBy: 'TEST',
      },
    ],
    verification: {
      reportId: `rep-${envelopeId}`,
      sourceHashSha256: 'a'.repeat(64),
      invoiceDigestSha256: 'b'.repeat(64),
      verifierVersion: 'test-v1',
      verifiedAt: '2026-10-17T12:00:00Z',
      status: 'ACCEPTED',
      checks: [
        {
          checkId: 'c1',
          status: 'PASS',
          severity: 'INFO',
          code: 'CHECK_OK',
          fieldPaths: [],
          evidenceIds: [],
          facts: {},
        },
      ],
      assurance: 'STRUCTURE_PROVENANCE_CONSISTENCY',
    },
    artifacts: [],
    provenance: {
      pipelineVersion: '3.0.0',
      parser: { provider: 'DIRECT_TEXT', version: '1.0' },
      classification: { provider: 'RULE' },
      extraction: { provider: 'TEST', version: '1.0', configurationDigestSha256: 'c'.repeat(64) },
      normalizationVersion: '1.0',
    },
    completedAt: '2026-10-17T12:00:00Z',
    errors: [],
  };
}
