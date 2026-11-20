import { describe, expect, it } from 'vitest';
import {
  absoluteUrl,
  detectBlockWith,
  guessCondition,
  guessStock,
  hitsFromCards,
  hostMatches,
  normaliseText,
  parseSoldCount,
} from '../src/core/html.js';
import { loadFixture } from './helpers/fixture.js';

const ctx = {
  selectors: {
    'search.card': '.card',
    'search.link': 'a.t',
    'search.title': 'a.t',
    'search.price': '.pr',
    'search.stock': '.st',
  },
  now: '2026-11-21T00:00:00.000Z',
  currency: 'THB',
};

describe('html helpers', () => {
  it('normalises text and resolves URLs', () => {
    expect(normaliseText('  a \n b\t')).toBe('a b');
    expect(absoluteUrl('/x?y=1', 'https://example.com/a/')).toBe('https://example.com/x?y=1');
    expect(absoluteUrl('', 'https://example.com')).toBeNull();
    expect(hostMatches('https://www.example.com/x', ['example.com'])).toBe(true);
    expect(hostMatches('https://notexample.com/x', ['example.com'])).toBe(false);
  });

  it('guesses condition, stock and sold counts', () => {
    expect(guessCondition('Refurbished phone')).toBe('refurbished');
    expect(guessCondition('Used laptop')).toBe('used');
    expect(guessCondition('Plain item')).toBe('unknown');
    expect(guessStock('Sold out')).toBe('out_of_stock');
    expect(guessStock('In stock')).toBe('in_stock');
    expect(parseSoldCount('1.2k sold')).toBe(1200);
    expect(parseSoldCount('50 sold')).toBe(50);
  });

  it('builds hits from cards and removes duplicate links', () => {
    const snap = loadFixture('_helper', 'sample', { url: 'https://example.com/search' });
    const hits = hitsFromCards(snap, ctx, { site: 'demo', stockKey: 'search.stock' });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      site: 'demo',
      title: 'Widget One',
      url: 'https://example.com/p/1',
      price: { amount: 1234, currency: 'THB' },
      stock: 'in_stock',
      seenAt: ctx.now,
    });
    expect(hits[1]?.priceMax).toEqual({ amount: 200, currency: 'THB' });
    expect(hits[1]?.condition).toBe('used');
  });

  it('detects blocks by URL and by small block pages only', () => {
    const base = { fetchedAt: 'x', mode: 'http' as const };
    expect(
      detectBlockWith({ ...base, url: 'https://e.com/verify/x', html: '' }, [
        { test: /\/verify\//, reason: 'verify' },
      ]),
    ).toBe('verify');
    expect(
      detectBlockWith(
        { ...base, url: 'https://e.com', html: '<p>Please solve the CAPTCHA</p>' },
        [],
      ),
    ).toBe('captcha page');
    const big = `<p>captcha</p>${'x'.repeat(70_000)}`;
    expect(detectBlockWith({ ...base, url: 'https://e.com', html: big }, [])).toBeNull();
  });
});
