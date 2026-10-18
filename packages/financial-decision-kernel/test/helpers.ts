import type {
  PaymentAccountClaim,
} from '@praeco/evidence-intelligence';
import type {
  BudgetDirectoryEntry,
  ContractDirectoryEntry,
  PolicyConfig,
  TrustedFinancialContext,
  VendorDirectoryEntry,
  WorkerCapabilityGrant,
} from '../src/types.js';
import { computeAccountFingerprint, DEFAULT_SYNTHETIC_HMAC_KEY } from '../src/hashing.js';

export function makeSyntheticAccount(accountIdentifier = '9876543210'): PaymentAccountClaim {
  return {
    rail: 'BANK',
    institution: 'Synthetic Bank',
    accountIdentifier,
    country: 'US',
  };
}

export { createSyntheticEnvelope, type SyntheticEnvelopeOptions } from '../src/fixtures.js';

export function createTestFinancialContext(overrides?: Partial<TrustedFinancialContext>): TrustedFinancialContext {
  const tenantId = overrides?.tenantId ?? 'tenant-acme';
  const defaultAccount = makeSyntheticAccount();
  const defaultAccountFingerprint = computeAccountFingerprint(tenantId, defaultAccount, DEFAULT_SYNTHETIC_HMAC_KEY);

  const policy: PolicyConfig = overrides?.policy ?? {
    policyRevisionId: 'pol-2026-v1',
    tenantId,
    maxAutoApproveUsd: '2500.00',
    budgetCurrency: 'USD',
    defaultRecurringTolerancePct: '5.00',
  };

  const workerGrant: WorkerCapabilityGrant = overrides?.workerGrant ?? {
    grantId: 'grant-worker-01',
    grantRevisionId: 'grant-rev-1',
    tenantId,
    workerId: 'worker-agent-01',
    perPayableLimitUsd: '2500.00',
    allowedActions: ['PROPOSE_PAYABLE', 'REQUEST_SIMULATED_AUTHORIZATION'],
  };

  const vendors: VendorDirectoryEntry[] = overrides?.vendors ? [...overrides.vendors] : [
    {
      vendorId: 'VENDOR-BOG',
      legalName: 'Bogotá Contractor LLC',
      taxId: 'CO-900.123.456-7',
      isAllowlisted: true,
      paymentAccountFingerprint: defaultAccountFingerprint,
    },
  ];

  const contracts: ContractDirectoryEntry[] = overrides?.contracts ? [...overrides.contracts] : [
    {
      contractId: 'CTR-BOG-01',
      vendorId: 'VENDOR-BOG',
      mode: 'EXACT',
      amount: '2200.00',
      currency: 'USD',
      effectiveFrom: '2026-01-01',
    },
  ];

  const budgets: BudgetDirectoryEntry[] = overrides?.budgets ? [...overrides.budgets] : [
    {
      budgetId: 'BUDGET-2026-10',
      tenantId,
      period: '2026-10',
      limitUsd: '5000.00',
      committedUsd: '0.00',
      revision: 1,
      limitRevision: 1,
    },
  ];

  return {
    tenantId,
    policy,
    workerGrant,
    vendors,
    contracts,
    budgets,
    obligations: overrides?.obligations ?? [],
    hmacKey: overrides?.hmacKey ?? DEFAULT_SYNTHETIC_HMAC_KEY,
  };
}
