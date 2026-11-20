import { describe, expect, it } from 'vitest';
import { ihavecpu } from '../src/core/adapters/ihavecpu.js';
import { fixtureCtx, loadFixture } from './helpers/fixture.js';

const ctx = fixtureCtx(ihavecpu);
const SEARCH_URL = 'https://ihavecpu.com/product/search/ddr5%2032gb';
const FIRST_URL =
  'https://ihavecpu.com/product/14051/ram-(%E0%B9%81%E0%B8%A3%E0%B8%A1)-apacer-nox-32gb-(16x2)-ddr5-5200mhz-(ah5u32g52c522mbaa-2)-(lt)';

function search(name: string) {
  return loadFixture('ihavecpu', name, { url: SEARCH_URL, mode: 'http' });
}

describe('ihavecpu adapter', () => {
  it('builds search URLs', () => {
    expect(ihavecpu.searchUrl('ddr5 32gb', {})).toBe(SEARCH_URL);
    expect(ihavecpu.searchUrl('ddr5 32gb', { page: 2 })).toBe(`${SEARCH_URL}?page=2`);
    expect(ihavecpu.searchUrl('ddr5 32gb', { page: 1 })).toBe(SEARCH_URL);
  });

  it('parses a result page from the embedded page data', () => {
    const hits = ihavecpu.parseSearch(search('search'), ctx);
    expect(hits).toHaveLength(32);
    expect(hits[0]).toEqual({
      site: 'ihavecpu',
      title: 'RAM (แรม) APACER NOX 32GB (16x2) DDR5 5200MHz (AH5U32G52C522MBAA-2) (LT)',
      url: FIRST_URL,
      price: { amount: 16990, currency: 'THB' },
      condition: 'new',
      stock: 'in_stock',
      shop: 'iHAVECPU',
      seenAt: '2026-11-21T00:00:00.000Z',
      raw: { productId: 14051, brand: 'APACER' },
    });
  });

  it('gives every hit a price, an absolute product URL and the shop name', () => {
    const hits = ihavecpu.parseSearch(search('search'), ctx);
    for (const hit of hits) {
      expect(hit.price?.amount).toBeGreaterThan(0);
      expect(hit.price?.currency).toBe('THB');
      expect(hit.url).toMatch(/^https:\/\/ihavecpu\.com\/product\/\d+\/./);
      expect(hit.url).not.toContain('?');
      expect(hit.shop).toBe('iHAVECPU');
      expect(hit.condition).toBe('new');
    }
    expect(new Set(hits.map((hit) => hit.url)).size).toBe(hits.length);
  });

  it('records the price before a discount and uses the price paid now', () => {
    const hits = ihavecpu.parseSearch(search('search'), ctx);
    const discounted = hits.find((hit) => hit.raw?.priceBefore !== undefined);
    expect(discounted?.price?.amount).toBe(53990);
    expect(discounted?.raw?.priceBefore).toBe(60790);
  });

  it('maps stock counts to stock states', () => {
    const hits = ihavecpu.parseSearch(search('search-oos'), ctx);
    expect(hits).toHaveLength(5);
    expect(hits.map((hit) => hit.stock)).toEqual([
      'in_stock',
      'in_stock',
      'in_stock',
      'out_of_stock',
      'out_of_stock',
    ]);
    expect(hits[3]?.title).toContain('KINGSTON FURY BEAST RGB EXPO 64GB');
    expect(hits[3]?.price?.amount).toBe(40990);
  });

  it('returns no hits for an empty result page', () => {
    expect(ihavecpu.parseSearch(search('search-empty'), ctx)).toEqual([]);
  });

  it('falls back to the card markup when the page data block is missing', () => {
    const snap = search('search');
    const html = snap.html.replace(/<script id="__NEXT_DATA__".*?<\/script>/s, '');
    expect(html).not.toContain('__NEXT_DATA__');
    const hits = ihavecpu.parseSearch({ ...snap, html }, ctx);
    expect(hits).toHaveLength(32);
    expect(hits[0]).toMatchObject({
      title: 'RAM (แรม) APACER NOX 32GB (16x2) DDR5 5200MHz (AH5U32G52C522MBAA-2) (LT)',
      url: FIRST_URL,
      price: { amount: 16990, currency: 'THB' },
      stock: 'unknown',
      shop: 'iHAVECPU',
    });
  });

  it('returns no hits for a page without data or cards', () => {
    const snap = { ...search('search'), html: '<html><body>nothing</body></html>' };
    expect(ihavecpu.parseSearch(snap, ctx)).toEqual([]);
  });

  it('refuses a listing without the data block', () => {
    const snap = { ...search('search'), html: '<html><body>nothing</body></html>' };
    expect(() => ihavecpu.parseListing(snap, ctx)).toThrow(/listing data block/);
  });

  it('builds the product URL from the name when the link is missing', () => {
    const snap = search('search');
    const hits = ihavecpu.parseSearch(
      { ...snap, html: snap.html.replace(/href="\/product\//g, 'data-x="/product/') },
      ctx,
    );
    expect(hits[0]?.url).toBe(FIRST_URL);
  });

  it('parses a listing page', () => {
    const url =
      'https://ihavecpu.com/product/4812/ram-(แรม)-kingston-fury-beast-32gb-(16x2)-ddr5-5600mhz-black-(kf556c40bbk2-32)';
    const listing = ihavecpu.parseListing(
      loadFixture('ihavecpu', 'listing', { url: `${url}?utm=x`, mode: 'http' }),
      ctx,
    );
    expect(listing).toMatchObject({
      site: 'ihavecpu',
      title: 'RAM (แรม) KINGSTON FURY BEAST 32GB (16x2) DDR5 5600MHz BLACK (KF556C40BBK2-32)',
      price: { amount: 17990, currency: 'THB' },
      stock: 'in_stock',
      condition: 'new',
      shop: 'iHAVECPU',
      variants: [],
      raw: { brand: 'KINGSTON', sku: 'SKU-140054', stockCount: 298 },
    });
    expect(listing.url).toBe(new URL(url).toString());
    expect(listing.url).not.toContain('utm');
  });

  it('marks a listing with zero stock as out of stock', () => {
    const listing = ihavecpu.parseListing(
      loadFixture('ihavecpu', 'listing-oos', {
        url: 'https://ihavecpu.com/product/31040/x',
        mode: 'http',
      }),
      ctx,
    );
    expect(listing.stock).toBe('out_of_stock');
    expect(listing.price?.amount).toBe(40990);
    expect(listing.raw?.stockCount).toBe(0);
  });

  it('detects no block on real pages and flags a Cloudflare challenge', () => {
    for (const name of ['search', 'search-oos', 'search-empty', 'listing', 'listing-oos']) {
      expect(ihavecpu.detectBlock(loadFixture('ihavecpu', name, { url: SEARCH_URL }))).toBeNull();
    }
    const blocked = {
      ...search('search'),
      html: '<html><head><title>Just a moment...</title></head></html>',
    };
    expect(ihavecpu.detectBlock(blocked)).toBe('Cloudflare challenge page');
    const captcha = {
      ...search('search'),
      html: '<html><body>Please complete the captcha</body></html>',
    };
    expect(ihavecpu.detectBlock(captcha)).toBe('captcha page');
  });

  it('matches its own URLs only', () => {
    expect(ihavecpu.matchesUrl(FIRST_URL)).toBe(true);
    expect(ihavecpu.matchesUrl('https://www.ihavecpu.com/product/1/x')).toBe(true);
    expect(ihavecpu.matchesUrl('https://example.com/product/1/x')).toBe(false);
  });
});
