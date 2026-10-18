import { describe, expect, it } from 'vitest';
import {
  evaluatePayable,
  resolveCanonicalClaim,
  deriveBudgetPeriod,
  computeAccountFingerprint,
  computeIntentDigest,
  buildCanonicalPayableKey,
} from '../src/index.js';
import {
  createSyntheticEnvelope,
  createTestFinancialContext,
  makeSyntheticAccount,
} from './helpers.js';

describe('L2 Slice A — Pure Decision Kernel', () => {
  describe('Canonical Eight Synthetic Scenarios', () => {
    it('Case 01: Bogotá developer contractor (USD 2,200) -> AUTHORIZED_SIMULATED', () => {
      const envelope = createSyntheticEnvelope({
        invoiceNumber: 'BOG-2026-10',
        amount: '2200.00',
        currency: 'USD',
        taxId: 'CO-900.123.456-7',
      });

      const context = createTestFinancialContext({
        vendors: [
          {
            vendorId: 'VENDOR-BOG',
            legalName: 'Bogota Contractor',
            taxId: 'CO-900.123.456-7',
            isAllowlisted: true,
            paymentAccountFingerprint: computeAccountFingerprint('tenant-acme', makeSyntheticAccount()),
          },
        ],
        contracts: [
          {
            contractId: 'CTR-BOG',
            vendorId: 'VENDOR-BOG',
            mode: 'EXACT',
            amount: '2200.00',
            currency: 'USD',
            effectiveFrom: '2026-01-01',
          },
        ],
        budgets: [
          {
            budgetId: 'B-2026-10',
            tenantId: 'tenant-acme',
            period: '2026-10',
            limitUsd: '5000.00',
            committedUsd: '0.00',
            revision: 1,
          },
        ],
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('AUTHORIZED_SIMULATED');
      expect(result.gateChecks.every(c => c.status === 'PASS')).toBe(true);
      expect(result.explanation).toContain('Pago simulado autorizado');
    });

    it('Case 02: Cloud infrastructure recurring SaaS (USD 480 vs 470, +2.13% < 5%) -> AUTHORIZED_SIMULATED', () => {
      const envelope = createSyntheticEnvelope({
        invoiceNumber: 'CLOUD-2026-10',
        amount: '480.00',
        currency: 'USD',
        taxId: 'US-CLOUD-SAAS-1',
      });

      const context = createTestFinancialContext({
        vendors: [
          {
            vendorId: 'VENDOR-CLOUD',
            legalName: 'Cloud SaaS Inc',
            taxId: 'US-CLOUD-SAAS-1',
            isAllowlisted: true,
            paymentAccountFingerprint: computeAccountFingerprint('tenant-acme', makeSyntheticAccount()),
          },
        ],
        contracts: [
          {
            contractId: 'CTR-CLOUD',
            vendorId: 'VENDOR-CLOUD',
            mode: 'RECURRING_TOLERANCE',
            amount: '470.00',
            currency: 'USD',
            maxPositiveVariancePct: '5.00',
            effectiveFrom: '2026-01-01',
          },
        ],
        budgets: [
          {
            budgetId: 'B-2026-10',
            tenantId: 'tenant-acme',
            period: '2026-10',
            limitUsd: '5000.00',
            committedUsd: '0.00',
            revision: 1,
          },
        ],
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('AUTHORIZED_SIMULATED');
      const g4 = result.gateChecks.find(c => c.gate === 'G4');
      expect(g4?.code).toBe('RECURRING_VARIANCE_WITHIN_5_PERCENT');
      expect(g4?.status).toBe('PASS');
    });

    it('Case 03: Mexico design agency (MXN 76,000 / 20 = USD 3,800 > USD 2,500) -> PENDING_HUMAN_APPROVAL', () => {
      const envelope = createSyntheticEnvelope({
        invoiceNumber: 'MEX-2026-10',
        amount: '76000.00',
        currency: 'MXN',
        taxId: 'MX-DESIGN-AGENCY',
      });

      const context = createTestFinancialContext({
        vendors: [
          {
            vendorId: 'VENDOR-MEX',
            legalName: 'Mexico Agency',
            taxId: 'MX-DESIGN-AGENCY',
            isAllowlisted: true,
            paymentAccountFingerprint: computeAccountFingerprint('tenant-acme', makeSyntheticAccount()),
          },
        ],
        contracts: [
          {
            contractId: 'CTR-MEX',
            vendorId: 'VENDOR-MEX',
            mode: 'CEILING',
            amount: '80000.00', // 80,000 MXN ceiling = 4,000 USD
            currency: 'MXN',
            effectiveFrom: '2026-01-01',
          },
        ],
        budgets: [
          {
            budgetId: 'B-2026-10',
            tenantId: 'tenant-acme',
            period: '2026-10',
            limitUsd: '4500.00',
            committedUsd: '0.00',
            revision: 1,
          },
        ],
        policy: {
          policyRevisionId: 'pol-1',
          tenantId: 'tenant-acme',
          maxAutoApproveUsd: '2500.00',
          budgetCurrency: 'USD',
        },
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('PENDING_HUMAN_APPROVAL');
      const g6 = result.gateChecks.find(c => c.gate === 'G6');
      expect(g6?.status).toBe('REVIEW_ELIGIBLE');
      expect(g6?.code).toBe('AUTO_APPROVAL_THRESHOLD_EXCEEDED');
      expect(result.explanation).toContain('Requiere aprobación humana de FinanceAdmin');
    });

    it('Case 04: Argentina contractor undocumented bonus (USD 1,950 vs 1,500 contract) -> BLOCKED', () => {
      const envelope = createSyntheticEnvelope({
        invoiceNumber: 'ARG-2026-10',
        amount: '1950.00',
        currency: 'USD',
        taxId: 'AR-CONTRACTOR-1',
      });

      const context = createTestFinancialContext({
        vendors: [
          {
            vendorId: 'VENDOR-ARG',
            legalName: 'Argentina Contractor',
            taxId: 'AR-CONTRACTOR-1',
            isAllowlisted: true,
            paymentAccountFingerprint: computeAccountFingerprint('tenant-acme', makeSyntheticAccount()),
          },
        ],
        contracts: [
          {
            contractId: 'CTR-ARG',
            vendorId: 'VENDOR-ARG',
            mode: 'EXACT',
            amount: '1500.00',
            currency: 'USD',
            effectiveFrom: '2026-01-01',
          },
        ],
        budgets: [
          {
            budgetId: 'B-2026-10',
            tenantId: 'tenant-acme',
            period: '2026-10',
            limitUsd: '4000.00',
            committedUsd: '0.00',
            revision: 1,
          },
        ],
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('BLOCKED');
      const g4 = result.gateChecks.find(c => c.gate === 'G4');
      expect(g4?.status).toBe('FAIL');
      expect(g4?.code).toBe('CONTRACT_AMOUNT_MISMATCH');
    });

    it('Case 05: Resubmitted duplicate of Bogotá invoice -> BLOCKED', () => {
      const envelope = createSyntheticEnvelope({
        invoiceNumber: 'BOG-2026-10',
        amount: '2200.00',
        currency: 'USD',
        taxId: 'CO-900.123.456-7',
      });

      const key = buildCanonicalPayableKey('tenant-acme', 'CO-900.123.456-7', 'BOG-2026-10');
      const digest = computeIntentDigest({
        tenantId: 'tenant-acme',
        canonicalPayableKey: key,
        amount: '2200.00',
        currency: 'USD',
        usdEquivalent: '2200',
        accountFingerprint: computeAccountFingerprint('tenant-acme', makeSyntheticAccount()),
        contractRef: null,
        budgetPeriod: '2026-10',
        policyRevisionId: 'pol-2026-v1',
        grantRevisionId: 'grant-rev-1',
      });

      const context = createTestFinancialContext({
        obligations: [
          {
            obligationId: 'ob-prior-01',
            tenantId: 'tenant-acme',
            canonicalKey: key,
            intentDigestSha256: digest,
            status: 'COMMITTED',
            committedUsd: '2200.00',
            authorizedAt: '2026-10-15T00:00:00Z',
          },
        ],
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('BLOCKED');
      const g2 = result.gateChecks.find(c => c.gate === 'G2');
      expect(g2?.status).toBe('FAIL');
      expect(g2?.code).toBe('G2_DUPLICATE');
    });

    it('Case 06: New Colombian beneficiary not allowlisted -> BLOCKED', () => {
      const envelope = createSyntheticEnvelope({
        invoiceNumber: 'COP-NEW-2026-10',
        amount: '2400000.00',
        currency: 'COP',
        taxId: 'CO-UNKNOWN-999',
      });

      const context = createTestFinancialContext({
        vendors: [], // unknown vendor
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('BLOCKED');
      const g3 = result.gateChecks.find(c => c.gate === 'G3');
      expect(g3?.status).toBe('FAIL');
      expect(g3?.code).toBe('BENEFICIARY_NOT_ALLOWLISTED');
    });

    it('Case 07: Insufficient monthly budget (USD 2,100 vs USD 1,400) -> BLOCKED', () => {
      const envelope = createSyntheticEnvelope({
        invoiceNumber: 'BUDGET-2026-10',
        amount: '2100.00',
        currency: 'USD',
        taxId: 'US-VENDOR-BUDGET',
      });

      const context = createTestFinancialContext({
        vendors: [
          {
            vendorId: 'VENDOR-BUDGET',
            legalName: 'Budget Vendor',
            taxId: 'US-VENDOR-BUDGET',
            isAllowlisted: true,
            paymentAccountFingerprint: computeAccountFingerprint('tenant-acme', makeSyntheticAccount()),
          },
        ],
        contracts: [
          {
            contractId: 'CTR-BUDGET',
            vendorId: 'VENDOR-BUDGET',
            mode: 'EXACT',
            amount: '2100.00',
            currency: 'USD',
            effectiveFrom: '2026-01-01',
          },
        ],
        budgets: [
          {
            budgetId: 'B-LOW',
            tenantId: 'tenant-acme',
            period: '2026-10',
            limitUsd: '1400.00',
            committedUsd: '0.00',
            revision: 1,
          },
        ],
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('BLOCKED');
      const g5 = result.gateChecks.find(c => c.gate === 'G5');
      expect(g5?.status).toBe('FAIL');
      expect(g5?.code).toBe('INSUFFICIENT_PERIOD_BUDGET');
    });

    it('Case 08: Changed payment account -> BLOCKED', () => {
      const alteredAccount = makeSyntheticAccount('1111222233');
      const envelope = createSyntheticEnvelope({
        invoiceNumber: 'ACCOUNT-2026-10',
        amount: '1200.00',
        currency: 'USD',
        taxId: 'US-VENDOR-ACCT',
        account: alteredAccount, // Different account in invoice
      });

      const context = createTestFinancialContext({
        vendors: [
          {
            vendorId: 'VENDOR-ACCOUNT',
            legalName: 'Account Vendor',
            taxId: 'US-VENDOR-ACCT',
            isAllowlisted: true,
            // Directory has original default account fingerprint
            paymentAccountFingerprint: computeAccountFingerprint('tenant-acme', makeSyntheticAccount('9876543210')),
          },
        ],
        contracts: [
          {
            contractId: 'CTR-ACCT',
            vendorId: 'VENDOR-ACCOUNT',
            mode: 'EXACT',
            amount: '1200.00',
            currency: 'USD',
            effectiveFrom: '2026-01-01',
          },
        ],
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('BLOCKED');
      const g3 = result.gateChecks.find(c => c.gate === 'G3');
      expect(g3?.status).toBe('FAIL');
      expect(g3?.code).toBe('PAYMENT_ACCOUNT_MISMATCH');
    });
  });

  describe('Adversarial & Edge Case Invariants', () => {
    it('Hard-block strictly dominates escalation when invoice exceeds threshold and has an invalid account', () => {
      // Over $2,500 auto-approval threshold (MXN 76,000 / 20 = $3,800), BUT bank account is wrong
      const alteredAccount = makeSyntheticAccount('9999999999');
      const envelope = createSyntheticEnvelope({
        invoiceNumber: 'MEX-ADV-01',
        amount: '76000.00',
        currency: 'MXN',
        taxId: 'MX-DESIGN-AGENCY',
        account: alteredAccount,
      });

      const context = createTestFinancialContext({
        vendors: [
          {
            vendorId: 'VENDOR-MEX',
            legalName: 'Mexico Agency',
            taxId: 'MX-DESIGN-AGENCY',
            isAllowlisted: true,
            paymentAccountFingerprint: computeAccountFingerprint('tenant-acme', makeSyntheticAccount('1234567890')),
          },
        ],
        contracts: [
          {
            contractId: 'CTR-MEX',
            vendorId: 'VENDOR-MEX',
            mode: 'CEILING',
            amount: '80000.00',
            currency: 'MXN',
            effectiveFrom: '2026-01-01',
          },
        ],
        policy: {
          policyRevisionId: 'pol-1',
          tenantId: 'tenant-acme',
          maxAutoApproveUsd: '2500.00',
          budgetCurrency: 'USD',
        },
      });

      const result = evaluatePayable([envelope], context);
      // MUST NOT be PENDING_HUMAN_APPROVAL!
      expect(result.outcome).toBe('BLOCKED');
      const g3 = result.gateChecks.find(c => c.gate === 'G3');
      expect(g3?.status).toBe('FAIL');
      expect(g3?.code).toBe('PAYMENT_ACCOUNT_MISMATCH');
    });

    it('Exact decimal boundary: MXN 50000.01 / 20 = USD 2500.0005 strictly exceeds USD 2500.00 threshold', () => {
      const envelope = createSyntheticEnvelope({
        invoiceNumber: 'MEX-DECIMAL-EDGE',
        amount: '50000.01',
        currency: 'MXN',
        taxId: 'MX-DESIGN-AGENCY',
      });

      const context = createTestFinancialContext({
        vendors: [
          {
            vendorId: 'VENDOR-MEX',
            legalName: 'Mexico Agency',
            taxId: 'MX-DESIGN-AGENCY',
            isAllowlisted: true,
            paymentAccountFingerprint: computeAccountFingerprint('tenant-acme', makeSyntheticAccount()),
          },
        ],
        contracts: [
          {
            contractId: 'CTR-MEX',
            vendorId: 'VENDOR-MEX',
            mode: 'CEILING',
            amount: '60000.00',
            currency: 'MXN',
            effectiveFrom: '2026-01-01',
          },
        ],
        policy: {
          policyRevisionId: 'pol-1',
          tenantId: 'tenant-acme',
          maxAutoApproveUsd: '2500.00',
          budgetCurrency: 'USD',
        },
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('PENDING_HUMAN_APPROVAL');
      const g6 = result.gateChecks.find(c => c.gate === 'G6');
      expect(g6?.status).toBe('REVIEW_ELIGIBLE');
      expect(g6?.code).toBe('AUTO_APPROVAL_THRESHOLD_EXCEEDED');
    });

    it('Worker grant limit: worker with $2,000 limit cannot auto-approve $2,200 invoice', () => {
      const envelope = createSyntheticEnvelope({
        amount: '2200.00',
        currency: 'USD',
      });

      const context = createTestFinancialContext({
        workerGrant: {
          grantId: 'g-worker-low',
          grantRevisionId: 'rev-1',
          tenantId: 'tenant-acme',
          workerId: 'worker-low',
          perPayableLimitUsd: '2000.00', // lower than policy $2,500
          allowedActions: ['PROPOSE_PAYABLE', 'REQUEST_SIMULATED_AUTHORIZATION'],
        },
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('PENDING_HUMAN_APPROVAL');
      const g6 = result.gateChecks.find(c => c.gate === 'G6');
      expect(g6?.status).toBe('REVIEW_ELIGIBLE');
    });

    it('Worker missing REQUEST_SIMULATED_AUTHORIZATION cannot commit', () => {
      const envelope = createSyntheticEnvelope({
        amount: '2200.00',
        currency: 'USD',
      });

      const context = createTestFinancialContext({
        workerGrant: {
          grantId: 'g-worker-readonly',
          grantRevisionId: 'rev-1',
          tenantId: 'tenant-acme',
          workerId: 'worker-readonly',
          perPayableLimitUsd: '2500.00',
          allowedActions: ['PROPOSE_PAYABLE'], // missing REQUEST_SIMULATED_AUTHORIZATION
        },
      });

      const result = evaluatePayable([envelope], context, 'REQUEST_SIMULATED_AUTHORIZATION');
      expect(result.outcome).toBe('BLOCKED');
      const g6 = result.gateChecks.find(c => c.gate === 'G6');
      expect(g6?.status).toBe('FAIL');
      expect(g6?.code).toBe('GRANT_ACTION_NOT_PERMITTED');
    });

    it('Contract EXACT mode rejects under-billing with UNDER_BILLING_DISALLOWED', () => {
      const envelope = createSyntheticEnvelope({
        amount: '2100.00',
        currency: 'USD',
      });

      const context = createTestFinancialContext({
        contracts: [
          {
            contractId: 'CTR-EXACT',
            vendorId: 'VENDOR-BOG',
            mode: 'EXACT',
            amount: '2200.00',
            currency: 'USD',
            effectiveFrom: '2026-01-01',
          },
        ],
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('BLOCKED');
      const g4 = result.gateChecks.find(c => c.gate === 'G4');
      expect(g4?.status).toBe('FAIL');
      expect(g4?.code).toBe('UNDER_BILLING_DISALLOWED');
    });

    it('Contract RECURRING_TOLERANCE allows under-billing but rejects excessive over-billing', () => {
      const underEnvelope = createSyntheticEnvelope({
        amount: '460.00',
        currency: 'USD',
      });

      const context = createTestFinancialContext({
        contracts: [
          {
            contractId: 'CTR-REC',
            vendorId: 'VENDOR-BOG',
            mode: 'RECURRING_TOLERANCE',
            amount: '470.00',
            currency: 'USD',
            maxPositiveVariancePct: '5.00',
            effectiveFrom: '2026-01-01',
          },
        ],
      });

      // Under-billing passes
      const underResult = evaluatePayable([underEnvelope], context);
      expect(underResult.outcome).toBe('AUTHORIZED_SIMULATED');

      // Over-billing +6% (498.20 > 470 + 5% = 493.50) fails
      const overEnvelope = createSyntheticEnvelope({
        amount: '498.20',
        currency: 'USD',
      });
      const overResult = evaluatePayable([overEnvelope], context);
      expect(overResult.outcome).toBe('BLOCKED');
      const g4 = overResult.gateChecks.find(c => c.gate === 'G4');
      expect(g4?.code).toBe('RECURRING_VARIANCE_EXCEEDED');
    });

    it('Budget period derivation falls back to dueDate when issueDate is missing', () => {
      const envelope = createSyntheticEnvelope({
        issueDate: null, // missing
        dueDate: '2026-11-15',
        amount: '100.00',
        currency: 'USD',
      });

      const periodInfo = deriveBudgetPeriod(envelope.invoice);
      expect(periodInfo.period).toBe('2026-11');
      expect(periodInfo.periodSource).toBe('DUE_DATE');
      expect(periodInfo.reasonCode).toBe('PERIOD_FROM_DUE_DATE');
    });

    it('Multi-envelope resolution: identical duplicates pass and record corroborating sources', () => {
      const env1 = createSyntheticEnvelope({
        envelopeId: 'env-source-1',
        invoiceNumber: 'INV-DUP-1',
        amount: '100.00',
        currency: 'USD',
        receivedAt: '2026-10-17T10:00:00Z',
      });
      const env2 = createSyntheticEnvelope({
        envelopeId: 'env-source-2',
        invoiceNumber: 'INV-DUP-1',
        amount: '100.00',
        currency: 'USD',
        receivedAt: '2026-10-17T11:00:00Z',
      });

      const res = resolveCanonicalClaim('tenant-acme', [env1, env2]);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.claim.canonicalEnvelope.envelopeId).toBe('env-source-1'); // earlier registered source
        expect(res.claim.corroboratingDuplicates).toHaveLength(1);
        expect(res.claim.corroboratingDuplicates[0]!.envelopeId).toBe('env-source-2');
      }
    });

    it('Multi-envelope resolution: conflicting amounts fail closed with AMBIGUOUS_PAYABLE_CLAIM', () => {
      const env1 = createSyntheticEnvelope({
        invoiceNumber: 'INV-CONFLICT-1',
        amount: '100.00',
        currency: 'USD',
      });
      const env2 = createSyntheticEnvelope({
        invoiceNumber: 'INV-CONFLICT-1',
        amount: '150.00', // conflicting amount!
        currency: 'USD',
      });

      const res = resolveCanonicalClaim('tenant-acme', [env1, env2]);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('AMBIGUOUS_PAYABLE_CLAIM');
      }
    });

    it('G2 auto-approve concurrency loser with conflicting digest returns G2_CONFLICT', () => {
      const envelope = createSyntheticEnvelope({
        invoiceNumber: 'BOG-2026-10',
        amount: '2200.00',
        currency: 'USD',
        taxId: 'CO-900.123.456-7',
      });

      const key = buildCanonicalPayableKey('tenant-acme', 'CO-900.123.456-7', 'BOG-2026-10');

      const context = createTestFinancialContext({
        obligations: [
          {
            obligationId: 'ob-conflict-01',
            tenantId: 'tenant-acme',
            canonicalKey: key,
            intentDigestSha256: 'different-intent-digest',
            status: 'COMMITTED',
            committedUsd: '2200.00',
            authorizedAt: '2026-10-15T00:00:00Z',
          },
        ],
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('BLOCKED');
      const g2 = result.gateChecks.find(c => c.gate === 'G2');
      expect(g2?.status).toBe('FAIL');
      expect(g2?.code).toBe('G2_CONFLICT');
    });

    it('V-5: normalizes invoice number with NFC and uppercase folding to prevent duplicate bypass', () => {
      const keyUpper = buildCanonicalPayableKey('tenant-acme', 'CO-900.123.456-7', 'BOG-2026-10');
      const keyLower = buildCanonicalPayableKey('tenant-acme', 'CO-900.123.456-7', '  bog-2026-10  ');
      expect(keyUpper).toBe(keyLower);

      // Composed vs decomposed Unicode
      const keyComposed = buildCanonicalPayableKey('tenant-acme', 'CO-900.123.456-7', 'FAC-\u00C9-01');
      const keyDecomposed = buildCanonicalPayableKey('tenant-acme', 'CO-900.123.456-7', 'fac-E\u0301-01');
      expect(keyComposed).toBe(keyDecomposed);
    });

    it('V-7: G4 contract matching fails with CONTRACT_EXPIRED when contract is out of validity window', () => {
      const envelope = createSyntheticEnvelope({
        invoiceNumber: 'BOG-2026-10',
        amount: '2200.00',
        currency: 'USD',
        taxId: 'CO-900.123.456-7',
      });

      const context = createTestFinancialContext({
        vendors: [
          {
            vendorId: 'VENDOR-BOG',
            legalName: 'Bogota Contractor',
            taxId: 'CO-900.123.456-7',
            isAllowlisted: true,
            paymentAccountFingerprint: computeAccountFingerprint('tenant-acme', makeSyntheticAccount()),
          },
        ],
        contracts: [
          {
            contractId: 'CTR-BOG-EXPIRED',
            vendorId: 'VENDOR-BOG',
            mode: 'EXACT',
            amount: '2200.00',
            currency: 'USD',
            effectiveFrom: '2025-01-01',
            effectiveTo: '2025-12-31', // Expired before 2026-10 invoice date!
          },
        ],
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('BLOCKED');
      const g4 = result.gateChecks.find(c => c.gate === 'G4');
      expect(g4?.status).toBe('FAIL');
      expect(g4?.code).toBe('CONTRACT_EXPIRED');
    });

    it('V-7: G4 contract matching fails with AMBIGUOUS_CONTRACT_MATCH if multiple contracts match without reference', () => {
      const envelope = createSyntheticEnvelope({
        invoiceNumber: 'BOG-2026-10',
        amount: '2200.00',
        currency: 'USD',
        taxId: 'CO-900.123.456-7',
      });

      const context = createTestFinancialContext({
        vendors: [
          {
            vendorId: 'VENDOR-BOG',
            legalName: 'Bogota Contractor',
            taxId: 'CO-900.123.456-7',
            isAllowlisted: true,
            paymentAccountFingerprint: computeAccountFingerprint('tenant-acme', makeSyntheticAccount()),
          },
        ],
        contracts: [
          {
            contractId: 'CTR-BOG-01',
            vendorId: 'VENDOR-BOG',
            mode: 'EXACT',
            amount: '2200.00',
            currency: 'USD',
            effectiveFrom: '2026-01-01',
          },
          {
            contractId: 'CTR-BOG-02',
            vendorId: 'VENDOR-BOG',
            mode: 'CEILING',
            amount: '5000.00',
            currency: 'USD',
            effectiveFrom: '2026-01-01',
          },
        ],
      });

      const result = evaluatePayable([envelope], context);
      expect(result.outcome).toBe('BLOCKED');
      const g4 = result.gateChecks.find(c => c.gate === 'G4');
      expect(g4?.status).toBe('FAIL');
      expect(g4?.code).toBe('AMBIGUOUS_CONTRACT_MATCH');
    });
  });
});
