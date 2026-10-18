import type {
  FinancialEvaluation,
  FinancialOutcome,
  GateCheckResult,
  ReadyInvoiceEnvelope,
  TrustedFinancialContext,
} from './types.js';
import { resolveCanonicalClaim } from './multi-envelope.js';
import { deriveBudgetPeriod } from './period.js';
import { buildCanonicalPayableKey } from './tax-id.js';
import { toUsdExact } from './decimal.js';
import { computeAccountFingerprint, computeIntentDigest, digest } from './hashing.js';
import {
  evaluateGateG1,
  evaluateGateG2,
  evaluateGateG3,
  evaluateGateG4,
  evaluateGateG5,
  evaluateGateG6,
} from './gates.js';

export function evaluatePayable(
  envelopes: readonly ReadyInvoiceEnvelope[],
  context: TrustedFinancialContext,
  action: 'PROPOSE_PAYABLE' | 'REQUEST_SIMULATED_AUTHORIZATION' = 'REQUEST_SIMULATED_AUTHORIZATION'
): FinancialEvaluation {
  // Step 1: Multi-envelope resolution (L2-3)
  const resolvedClaim = resolveCanonicalClaim(context.tenantId, envelopes);
  if (!resolvedClaim.success) {
    const failedCheck: GateCheckResult = {
      gate: 'G1',
      status: 'FAIL',
      code: resolvedClaim.code,
      explanation: resolvedClaim.explanation,
      evidenceRefs: [],
      authoritativeRecordRefs: [],
    };
    return {
      outcome: 'BLOCKED',
      explanation: resolvedClaim.explanation,
      gateChecks: [failedCheck],
      financialContextDigest: digest({ tenantId: context.tenantId }),
      policyRevisionId: context.policy.policyRevisionId,
      grantRevisionId: context.workerGrant.grantRevisionId,
    };
  }

  const { canonicalEnvelope } = resolvedClaim.claim;
  const inv = canonicalEnvelope.invoice;

  // Step 2: G1 - Evidence Integrity
  const checkG1 = evaluateGateG1(canonicalEnvelope);

  // If G1 failed critically, we cannot safely parse fields for subsequent gates
  if (checkG1.status === 'FAIL') {
    return {
      outcome: 'BLOCKED',
      explanation: checkG1.explanation,
      gateChecks: [checkG1],
      financialContextDigest: digest({ tenantId: context.tenantId }),
      policyRevisionId: context.policy.policyRevisionId,
      grantRevisionId: context.workerGrant.grantRevisionId,
    };
  }

  // Step 3: Period derivation (L2-4)
  const periodInfo = deriveBudgetPeriod(inv);
  const period = periodInfo.period;

  // Step 4: Tax ID and canonical key (L2-6)
  const rawTaxId = inv.beneficiary.taxId.value!;
  const invoiceNumber = inv.invoice.number.value!;
  const canonicalKey = buildCanonicalPayableKey(context.tenantId, rawTaxId, invoiceNumber);

  // Step 5: Exact decimal USD conversion
  const payable = canonicalEnvelope.normalization.candidatePayable!;
  const unroundedUsd = toUsdExact(payable.amount, payable.currency);

  // Step 6: Account fingerprint and Intent Digest (ADR-003)
  const accountClaim = inv.beneficiary.paymentAccount.value!;
  const accountFingerprint = computeAccountFingerprint(
    context.tenantId,
    accountClaim,
    context.hmacKey
  );

  const intentDigest = computeIntentDigest({
    tenantId: context.tenantId,
    canonicalPayableKey: canonicalKey,
    amount: payable.amount,
    currency: payable.currency,
    usdEquivalent: unroundedUsd.toString(),
    accountFingerprint,
    contractRef: inv.commercial.contractReference.value ?? null,
    budgetPeriod: period,
    policyRevisionId: context.policy.policyRevisionId,
    grantRevisionId: context.workerGrant.grantRevisionId,
  });

  // Step 7: G2 - Duplicate check
  const checkG2 = evaluateGateG2(canonicalKey, intentDigest, context);

  // Step 8: G3 - Allowlisted beneficiary & payment account
  const checkG3 = evaluateGateG3(canonicalEnvelope, context);

  // Step 9: G4 - Contract matching
  const checkG4 = evaluateGateG4(checkG3.matchedVendorId, canonicalEnvelope, context);

  // Step 10: G5 - Period budget check
  const checkG5 = evaluateGateG5(period, unroundedUsd, context);

  // Step 11: G6 - Autonomous threshold and worker grant
  const checkG6 = evaluateGateG6(unroundedUsd, action, context);

  const allChecks: GateCheckResult[] = [
    checkG1,
    checkG2,
    checkG3,
    checkG4,
    checkG5,
    checkG6,
  ];

  // Hard gates are G1, G2, G3, G4, G5
  const hardFailures = allChecks
    .slice(0, 5)
    .filter(c => c.status === 'FAIL');

  let outcome: FinancialOutcome;
  let explanation: string;

  if (hardFailures.length > 0) {
    // Hard block strictly dominates! Even if G6 was REVIEW_ELIGIBLE
    if (checkG6.status === 'REVIEW_ELIGIBLE') {
      const idx = allChecks.findIndex(c => c.gate === 'G6');
      if (idx !== -1) {
        allChecks[idx] = {
          ...checkG6,
          facts: { ...checkG6.facts, dominated: true },
        };
      }
    }
    outcome = 'BLOCKED';
    const primaryFailure = hardFailures[0]!;
    explanation = `Pago bloqueado por políticas de control (${primaryFailure.code}): ${primaryFailure.explanation}`;
  } else if (checkG6.status === 'FAIL') {
    outcome = 'BLOCKED';
    explanation = `Pago bloqueado por falta de permisos (${checkG6.code}): ${checkG6.explanation}`;
  } else if (checkG6.status === 'REVIEW_ELIGIBLE') {
    outcome = 'PENDING_HUMAN_APPROVAL';
    explanation = `Pago escalado para aprobación humana (${checkG6.code}): ${checkG6.explanation}`;
  } else {
    outcome = 'AUTHORIZED_SIMULATED';
    explanation = `Pago simulado autorizado automáticamente: cumple todas las reglas de control, contrato (${payable.amount} ${payable.currency}) y presupuesto del periodo (${period}).`;
  }

  const contextDigest = digest({
    tenantId: context.tenantId,
    policyRevision: context.policy.policyRevisionId,
    grantRevision: context.workerGrant.grantRevisionId,
    intentDigest,
  });

  return {
    outcome,
    explanation,
    gateChecks: allChecks,
    financialContextDigest: contextDigest,
    policyRevisionId: context.policy.policyRevisionId,
    grantRevisionId: context.workerGrant.grantRevisionId,
  };
}
