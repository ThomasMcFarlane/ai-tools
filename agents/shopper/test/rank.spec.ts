import { describe, expect, it } from 'vitest';
import { shopperDefaultsSchema, builtinDefaults } from '../src/core/defaults.js';
import {
  allowedConditions,
  effectivePrice,
  filterHits,
  rankHits,
  resolveConditions,
} from '../src/core/rank.js';
import { hit } from './helpers/hits.js';

const defaults = shopperDefaultsSchema.parse({
  ...builtinDefaults(['a']),
  condition: {
    default: ['new'],
    rules: [{ match: 'used|second hand', allow: ['used', 'refurbished'] }],
  },
});

const base = {
  allowed: ['new' as const],
  maxPrice: null,
  includeOos: false,
  includeShipping: true,
  currency: 'THB',
};

describe('allowedConditions', () => {
  it('uses the first matching rule, else the default', () => {
    expect(allowedConditions('Used laptop', defaults)).toEqual(['used', 'refurbished']);
    expect(allowedConditions('laptop', defaults)).toEqual(['new']);
  });

  it('lets an override win', () => {
    expect(allowedConditions('Used laptop', defaults, ['new', 'used'])).toEqual(['new', 'used']);
  });
});

describe('resolveConditions', () => {
  const ask = shopperDefaultsSchema.parse({
    ...builtinDefaults(['a']),
    condition: { default: ['new'], rules: [{ match: 'used', allow: ['used'] }], unmatched: 'ask' },
  });

  it('keeps every condition and flags the choice when no rule matches', () => {
    expect(resolveConditions('laptop', ask)).toEqual({
      allowed: ['new', 'used', 'refurbished', 'unknown'],
      unresolved: true,
    });
  });

  it('does not ask when a rule matches or the caller chose', () => {
    expect(resolveConditions('used laptop', ask)).toEqual({ allowed: ['used'], unresolved: false });
    expect(resolveConditions('laptop', ask, ['new'])).toEqual({
      allowed: ['new'],
      unresolved: false,
    });
  });

  it('uses the default when unmatched is use-default', () => {
    expect(resolveConditions('laptop', defaults)).toEqual({ allowed: ['new'], unresolved: false });
  });
});

describe('filterHits', () => {
  it('drops disallowed conditions, null prices and out-of-stock offers', () => {
    const out = filterHits(
      [
        hit({ title: 'ok' }),
        hit({ title: 'used', condition: 'used' }),
        hit({ title: 'noprice', price: null }),
        hit({ title: 'oos', stock: 'out_of_stock' }),
        hit({ title: 'unknown', condition: 'unknown' }),
      ],
      base,
    );
    expect(out.map((h) => h.title)).toEqual(['ok', 'unknown']);
  });

  it('keeps out-of-stock offers on request', () => {
    expect(
      filterHits([hit({ stock: 'out_of_stock' })], { ...base, includeOos: true }),
    ).toHaveLength(1);
  });

  it('applies the budget including shipping', () => {
    const offer = hit({
      price: { amount: 90, currency: 'THB' },
      shipping: { amount: 20, currency: 'THB' },
    });
    expect(filterHits([offer], { ...base, maxPrice: 100 })).toHaveLength(0);
    expect(filterHits([offer], { ...base, maxPrice: 100, includeShipping: false })).toHaveLength(1);
  });

  it('does not compare a budget across currencies', () => {
    const offer = hit({ price: { amount: 500, currency: 'USD' } });
    expect(filterHits([offer], { ...base, maxPrice: 100 })).toHaveLength(1);
  });
});

describe('rankHits', () => {
  const cheap = hit({
    title: 'cheap',
    price: { amount: 50, currency: 'THB' },
    rating: 3,
    stock: 'low_stock',
  });
  const good = hit({ title: 'good', price: { amount: 80, currency: 'THB' }, rating: 4.8 });
  const pricey = hit({ title: 'pricey', price: { amount: 200, currency: 'THB' }, rating: 4.9 });

  it('ranks cheapest by price', () => {
    expect(rankHits([pricey, good, cheap], 'cheapest', true).map((h) => h.title)).toEqual([
      'cheap',
      'good',
      'pricey',
    ]);
  });

  it('puts in-stock, well-rated offers first for value', () => {
    expect(rankHits([cheap, pricey, good], 'value', true).map((h) => h.title)).toEqual([
      'good',
      'pricey',
      'cheap',
    ]);
  });

  it('ranks premium by rating then price', () => {
    expect(rankHits([cheap, good, pricey], 'premium', true).map((h) => h.title)).toEqual([
      'pricey',
      'good',
      'cheap',
    ]);
  });

  it('adds known shipping to the effective price', () => {
    const offer = hit({
      price: { amount: 10, currency: 'THB' },
      shipping: { amount: 5, currency: 'THB' },
    });
    expect(effectivePrice(offer, true)).toBe(15);
    expect(effectivePrice(offer, false)).toBe(10);
  });

  it('lets an earlier site in the preferred order win an equal price', () => {
    const a = hit({ title: 'same', site: 'a' });
    const b = hit({ title: 'same', site: 'b' });
    expect(rankHits([a, b], 'cheapest', true, ['b', 'a']).map((h) => h.site)).toEqual(['b', 'a']);
    expect(rankHits([a, b], 'cheapest', true, []).map((h) => h.site)).toEqual(['a', 'b']);
    expect(rankHits([a, b], 'cheapest', true, ['b']).map((h) => h.site)).toEqual(['b', 'a']);
  });

  it('breaks ties deterministically', () => {
    const a = hit({ title: 'b', site: 'z' });
    const b = hit({ title: 'a', site: 'a' });
    expect(rankHits([a, b], 'cheapest', true).map((h) => h.site)).toEqual(['a', 'z']);
  });
});
