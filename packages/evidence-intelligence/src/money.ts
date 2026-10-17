import { Decimal } from 'decimal.js';
import type { FinancialNormalization, FxRateSnapshot, InvoicePayload, Money, ObservedField } from './contracts.js';
import { DecimalSchema, InvoicePayloadSchema } from './schemas.js';
import { L1Error } from './integrity.js';

const Exact = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_EVEN });
export const NORMALIZATION_VERSION = 'exact-decimal-v1';
export const DEMO_RATES: readonly FxRateSnapshot[] = Object.freeze([
  { rateId: 'synthetic-cop-2026-10-17', baseCurrency: 'USD', quoteCurrency: 'COP', quotePerBase: '4000', effectiveAt: '2026-10-17T00:00:00Z', source: 'HACKATHON_FIXED', rounding: 'HALF_EVEN', outputScale: 2 },
  { rateId: 'synthetic-mxn-2026-10-17', baseCurrency: 'USD', quoteCurrency: 'MXN', quotePerBase: '20', effectiveAt: '2026-10-17T00:00:00Z', source: 'HACKATHON_FIXED', rounding: 'HALF_EVEN', outputScale: 2 },
].map(rate => Object.freeze(rate)) as FxRateSnapshot[]);
export function decimal(value: string): Decimal { return new Exact(DecimalSchema.parse(value)); }
const observed = <T>(field: ObservedField<T>): T | null => field.state === 'OBSERVED' ? field.value : null;

/** Does not infer that a claim is unpaid: authoritative ledger reconciliation belongs to L2. */
export function normalize(invoiceInput: InvoicePayload, rates: readonly FxRateSnapshot[] = DEMO_RATES): FinancialNormalization {
  const invoice = InvoicePayloadSchema.parse(invoiceInput);
  const f = invoice.financials;
  const currency = observed(f.currency);
  if (!currency) throw new L1Error('CURRENCY_NOT_OBSERVED', 'NORMALIZE');
  for (const field of Object.values(f)) {
    if (field.state === 'AMBIGUOUS' || field.state === 'CONFLICTING') throw new L1Error('FINANCIAL_CONFLICT', 'NORMALIZE');
    if (field.state === 'OBSERVED' && typeof field.value === 'object' && field.value.currency !== currency)
      throw new L1Error('CURRENCY_MISMATCH', 'NORMALIZE');
  }
  const total = observed(f.totalDue), paid = observed(f.amountAlreadyPaid), outstanding = observed(f.outstandingBalance);
  if (!total) throw new L1Error('TOTAL_NOT_OBSERVED', 'NORMALIZE');
  if (paid && decimal(paid.amount).gt(total.amount)) throw new L1Error('PAID_EXCEEDS_TOTAL', 'NORMALIZE');
  if (outstanding && decimal(outstanding.amount).gt(total.amount)) throw new L1Error('BALANCE_EXCEEDS_TOTAL', 'NORMALIZE');
  if (paid && outstanding && !decimal(total.amount).minus(paid.amount).eq(outstanding.amount)) throw new L1Error('BALANCE_CONTRADICTION', 'NORMALIZE');
  if (paid && decimal(paid.amount).gt(0) && !outstanding) throw new L1Error('PARTIAL_PAYMENT_BALANCE_MISSING', 'NORMALIZE');
  const subtotal = observed(f.subtotal), taxes = observed(f.taxes), discounts = observed(f.discounts);
  if (subtotal && taxes && discounts && !decimal(subtotal.amount).plus(taxes.amount).minus(discounts.amount).eq(total.amount))
    throw new L1Error('TOTAL_CONTRADICTION', 'NORMALIZE');
  if (invoice.commercial.lineItemsCompleteness === 'COMPLETE') {
    let sum = new Exact(0);
    for (const item of invoice.commercial.lineItems) {
      const line = observed(item.lineTotal), quantity = observed(item.quantity), price = observed(item.unitPrice);
      if (!line || !quantity || !price) throw new L1Error('LINE_ITEM_INCOMPLETE', 'NORMALIZE');
      if (line.currency !== currency || price.currency !== currency || !decimal(quantity).times(price.amount).eq(line.amount))
        throw new L1Error('LINE_ITEM_CONTRADICTION', 'NORMALIZE');
      sum = sum.plus(line.amount);
    }
    if (!subtotal || invoice.commercial.lineItems.length === 0 || !sum.eq(subtotal.amount)) throw new L1Error('LINE_SUBTOTAL_CONTRADICTION', 'NORMALIZE');
  }
  const candidate: Money = outstanding ?? total;
  if (decimal(candidate.amount).lte(0)) throw new L1Error('NONPOSITIVE_PAYABLE', 'NORMALIZE');
  const basis = outstanding ? 'OUTSTANDING_BALANCE' : 'TOTAL_DUE';
  const inputPaths = [outstanding ? 'financials.outstandingBalance' : 'financials.totalDue', 'financials.currency'];
  let fx: FxRateSnapshot | null = null;
  let exactUsd = decimal(candidate.amount);
  if (currency !== 'USD') {
    const matches = rates.filter(rate => rate.quoteCurrency === currency);
    if (matches.length !== 1) throw new L1Error('FX_RATE_UNAVAILABLE', 'NORMALIZE');
    fx = structuredClone(matches[0]!);
    if (fx.baseCurrency !== 'USD' || fx.source !== 'HACKATHON_FIXED' || fx.rounding !== 'HALF_EVEN' || fx.outputScale !== 2 || decimal(fx.quotePerBase).lte(0))
      throw new L1Error('INVALID_FX_RATE', 'NORMALIZE');
    exactUsd = exactUsd.div(fx.quotePerBase);
  }
  return { candidatePayable: candidate, basis, usdEquivalent: { amount: exactUsd.toFixed(2), currency: 'USD' }, fx,
    method: currency === 'USD' ? 'USD_IDENTITY' : 'DIVIDE_BY_USD_QUOTE_RATE', inputPaths, calculationVersion: NORMALIZATION_VERSION,
    calculationTrace: [`source=${candidate.amount} ${currency}`, `quotePerBase=${fx?.quotePerBase ?? '1'}`,
      `exactUsd=${exactUsd.toFixed()}`, 'rounding=HALF_EVEN;outputScale=2', `usd=${exactUsd.toFixed(2)}`] };
}
