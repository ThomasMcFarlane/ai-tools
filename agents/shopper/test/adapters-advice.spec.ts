import { describe, expect, it } from 'vitest';
import { advice, adviceStock } from '../src/core/adapters/advice.js';
import { fixtureCtx, loadFixture } from './helpers/fixture.js';

const ctx = fixtureCtx(advice);
const SEARCH_URL = 'https://www.advice.co.th/product/search?keyword=ddr5+32gb';

function search(name: string) {
  return loadFixture('advice', name, { url: SEARCH_URL, mode: 'headless' });
}

describe('advice adapter', () => {
  it('uses the headless browser and a script that loads every result', () => {
    expect(advice.defaultMode).toBe('headless');
    expect(advice.searchScript).toContain('showproduct-more');
  });

  it('builds search URLs', () => {
    expect(advice.searchUrl('ddr5 32gb', {})).toBe(SEARCH_URL);
    expect(advice.searchUrl('ddr5 32gb', { page: 2 })).toBe(`${SEARCH_URL}&page=2`);
  });

  it('parses a result page', () => {
    const hits = advice.parseSearch(search('search'), ctx);
    expect(hits).toHaveLength(21);
    expect(hits[0]).toEqual({
      site: 'advice',
      title: 'RAM DDR5(6000) 32GB (16GBX2) KLEVV CRAS BLACK RGB (KD5AGUA80-60B280G)',
      url: 'https://www.advice.co.th/product/ram-for-pc/pc-ddr5-6000-/ram-ddr5-6000-32gb-16gbx2-klevv-cras-black-rgb-kd5agua80-60b280g-',
      price: { amount: 22560, currency: 'THB' },
      condition: 'new',
      stock: 'in_stock',
      shop: 'Advice IT',
      seenAt: '2026-11-21T00:00:00.000Z',
      raw: {
        normalPrice: 22790,
        stockText: 'ซื้อเลย',
        shippingText: 'จัดส่งด่วน 3 - 5 ชม. ฟรี',
      },
    });
  });

  it('gives every hit a price, an absolute URL and the shop name', () => {
    for (const name of ['search', 'search-reserve', 'search-byorder']) {
      const hits = advice.parseSearch(search(name), ctx);
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(hit.price?.amount).toBeGreaterThan(0);
        expect(hit.price?.currency).toBe('THB');
        expect(hit.url).toMatch(/^https:\/\/www\.advice\.co\.th\/(?:product|order)\//);
        expect(hit.shop).toBe('Advice IT');
        expect(hit.condition).toBe('new');
      }
      expect(new Set(hits.map((hit) => hit.url)).size).toBe(hits.length);
    }
  });

  it('uses the sale price and keeps the normal price in raw', () => {
    const hits = advice.parseSearch(search('search'), ctx);
    for (const hit of hits) {
      expect(hit.raw?.normalPrice).toBeGreaterThan(hit.price?.amount ?? 0);
    }
    const adata = hits.find((hit) => hit.title.includes('ADATA'));
    expect(adata?.price?.amount).toBe(15740);
    expect(adata?.raw?.normalPrice).toBe(15900);
  });

  it('maps button labels to stock', () => {
    const reserve = advice.parseSearch(search('search-reserve'), ctx);
    expect(reserve.map((hit) => hit.stock)).toEqual([
      'in_stock',
      'in_stock',
      'preorder',
      'in_stock',
      'in_stock',
    ]);
    const branch = reserve.find(
      (hit) => hit.raw?.stockText === 'ซื้อเลยจัดส่งจากสาขามากกว่า 2 วัน',
    );
    expect(branch?.stock).toBe('in_stock');
    const byOrder = advice.parseSearch(search('search-byorder'), ctx);
    expect(byOrder).toHaveLength(1);
    expect(byOrder[0]?.stock).toBe('preorder');
    expect(byOrder[0]?.price?.amount).toBe(579000);
    expect(adviceStock('สินค้าหมด')).toBe('out_of_stock');
    expect(adviceStock('สำรองสิทธิ์')).toBe('preorder');
    expect(adviceStock('By Order')).toBe('preorder');
    expect(adviceStock('ซื้อเลย')).toBe('in_stock');
    expect(adviceStock('')).toBe('unknown');
  });

  it('returns no hits for a page without result cards', () => {
    const empty = {
      ...search('search'),
      html: '<html><body><div class="product-list"></div></body></html>',
    };
    expect(advice.parseSearch(empty, ctx)).toEqual([]);
  });

  it('parses a product page', () => {
    const snap = loadFixture('advice', 'listing', {
      url: 'https://www.advice.co.th/product/ram-for-pc/pc-ddr5-6000-/ram-ddr5-6000-32gb-16gbx2-klevv-cras-black-rgb-kd5agua80-60b280g-',
      mode: 'headless',
    });
    const listing = advice.parseListing(snap, ctx);
    expect(listing).toMatchObject({
      site: 'advice',
      title: 'RAM DDR5(6000) 32GB (16GBX2) KLEVV CRAS BLACK RGB (KD5AGUA80-60B280G)',
      price: { amount: 22560, currency: 'THB' },
      condition: 'new',
      stock: 'in_stock',
      shop: 'Advice IT',
      variants: [],
      raw: { sku: 'A0183963', brand: 'KLEVV' },
    });
    expect(listing.url).toBe(snap.url);
  });

  it('falls back to page selectors when structured data is missing', () => {
    const snap = loadFixture('advice', 'listing', {
      url: 'https://www.advice.co.th/product/x',
      mode: 'headless',
    });
    const stripped = { ...snap, html: snap.html.replace(/application\/ld\+json/g, 'text/plain') };
    const listing = advice.parseListing(stripped, ctx);
    expect(listing.price).toEqual({ amount: 22560, currency: 'THB' });
    expect(listing.shop).toBe('Advice IT');
  });

  it('detects no block on normal pages and flags a challenge page', () => {
    expect(advice.detectBlock(search('search'))).toBeNull();
    expect(advice.detectBlock(search('search-reserve'))).toBeNull();
    expect(advice.detectBlock(search('search-byorder'))).toBeNull();
    expect(advice.detectBlock(loadFixture('advice', 'listing'))).toBeNull();
    const challenge = {
      ...search('search'),
      html: '<html><head><title>Just a moment...</title></head><body></body></html>',
    };
    expect(advice.detectBlock(challenge)).toBe('access denied');
    const captcha = { ...challenge, html: '<html><body>Please complete the captcha</body></html>' };
    expect(advice.detectBlock(captcha)).toBe('captcha page');
  });

  it('matches its own URLs only', () => {
    expect(advice.matchesUrl('https://www.advice.co.th/product/x')).toBe(true);
    expect(advice.matchesUrl('https://www.jib.co.th/web/product/readProduct/1')).toBe(false);
  });
});
