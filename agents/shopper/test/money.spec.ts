import { describe, expect, it } from 'vitest';
import { formatMoney, parsePrice } from '../src/core/money.js';

describe('parsePrice', () => {
  it.each([
    ['฿1,234', 1234, null, 'THB'],
    ['THB 1,234.00', 1234, null, 'THB'],
    ['1,234 บาท', 1234, null, 'THB'],
    ['฿100 - ฿200', 100, 200, 'THB'],
    ['US $12.34', 12.34, null, 'USD'],
    ['฿1,299 -20%', 1299, null, 'THB'],
    ['฿49', 49, null, 'THB'],
  ])('parses %s', (text, min, max, currency) => {
    const out = parsePrice(text, 'THB');
    expect(out?.min).toEqual({ amount: min, currency });
    expect(out?.max?.amount ?? null).toBe(max);
  });

  it('uses the fallback currency when none is shown', () => {
    expect(parsePrice('1,500', 'EUR')?.min).toEqual({ amount: 1500, currency: 'EUR' });
  });

  it('returns null without digits', () => {
    expect(parsePrice('call us', 'THB')).toBeNull();
  });
});

describe('formatMoney', () => {
  it('formats Baht and other currencies', () => {
    expect(formatMoney({ amount: 1234, currency: 'THB' })).toBe('฿1,234');
    expect(formatMoney({ amount: 12.5, currency: 'USD' })).toBe('$12.50');
    expect(formatMoney({ amount: 3, currency: 'EUR' })).toBe('EUR 3');
    expect(formatMoney(null)).toBe('-');
  });
});
