import { TransactionalFinancialStore } from './store.js';
import { computeAccountFingerprint, DEFAULT_SYNTHETIC_HMAC_KEY } from './hashing.js';
import { buildCanonicalPayableKey } from './tax-id.js';
import type { PaymentAccountClaim } from '@praeco/evidence-intelligence';

export const DEMO_TENANT_ID = 'synthetic-demo';

export function makeSyntheticAccount(accountIdentifier = '9876543210'): PaymentAccountClaim {
  return {
    rail: 'BANK',
    institution: 'Synthetic Bank',
    accountIdentifier,
    country: 'US',
  };
}

export type ScenarioId =
  | 'BLINKA-01'
  | 'BLINKA-02'
  | 'BLINKA-03'
  | 'BLINKA-04'
  | 'BLINKA-05'
  | 'BLINKA-06'
  | 'BLINKA-07'
  | 'BLINKA-08';

/**
 * Creates an authoritative, isolated TransactionalFinancialStore initialized
 * for each scenario per docs/evaluation/golden-scenarios.md.
 */
export function createScenarioStore(scenarioId: ScenarioId): TransactionalFinancialStore {
  const store = new TransactionalFinancialStore(DEMO_TENANT_ID, {
    policyRevisionId: 'pol-blinka-demo-v1',
    tenantId: DEMO_TENANT_ID,
    maxAutoApproveUsd: '2500.00',
    budgetCurrency: 'USD',
    defaultRecurringTolerancePct: '5.00',
    effectivePeriod: '2026-10',
  });

  // Default synthetic worker grant (P0 acceptance standard)
  const workerGrant = {
    grantId: 'grant-synthetic-worker',
    grantRevisionId: 'grant-rev-1',
    tenantId: DEMO_TENANT_ID,
    workerId: 'worker-agent-demo',
    perPayableLimitUsd: '2500.00',
    allowedActions: ['PROPOSE_PAYABLE', 'REQUEST_SIMULATED_AUTHORIZATION'] as const,
  };
  store.grants.set(workerGrant.grantId, workerGrant);

  const defaultAccount = makeSyntheticAccount('9876543210');
  const defaultFingerprint = computeAccountFingerprint(
    DEMO_TENANT_ID,
    defaultAccount,
    DEFAULT_SYNTHETIC_HMAC_KEY
  );

  switch (scenarioId) {
    case 'BLINKA-01': {
      // Bogotá developer contractor: USD 2,200 eligible
      store.vendors.set('VENDOR-BOG', {
        vendorId: 'VENDOR-BOG',
        legalName: 'Bogotá Contractor LLC',
        taxId: 'CO-900.123.456-7',
        isAllowlisted: true,
        paymentAccountFingerprint: defaultFingerprint,
      });
      store.contracts.set('CTR-BOG-01', {
        contractId: 'CTR-BOG-01',
        vendorId: 'VENDOR-BOG',
        mode: 'EXACT',
        amount: '2200.00',
        currency: 'USD',
        effectiveFrom: '2026-01-01',
      });
      store.budgets.set('BUDGET-2026-10', {
        budgetId: 'BUDGET-2026-10',
        tenantId: DEMO_TENANT_ID,
        period: '2026-10',
        limitUsd: '5000.00',
        committedUsd: '0.00',
        revision: 1,
      });
      break;
    }

    case 'BLINKA-02': {
      // SaaS recurring: USD 480 vs 470 (+2.13% < 5%)
      store.vendors.set('VENDOR-CLOUD', {
        vendorId: 'VENDOR-CLOUD',
        legalName: 'Cloud SaaS Corp',
        taxId: 'US-CLOUD-SAAS-1',
        isAllowlisted: true,
        paymentAccountFingerprint: defaultFingerprint,
      });
      store.contracts.set('CTR-CLOUD-01', {
        contractId: 'CTR-CLOUD-01',
        vendorId: 'VENDOR-CLOUD',
        mode: 'RECURRING_TOLERANCE',
        amount: '470.00',
        currency: 'USD',
        maxPositiveVariancePct: '5.00',
        effectiveFrom: '2026-01-01',
      });
      store.budgets.set('BUDGET-2026-10', {
        budgetId: 'BUDGET-2026-10',
        tenantId: DEMO_TENANT_ID,
        period: '2026-10',
        limitUsd: '5000.00',
        committedUsd: '0.00',
        revision: 1,
      });
      break;
    }

    case 'BLINKA-03': {
      // Mexico agency: MXN 76,000 = USD 3,800 > USD 2,500 threshold
      store.vendors.set('VENDOR-MEX', {
        vendorId: 'VENDOR-MEX',
        legalName: 'Agencia de Diseño CDMX',
        taxId: 'MX-DESIGN-AGENCY',
        isAllowlisted: true,
        paymentAccountFingerprint: defaultFingerprint,
      });
      store.contracts.set('CTR-MEX-01', {
        contractId: 'CTR-MEX-01',
        vendorId: 'VENDOR-MEX',
        mode: 'CEILING',
        amount: '80000.00', // 80,000 MXN max (= 4,000 USD)
        currency: 'MXN',
        effectiveFrom: '2026-01-01',
      });
      store.budgets.set('BUDGET-2026-10', {
        budgetId: 'BUDGET-2026-10',
        tenantId: DEMO_TENANT_ID,
        period: '2026-10',
        limitUsd: '4500.00',
        committedUsd: '0.00',
        revision: 1,
      });
      break;
    }

    case 'BLINKA-04': {
      // Argentina contractor bonus: USD 1,950 vs 1,500 contract
      store.vendors.set('VENDOR-ARG', {
        vendorId: 'VENDOR-ARG',
        legalName: 'Argentina Contractor SRL',
        taxId: 'AR-CONTRACTOR-1',
        isAllowlisted: true,
        paymentAccountFingerprint: defaultFingerprint,
      });
      store.contracts.set('CTR-ARG-01', {
        contractId: 'CTR-ARG-01',
        vendorId: 'VENDOR-ARG',
        mode: 'EXACT',
        amount: '1500.00',
        currency: 'USD',
        effectiveFrom: '2026-01-01',
      });
      store.budgets.set('BUDGET-2026-10', {
        budgetId: 'BUDGET-2026-10',
        tenantId: DEMO_TENANT_ID,
        period: '2026-10',
        limitUsd: '4000.00',
        committedUsd: '0.00',
        revision: 1,
      });
      break;
    }

    case 'BLINKA-05': {
      // Duplicate of Bogotá invoice preseeded in obligations
      store.vendors.set('VENDOR-BOG', {
        vendorId: 'VENDOR-BOG',
        legalName: 'Bogotá Contractor LLC',
        taxId: 'CO-900.123.456-7',
        isAllowlisted: true,
        paymentAccountFingerprint: defaultFingerprint,
      });
      store.contracts.set('CTR-BOG-01', {
        contractId: 'CTR-BOG-01',
        vendorId: 'VENDOR-BOG',
        mode: 'EXACT',
        amount: '2200.00',
        currency: 'USD',
        effectiveFrom: '2026-01-01',
      });
      store.budgets.set('BUDGET-2026-10', {
        budgetId: 'BUDGET-2026-10',
        tenantId: DEMO_TENANT_ID,
        period: '2026-10',
        limitUsd: '4000.00',
        committedUsd: '2200.00',
        revision: 1,
      });
      // Preseeded obligation with matching canonical key
      const canonicalKey = buildCanonicalPayableKey(
        DEMO_TENANT_ID,
        'CO-900.123.456-7',
        'BOG-2026-10'
      );
      store.obligations.set(canonicalKey, {
        obligationId: 'ob-preseeded-bogota',
        tenantId: DEMO_TENANT_ID,
        canonicalKey,
        intentDigestSha256: 'preseeded-matching-digest',
        status: 'COMMITTED',
        committedUsd: '2200.00',
        authorizedAt: '2026-10-15T10:00:00Z',
      });
      break;
    }

    case 'BLINKA-06': {
      // Unknown vendor not allowlisted
      store.budgets.set('BUDGET-2026-10', {
        budgetId: 'BUDGET-2026-10',
        tenantId: DEMO_TENANT_ID,
        period: '2026-10',
        limitUsd: '4000.00',
        committedUsd: '0.00',
        revision: 1,
      });
      break;
    }

    case 'BLINKA-07': {
      // Insufficient monthly budget: USD 2,100 vs USD 1,400
      store.vendors.set('VENDOR-BUDGET', {
        vendorId: 'VENDOR-BUDGET',
        legalName: 'Budget Vendor Inc',
        taxId: 'US-VENDOR-BUDGET',
        isAllowlisted: true,
        paymentAccountFingerprint: defaultFingerprint,
      });
      store.contracts.set('CTR-BUDGET-01', {
        contractId: 'CTR-BUDGET-01',
        vendorId: 'VENDOR-BUDGET',
        mode: 'EXACT',
        amount: '2100.00',
        currency: 'USD',
        effectiveFrom: '2026-01-01',
      });
      store.budgets.set('BUDGET-2026-10', {
        budgetId: 'BUDGET-2026-10',
        tenantId: DEMO_TENANT_ID,
        period: '2026-10',
        limitUsd: '1400.00', // available $1,400 < $2,100
        committedUsd: '0.00',
        revision: 1,
      });
      break;
    }

    case 'BLINKA-08': {
      // Changed bank account: directory has defaultAccount (9876543210), invoice will have altered account
      store.vendors.set('VENDOR-ACCOUNT', {
        vendorId: 'VENDOR-ACCOUNT',
        legalName: 'Account Vendor LLC',
        taxId: 'US-VENDOR-ACCT',
        isAllowlisted: true,
        paymentAccountFingerprint: defaultFingerprint,
      });
      store.contracts.set('CTR-ACCT-01', {
        contractId: 'CTR-ACCT-01',
        vendorId: 'VENDOR-ACCOUNT',
        mode: 'EXACT',
        amount: '1200.00',
        currency: 'USD',
        effectiveFrom: '2026-01-01',
      });
      store.budgets.set('BUDGET-2026-10', {
        budgetId: 'BUDGET-2026-10',
        tenantId: DEMO_TENANT_ID,
        period: '2026-10',
        limitUsd: '4000.00',
        committedUsd: '0.00',
        revision: 1,
      });
      break;
    }
  }

  return store;
}
