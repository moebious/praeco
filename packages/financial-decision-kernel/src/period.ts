import type { InvoicePayload } from '@praeco/evidence-intelligence';

export interface DerivedPeriodResult {
  period: string; // YYYY-MM
  periodSource: 'ISSUE_DATE' | 'DUE_DATE';
  reasonCode: 'PERIOD_FROM_DUE_DATE' | null;
}

export function extractYearMonth(isoDate: string): string {
  const parts = isoDate.split('-');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`INVALID_ISO_DATE: ${isoDate}`);
  }
  return `${parts[0]}-${parts[1].padStart(2, '0')}`;
}

/**
 * Derives budget period following L2-4:
 * 1. UTC month of observed issueDate.
 * 2. If issueDate is MISSING/unobserved, fall back to observed dueDate (which is a critical field).
 */
export function deriveBudgetPeriod(invoice: InvoicePayload): DerivedPeriodResult {
  const issueField = invoice.invoice.issueDate;
  if (issueField.state === 'OBSERVED' && issueField.value) {
    return {
      period: extractYearMonth(issueField.value),
      periodSource: 'ISSUE_DATE',
      reasonCode: null,
    };
  }

  const dueField = invoice.invoice.dueDate;
  if (dueField.state === 'OBSERVED' && dueField.value) {
    return {
      period: extractYearMonth(dueField.value),
      periodSource: 'DUE_DATE',
      reasonCode: 'PERIOD_FROM_DUE_DATE',
    };
  }

  throw new Error('NEITHER_ISSUE_DATE_NOR_DUE_DATE_OBSERVED');
}
