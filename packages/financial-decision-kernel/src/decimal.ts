import { Decimal } from 'decimal.js';

export const ExactDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_EVEN,
});

export const PINNED_FX_RATES: Readonly<Record<string, string>> = Object.freeze({
  USD: '1',
  COP: '4000',
  MXN: '20',
});

export function decimal(val: string | number | Decimal): Decimal {
  return new ExactDecimal(val);
}

/**
 * Deterministically computes unrounded USD equivalent using exact arithmetic.
 * For currency C != USD: unroundedUsd = amount / quotePerBase.
 */
export function toUsdExact(amountStr: string, currency: string): Decimal {
  const quotePerBase = PINNED_FX_RATES[currency];
  if (!quotePerBase) {
    throw new Error(`UNSUPPORTED_CURRENCY_FOR_FX: ${currency}`);
  }
  const amt = decimal(amountStr);
  if (currency === 'USD') {
    return amt;
  }
  return amt.div(quotePerBase);
}

/**
 * Returns formatted USD string rounded HALF_EVEN to 2 decimal places.
 */
export function formatUsd(d: Decimal): string {
  return d.toFixed(2);
}
