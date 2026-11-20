import { describe, expect, it } from 'vitest';
import { canonicalJibUrl, jib, jibStock } from '../src/core/adapters/jib.js';
import { fixtureCtx, loadFixture } from './helpers/fixture.js';

const ctx = fixtureCtx(jib);
const SEARCH_URL =
  'https://www.jib.co.th/web/product/product_search/0?str_search=ram%20ddr5%2032gb';

function search(name: string) {
  return loadFixture('jib', name, { url: SEARCH_URL, mode: 'http' });
}

describe('jib adapter', () => {
  it('fetches over plain HTTP', () => {
    expect(jib.defaultMode).toBe('http');
  });

  it('builds search URLs with a 100 item offset per page', () => {
    expect(jib.searchUrl('ddr5 32gb', {})).toBe(
      'https://www.jib.co.th/web/product/product_search/0?str_search=ddr5%2032gb',
    );
    expect(jib.searchUrl('ddr5 32gb', { page: 2 })).toBe(
      'https://www.jib.co.th/web/product/product_search/100?str_search=ddr5%2032gb',
    );
    expect(jib.searchUrl('ddr5 32gb', { page: 3 })).toContain('/product_search/200?');
  });

  it('parses a result page', () => {
    const hits = jib.parseSearch(search('search'), ctx);
    expect(hits).toHaveLength(24);
    expect(hits[0]).toEqual({
      site: 'jib',
      title:
        '32GB (16GBx2) DDR5 5200MHz RAM (หน่วยความจำ) KINGSTON FURY BEAST DDR5 (BLACK) (KF552C40BBK2-32)',
      url: 'https://www.jib.co.th/web/product/readProduct/50216',
      price: { amount: 17900, currency: 'THB' },
      condition: 'new',
      stock: 'out_of_stock',
      shop: 'JIB',
      sold: 925,
      seenAt: '2026-11-21T00:00:00.000Z',
      raw: { stockText: 'สินค้าหมดชั่วคราว' },
    });
  });

  it('gives every hit a price, a canonical absolute URL and the shop name', () => {
    for (const name of ['search', 'search-sets']) {
      const hits = jib.parseSearch(search(name), ctx);
      expect(hits.length).toBeGreaterThan(5);
      for (const hit of hits) {
        expect(hit.price?.amount).toBeGreaterThan(0);
        expect(hit.price?.currency).toBe('THB');
        expect(hit.url).toMatch(/^https:\/\/www\.jib\.co\.th\/web\/product\/readProduct\/\d+$/);
        expect(hit.shop).toBe('JIB');
        expect(hit.condition).toBe('new');
      }
      expect(new Set(hits.map((hit) => hit.url)).size).toBe(hits.length);
    }
  });

  it('maps the buy button to stock', () => {
    const hits = jib.parseSearch(search('search'), ctx);
    expect(hits.filter((hit) => hit.stock === 'in_stock')).toHaveLength(8);
    expect(hits.filter((hit) => hit.stock === 'out_of_stock')).toHaveLength(16);
    expect(hits[4]?.stock).toBe('in_stock');
    expect(hits[4]?.raw?.stockText).toBe('ซื้อเลย');
    expect(jibStock('สินค้าหมดชั่วคราว')).toBe('out_of_stock');
    expect(jibStock('ซื้อเลย')).toBe('in_stock');
    expect(jibStock('พรีออเดอร์')).toBe('preorder');
    expect(jibStock('')).toBe('unknown');
  });

  it('uses the price paid now and keeps the normal price in raw', () => {
    const hits = jib.parseSearch(search('search-sets'), ctx);
    expect(hits).toHaveLength(6);
    const sale = hits.find((hit) => hit.url.endsWith('/88676'));
    expect(sale?.price?.amount).toBe(71900);
    expect(sale?.raw?.normalPrice).toBe(77510);
    expect(sale?.stock).toBe('in_stock');
    const plain = hits.find((hit) => hit.url.endsWith('/75678'));
    expect(plain?.price?.amount).toBe(46410);
    expect(plain?.raw?.normalPrice).toBeUndefined();
    expect(plain?.stock).toBe('out_of_stock');
  });

  it('shortens product URLs to the product id', () => {
    const long =
      'https://www.jib.co.th/web/product/readProduct/53758/2364/32GB--16GBx2--DDR5-5200MHz-RAM';
    expect(canonicalJibUrl(long, SEARCH_URL)).toBe(
      'https://www.jib.co.th/web/product/readProduct/53758',
    );
    expect(canonicalJibUrl('/web/product/readProduct/53758/2364/x', SEARCH_URL)).toBe(
      'https://www.jib.co.th/web/product/readProduct/53758',
    );
    expect(canonicalJibUrl('https://www.jib.co.th/web/other', SEARCH_URL)).toBe(
      'https://www.jib.co.th/web/other',
    );
    expect(canonicalJibUrl('', SEARCH_URL)).toBeNull();
  });

  it('applies a selector override from a learning', () => {
    const overridden = fixtureCtx(jib, { 'search.card': '.nothing' });
    expect(jib.parseSearch(search('search'), overridden)).toEqual([]);
  });

  it('parses an in-stock product page', () => {
    const snap = loadFixture('jib', 'listing', {
      url: 'https://www.jib.co.th/web/product/readProduct/53758',
      mode: 'http',
    });
    const listing = jib.parseListing(snap, ctx);
    expect(listing).toMatchObject({
      site: 'jib',
      title:
        '32GB (16GBx2) DDR5 5200MHz RAM (หน่วยความจำ) KINGSTON FURY BEAST DDR5 RGB (BLACK) (KF552C40BBAK2-32)',
      url: 'https://www.jib.co.th/web/product/readProduct/53758',
      price: { amount: 17400, currency: 'THB' },
      condition: 'new',
      stock: 'in_stock',
      shop: 'JIB',
      variants: [],
      raw: { sku: '0320550770', brand: 'Kingston' },
    });
    expect(listing.description).toContain('KF552C40BBAK2-32');
  });

  it('parses an out-of-stock product page', () => {
    const snap = loadFixture('jib', 'listing-out', {
      url: 'https://www.jib.co.th/web/product/readProduct/50216',
      mode: 'http',
    });
    const listing = jib.parseListing(snap, ctx);
    expect(listing.price).toEqual({ amount: 17900, currency: 'THB' });
    expect(listing.stock).toBe('out_of_stock');
  });

  it('falls back to page selectors when structured data is missing', () => {
    const snap = loadFixture('jib', 'listing-out', {
      url: 'https://www.jib.co.th/web/product/readProduct/50216',
      mode: 'http',
    });
    const stripped = { ...snap, html: snap.html.replace(/application\/ld\+json/g, 'text/plain') };
    const listing = jib.parseListing(stripped, ctx);
    expect(listing.price).toEqual({ amount: 17900, currency: 'THB' });
    expect(listing.stock).toBe('out_of_stock');
    expect(listing.shop).toBe('JIB');
  });

  it('detects no block on normal pages and flags a challenge page', () => {
    expect(jib.detectBlock(search('search'))).toBeNull();
    expect(jib.detectBlock(search('search-sets'))).toBeNull();
    expect(jib.detectBlock(loadFixture('jib', 'listing', { mode: 'http' }))).toBeNull();
    const challenge = {
      ...search('search'),
      html: '<html><head><title>Just a moment...</title></head><body></body></html>',
    };
    expect(jib.detectBlock(challenge)).toBe('access denied');
    const captcha = { ...challenge, html: '<html><body>Please complete the captcha</body></html>' };
    expect(jib.detectBlock(captcha)).toBe('captcha page');
  });

  it('matches its own URLs only', () => {
    expect(jib.matchesUrl('https://www.jib.co.th/web/product/readProduct/53758')).toBe(true);
    expect(jib.matchesUrl('https://www.advice.co.th/product/x')).toBe(false);
  });
});
