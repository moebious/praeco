import type {
  GateCheckResult,
  ReadyInvoiceEnvelope,
  TrustedFinancialContext,
} from './types.js';
import type { ObservedField } from '@praeco/evidence-intelligence';
import { decimal, formatUsd } from './decimal.js';
import { canonicalizeTaxId } from './tax-id.js';
import { computeAccountFingerprint } from './hashing.js';
import type { Decimal } from 'decimal.js';

function getEvidenceIds<T>(field: ObservedField<T>): readonly string[] {
  return field.state === 'OBSERVED' ? field.evidenceIds : [];
}

export function evaluateGateG1(envelope: ReadyInvoiceEnvelope): GateCheckResult {
  const inv = envelope.invoice;
  const criticalObserved =
    inv.invoice.number.state === 'OBSERVED' &&
    inv.invoice.dueDate.state === 'OBSERVED' &&
    inv.beneficiary.legalName.state === 'OBSERVED' &&
    inv.beneficiary.taxId.state === 'OBSERVED' &&
    inv.beneficiary.paymentAccount.state === 'OBSERVED' &&
    inv.financials.currency.state === 'OBSERVED' &&
    inv.financials.totalDue.state === 'OBSERVED';

  if (!criticalObserved) {
    return {
      gate: 'G1',
      status: 'FAIL',
      code: 'G1_MISSING_CRITICAL_EVIDENCE',
      explanation: 'Faltan campos críticos obligatorios o no fueron verificados por L1.',
      evidenceRefs: envelope.evidence.map(e => e.evidenceId),
      authoritativeRecordRefs: [envelope.envelopeId],
    };
  }

  if (
    envelope.verification.status !== 'ACCEPTED' ||
    !envelope.normalization ||
    !envelope.normalization.candidatePayable
  ) {
    return {
      gate: 'G1',
      status: 'FAIL',
      code: 'G1_EVIDENCE_INTEGRITY_COMPROMISED',
      explanation: 'El reporte de verificación o la normalización financiera de L1 no son válidos.',
      evidenceRefs: envelope.evidence.map(e => e.evidenceId),
      authoritativeRecordRefs: [envelope.envelopeId],
    };
  }

  return {
    gate: 'G1',
    status: 'PASS',
    code: 'G1_EVIDENCE_INTEGRITY_VERIFIED',
    explanation: 'Evidencia documental íntegra, campos críticos confirmados y verificación L1 aceptada.',
    evidenceRefs: envelope.evidence.map(e => e.evidenceId),
    authoritativeRecordRefs: [envelope.envelopeId],
  };
}

export function evaluateGateG2(
  canonicalKey: string,
  intentDigest: string,
  context: TrustedFinancialContext
): GateCheckResult {
  const existing = context.obligations.find(
    o => o.canonicalKey === canonicalKey && o.status === 'COMMITTED'
  );

  if (!existing) {
    return {
      gate: 'G2',
      status: 'PASS',
      code: 'G2_NO_DUPLICATE',
      explanation: 'No se encontraron obligaciones previas para esta clave canónica de factura.',
      evidenceRefs: [],
      authoritativeRecordRefs: [],
    };
  }

  if (existing.intentDigestSha256 === intentDigest) {
    return {
      gate: 'G2',
      status: 'FAIL',
      code: 'DUPLICATE_EXISTING_AUTHORIZATION',
      explanation: 'Cobro duplicado: ya existe una autorización previa para esta factura y proveedor.',
      evidenceRefs: [],
      authoritativeRecordRefs: [existing.obligationId],
    };
  }

  return {
    gate: 'G2',
    status: 'FAIL',
    code: 'G2_CONFLICT',
    explanation: 'Conflicto de facturación: la clave de factura ya existe con datos contradictorios.',
    evidenceRefs: [],
    authoritativeRecordRefs: [existing.obligationId],
  };
}

export interface GateG3Result extends GateCheckResult {
  matchedVendorId?: string;
}

export function evaluateGateG3(
  envelope: ReadyInvoiceEnvelope,
  context: TrustedFinancialContext
): GateG3Result {
  const rawTaxId = envelope.invoice.beneficiary.taxId.value;
  if (!rawTaxId) {
    return {
      gate: 'G3',
      status: 'FAIL',
      code: 'VENDOR_TAX_ID_UNRESOLVED',
      explanation: 'El identificador fiscal del beneficiario no está presente.',
      evidenceRefs: getEvidenceIds(envelope.invoice.beneficiary.taxId),
      authoritativeRecordRefs: [],
    };
  }

  const cleanTaxId = canonicalizeTaxId(rawTaxId);
  const vendor = context.vendors.find(
    v => canonicalizeTaxId(v.taxId) === cleanTaxId
  );

  if (!vendor || !vendor.isAllowlisted) {
    return {
      gate: 'G3',
      status: 'FAIL',
      code: 'BENEFICIARY_NOT_ALLOWLISTED',
      explanation: 'El beneficiario no se encuentra en la lista de proveedores permitidos.',
      evidenceRefs: getEvidenceIds(envelope.invoice.beneficiary.taxId),
      authoritativeRecordRefs: vendor ? [vendor.vendorId] : [],
    };
  }

  const observedAccount = envelope.invoice.beneficiary.paymentAccount.value;
  if (!observedAccount) {
    return {
      gate: 'G3',
      status: 'FAIL',
      code: 'PAYMENT_ACCOUNT_MISSING',
      explanation: 'No se observó información de cuenta de pago en la factura.',
      evidenceRefs: getEvidenceIds(envelope.invoice.beneficiary.paymentAccount),
      authoritativeRecordRefs: [vendor.vendorId],
    };
  }

  const computedFingerprint = computeAccountFingerprint(
    context.tenantId,
    observedAccount,
    context.hmacKey
  );

  if (computedFingerprint !== vendor.paymentAccountFingerprint) {
    return {
      gate: 'G3',
      status: 'FAIL',
      code: 'PAYMENT_ACCOUNT_MISMATCH',
      explanation: 'La cuenta bancaria de la factura no coincide con la cuenta autorizada en el directorio.',
      evidenceRefs: getEvidenceIds(envelope.invoice.beneficiary.paymentAccount),
      authoritativeRecordRefs: [vendor.vendorId],
    };
  }

  return {
    gate: 'G3',
    status: 'PASS',
    code: 'BENEFICIARY_AND_ACCOUNT_ALLOWLISTED',
    explanation: 'Beneficiario y cuenta de pago autorizados en el directorio.',
    evidenceRefs: [
      ...getEvidenceIds(envelope.invoice.beneficiary.taxId),
      ...getEvidenceIds(envelope.invoice.beneficiary.paymentAccount),
    ],
    authoritativeRecordRefs: [vendor.vendorId],
    matchedVendorId: vendor.vendorId,
  };
}

export function evaluateGateG4(
  vendorId: string | undefined,
  envelope: ReadyInvoiceEnvelope,
  context: TrustedFinancialContext
): GateCheckResult {
  if (!vendorId) {
    return {
      gate: 'G4',
      status: 'FAIL',
      code: 'CONTRACT_VENDOR_UNRESOLVED',
      explanation: 'No se puede validar contrato sin un proveedor previamente identificado.',
      evidenceRefs: [],
      authoritativeRecordRefs: [],
    };
  }

  const contract = context.contracts.find(c => c.vendorId === vendorId);
  if (!contract) {
    return {
      gate: 'G4',
      status: 'FAIL',
      code: 'CONTRACT_NOT_FOUND',
      explanation: 'No se encontró un contrato activo para el proveedor.',
      evidenceRefs: [],
      authoritativeRecordRefs: [],
    };
  }

  const payable = envelope.normalization.candidatePayable!;
  if (payable.currency !== contract.currency) {
    return {
      gate: 'G4',
      status: 'FAIL',
      code: 'CONTRACT_CURRENCY_MISMATCH',
      explanation: `La moneda de la factura (${payable.currency}) no coincide con la del contrato (${contract.currency}).`,
      evidenceRefs: getEvidenceIds(envelope.invoice.financials.currency),
      authoritativeRecordRefs: [contract.contractId],
    };
  }

  const invoiceAmt = decimal(payable.amount);
  const contractAmt = decimal(contract.amount);

  if (contract.mode === 'EXACT') {
    if (invoiceAmt.lt(contractAmt)) {
      return {
        gate: 'G4',
        status: 'FAIL',
        code: 'UNDER_BILLING_DISALLOWED',
        explanation: `Facturación por debajo del monto contractual no permitida en modo EXACT (${invoiceAmt.toString()} < ${contractAmt.toString()}).`,
        evidenceRefs: getEvidenceIds(envelope.invoice.financials.totalDue),
        authoritativeRecordRefs: [contract.contractId],
      };
    }
    if (invoiceAmt.gt(contractAmt)) {
      return {
        gate: 'G4',
        status: 'FAIL',
        code: 'CONTRACT_AMOUNT_MISMATCH',
        explanation: `Monto de factura excede el valor exacto pactado (${invoiceAmt.toString()} > ${contractAmt.toString()}).`,
        evidenceRefs: getEvidenceIds(envelope.invoice.financials.totalDue),
        authoritativeRecordRefs: [contract.contractId],
      };
    }
    return {
      gate: 'G4',
      status: 'PASS',
      code: 'CONTRACT_EXACT_MATCH',
      explanation: `Monto coincide exactamente con el contrato (${contractAmt.toString()} ${contract.currency}).`,
      evidenceRefs: getEvidenceIds(envelope.invoice.financials.totalDue),
      authoritativeRecordRefs: [contract.contractId],
    };
  }

  if (contract.mode === 'RECURRING_TOLERANCE') {
    if (invoiceAmt.lte(contractAmt)) {
      return {
        gate: 'G4',
        status: 'PASS',
        code: 'RECURRING_WITHIN_BASELINE',
        explanation: `Monto recurrente igual o inferior al valor base (${invoiceAmt.toString()} <= ${contractAmt.toString()}).`,
        evidenceRefs: getEvidenceIds(envelope.invoice.financials.totalDue),
        authoritativeRecordRefs: [contract.contractId],
      };
    }

    const maxVariancePct = decimal(
      contract.maxPositiveVariancePct ?? context.policy.defaultRecurringTolerancePct ?? '5.00'
    );
    const variancePct = invoiceAmt
      .minus(contractAmt)
      .div(contractAmt)
      .times(100);

    if (variancePct.lte(maxVariancePct)) {
      return {
        gate: 'G4',
        status: 'PASS',
        code: 'RECURRING_VARIANCE_WITHIN_5_PERCENT',
        explanation: `Incremento recurrente (+${variancePct.toFixed(2)}%) dentro de la tolerancia permitida (+${maxVariancePct.toFixed(2)}%).`,
        evidenceRefs: getEvidenceIds(envelope.invoice.financials.totalDue),
        authoritativeRecordRefs: [contract.contractId],
      };
    }

    return {
      gate: 'G4',
      status: 'FAIL',
      code: 'RECURRING_VARIANCE_EXCEEDED',
      explanation: `Incremento recurrente (+${variancePct.toFixed(2)}%) supera la tolerancia máxima permitida (+${maxVariancePct.toFixed(2)}%).`,
      evidenceRefs: getEvidenceIds(envelope.invoice.financials.totalDue),
      authoritativeRecordRefs: [contract.contractId],
    };
  }

  // CEILING mode
  if (invoiceAmt.lte(contractAmt)) {
    return {
      gate: 'G4',
      status: 'PASS',
      code: 'CONTRACT_WITHIN_CEILING',
      explanation: `Monto dentro del tope máximo contractual autorizable (${invoiceAmt.toString()} <= ${contractAmt.toString()}).`,
      evidenceRefs: getEvidenceIds(envelope.invoice.financials.totalDue),
      authoritativeRecordRefs: [contract.contractId],
    };
  }

  return {
    gate: 'G4',
    status: 'FAIL',
    code: 'CONTRACT_CEILING_EXCEEDED',
    explanation: `Monto supera el tope máximo contractual (${invoiceAmt.toString()} > ${contractAmt.toString()}).`,
    evidenceRefs: getEvidenceIds(envelope.invoice.financials.totalDue),
    authoritativeRecordRefs: [contract.contractId],
  };
}

export function evaluateGateG5(
  period: string,
  unroundedUsd: Decimal,
  context: TrustedFinancialContext
): GateCheckResult {
  const budget = context.budgets.find(
    b => b.tenantId === context.tenantId && b.period === period
  );

  if (!budget) {
    return {
      gate: 'G5',
      status: 'FAIL',
      code: 'BUDGET_NOT_FOUND',
      explanation: `No se encontró presupuesto asignado para el periodo ${period}.`,
      evidenceRefs: [],
      authoritativeRecordRefs: [],
    };
  }

  const availableUsd = decimal(budget.limitUsd).minus(decimal(budget.committedUsd));

  if (unroundedUsd.gt(availableUsd)) {
    return {
      gate: 'G5',
      status: 'FAIL',
      code: 'INSUFFICIENT_PERIOD_BUDGET',
      explanation: `Presupuesto insuficiente: disponible USD ${formatUsd(availableUsd)} para una solicitud de USD ${formatUsd(unroundedUsd)}.`,
      evidenceRefs: [],
      authoritativeRecordRefs: [budget.budgetId],
    };
  }

  return {
    gate: 'G5',
    status: 'PASS',
    code: 'BUDGET_AVAILABLE',
    explanation: `Presupuesto disponible suficiente (requerido USD ${formatUsd(unroundedUsd)} <= disponible USD ${formatUsd(availableUsd)}).`,
    evidenceRefs: [],
    authoritativeRecordRefs: [budget.budgetId],
  };
}

export function evaluateGateG6(
  unroundedUsd: Decimal,
  action: 'PROPOSE_PAYABLE' | 'REQUEST_SIMULATED_AUTHORIZATION',
  context: TrustedFinancialContext
): GateCheckResult {
  const grant = context.workerGrant;
  if (!grant.allowedActions.includes(action)) {
    return {
      gate: 'G6',
      status: 'FAIL',
      code: 'GRANT_ACTION_NOT_PERMITTED',
      explanation: `El trabajador no tiene permiso para ejecutar la acción ${action}.`,
      evidenceRefs: [],
      authoritativeRecordRefs: [grant.grantId],
    };
  }

  const effectiveThreshold = decimal(context.policy.maxAutoApproveUsd);
  const workerLimit = decimal(grant.perPayableLimitUsd);

  // If amount strictly exceeds worker capability limit, cannot auto-approve:
  const cap = effectiveThreshold.lt(workerLimit) ? effectiveThreshold : workerLimit;

  if (unroundedUsd.lte(cap)) {
    return {
      gate: 'G6',
      status: 'PASS',
      code: 'WITHIN_AUTO_APPROVAL_THRESHOLD',
      explanation: `Monto (USD ${formatUsd(unroundedUsd)}) dentro del límite de aprobación autónoma (<= USD ${formatUsd(cap)}).`,
      evidenceRefs: [],
      authoritativeRecordRefs: [grant.grantId],
    };
  }

  return {
    gate: 'G6',
    status: 'REVIEW_ELIGIBLE',
    code: 'AUTO_APPROVAL_THRESHOLD_EXCEEDED',
    explanation: `El monto (USD ${formatUsd(unroundedUsd)}) supera el límite autónomo de USD ${formatUsd(cap)}. Requiere aprobación humana de FinanceAdmin.`,
    evidenceRefs: [],
    authoritativeRecordRefs: [grant.grantId],
  };
}
