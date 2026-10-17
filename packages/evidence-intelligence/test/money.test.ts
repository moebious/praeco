import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { emptyInvoice } from '../src/extraction.js';
import { normalize, DEMO_RATES } from '../src/money.js';
import type { InvoicePayload, ObservedField } from '../src/contracts.js';
const value = <T>(v: T): ObservedField<T> => ({ state: 'OBSERVED', value: v, evidenceIds: ['arithmetic-test'] });
function invoice(amount: string, currency = 'USD'): InvoicePayload {
  const result = emptyInvoice(); result.financials.currency = value(currency); result.financials.totalDue = value({ amount, currency }); return result;
}
describe('exact decimal normalization', () => {
  it.each([
    ['2500', 'USD', '2500.00'], ['8000000', 'COP', '2000.00'], ['76000', 'MXN', '3800.00'], ['2400000', 'COP', '600.00'],
    ['1.005', 'USD', '1.00'], ['1.015', 'USD', '1.02'], ['50000.01', 'MXN', '2500.00'],
  ])('normalizes %s %s to %s with HALF_EVEN', (amount, currency, expected) => {
    expect(normalize(invoice(amount!, currency)).usdEquivalent?.amount).toBe(expected);
  });
  it('preserves original amount and rate snapshot without authorizing', () => {
    const result = normalize(invoice('76000', 'MXN'));
    expect(result.candidatePayable).toEqual({ amount: '76000', currency: 'MXN' });
    expect(result.fx?.quotePerBase).toBe('20'); expect(result.method).toBe('DIVIDE_BY_USD_QUOTE_RATE');
  });
  it('uses a consistent outstanding balance and refuses contradictions', () => {
    const input = invoice('100'); input.financials.amountAlreadyPaid = value({ amount: '30', currency: 'USD' });
    expect(() => normalize(input)).toThrow('PARTIAL_PAYMENT_BALANCE_MISSING');
    input.financials.outstandingBalance = value({ amount: '70', currency: 'USD' });
    expect(normalize(input).candidatePayable?.amount).toBe('70');
    input.financials.outstandingBalance = value({ amount: '80', currency: 'USD' });
    expect(() => normalize(input)).toThrow('BALANCE_CONTRADICTION');
  });
  it.each(['-1', '1e10', 'NaN', 'Infinity', '9999999999999999999999999', '1.0000001', '1,000'])('rejects invalid/unsupported decimal %s', amount => {
    expect(() => normalize(invoice(amount))).toThrow();
  });
  it('rejects absent/duplicate/invalid rates and mismatched money currencies', () => {
    expect(() => normalize(invoice('100', 'EUR'))).toThrow('FX_RATE_UNAVAILABLE');
    expect(() => normalize(invoice('100', 'COP'), [])).toThrow('FX_RATE_UNAVAILABLE');
    expect(() => normalize(invoice('100', 'COP'), [...DEMO_RATES, DEMO_RATES[0]!])).toThrow('FX_RATE_UNAVAILABLE');
    expect(() => normalize(invoice('100', 'COP'), [{ ...DEMO_RATES[0]!, quotePerBase: '0' }])).toThrow('INVALID_FX_RATE');
    const mixed = invoice('100', 'USD'); mixed.financials.taxes = value({ amount: '1', currency: 'COP' });
    expect(() => normalize(mixed)).toThrow('CURRENCY_MISMATCH');
  });
  it('preserves identity over integer cents and exact multiples of the pinned rates', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100_000_000 }), cents => {
      const amount = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
      expect(normalize(invoice(amount)).usdEquivalent?.amount).toBe(amount);
      const whole = String(cents);
      expect(normalize(invoice(String(cents * 4000), 'COP')).usdEquivalent?.amount).toBe(`${whole}.00`);
      expect(normalize(invoice(String(cents * 20), 'MXN')).usdEquivalent?.amount).toBe(`${whole}.00`);
    }), { numRuns: 150, seed: 3017 });
  });
});
