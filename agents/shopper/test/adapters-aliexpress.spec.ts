import { describe, expect, it } from 'vitest';
import { aliexpress } from '../src/core/adapters/aliexpress.js';
import type { PageSnapshot } from '../src/core/types.js';
import { fixtureCtx, loadFixture } from './helpers/fixture.js';

const SEARCH_URL = 'https://th.aliexpress.com/w/wholesale-ddr5-ram-32gb.html';
const PUNISH_URL =
  'https://th.aliexpress.com//item/1005008405079309.html/_____tmd_____/punish?x5secdata=REDACTED';
const ctx = fixtureCtx(aliexpress);

function search() {
  return aliexpress.parseSearch(loadFixture('aliexpress', 'search', { url: SEARCH_URL }), ctx);
}

function listingSnapshot(html: string, data: unknown): PageSnapshot {
  return {
    url: 'https://th.aliexpress.com/item/1005008405079309.html?pdp_npi=x&algo_pvid=y',
    html,
    data,
    fetchedAt: '2026-11-21T00:00:00.000Z',
    mode: 'headless',
  };
}

describe('aliexpress adapter', () => {
  it('builds search URLs and the THB cookie', () => {
    expect(aliexpress.searchUrl('ddr5 ram 32gb', {})).toBe(
      'https://www.aliexpress.com/wholesale?SearchText=ddr5+ram+32gb',
    );
    expect(aliexpress.cookies?.({ currency: 'THB' })).toEqual([
      {
        name: 'aep_usuc_f',
        value: 'site=glo&c_tp=THB&region=TH&b_locale=en_US',
        domain: '.aliexpress.com',
      },
    ]);
    expect(aliexpress.cookies?.({ currency: 'USD' })).toEqual([]);
  });

  it('matches regional hosts', () => {
    expect(aliexpress.matchesUrl('https://th.aliexpress.com/item/1005008405079309.html')).toBe(
      true,
    );
    expect(aliexpress.matchesUrl('https://www.aliexpress.us/item/1.html')).toBe(false);
  });

  it('parses every result card of a real search page', () => {
    const hits = search();
    expect(hits).toHaveLength(60);
    for (const hit of hits) {
      expect(hit.site).toBe('aliexpress');
      expect(hit.title).not.toBe('');
      expect(hit.price?.currency).toBe('THB');
      expect(hit.price?.amount).toBeGreaterThan(0);
      expect(hit.url).toMatch(/^https:\/\/www\.aliexpress\.com\/item\/\d+\.html$/);
    }
    expect(new Set(hits.map((hit) => hit.url)).size).toBe(hits.length);
  });

  it('reads exact values of the first and sixth hit', () => {
    const hits = search();
    expect(hits[0]).toMatchObject({
      title: 'JUHOR Memory DDR5 32GB(16GBX2) 6000MHz 6400MHz DDR5 Desktop Computer Memoria Ram',
      url: 'https://www.aliexpress.com/item/1005009234880101.html',
      price: { amount: 16005.65, currency: 'THB' },
      condition: 'new',
      sold: 669,
      rating: 4.9,
      shipping: { amount: 0, currency: 'THB' },
    });
    expect(hits[5]).toMatchObject({
      url: 'https://www.aliexpress.com/item/1005012940802245.html',
      price: { amount: 11325.26, currency: 'THB' },
    });
    expect(hits[5]?.title.startsWith('Kingston FURY Beast DDR5 RAM 16GB 32GB 6000MHz')).toBe(true);
  });

  it('reads sold counts, ratings and conditions', () => {
    const hits = search();
    expect(hits.filter((hit) => typeof hit.sold === 'number').length).toBeGreaterThan(30);
    expect(hits.filter((hit) => typeof hit.rating === 'number').length).toBeGreaterThan(20);
    expect(hits.some((hit) => hit.condition === 'used')).toBe(true);
    expect(hits.some((hit) => hit.title.startsWith('AMD Ryzen 5 7600X Used'))).toBe(true);
  });

  it('detects the real punish page and passes normal pages', () => {
    const block = loadFixture('aliexpress', 'block', { url: PUNISH_URL });
    expect(aliexpress.detectBlock(block)).toBe('captcha (punish page)');
    expect(aliexpress.detectBlock({ ...block, url: 'https://th.aliexpress.com/item/1.html' })).toBe(
      'captcha (punish page)',
    );
    expect(aliexpress.parseSearch(block, ctx)).toEqual([]);
    expect(
      aliexpress.detectBlock(loadFixture('aliexpress', 'search', { url: SEARCH_URL })),
    ).toBeNull();
  });

  it('builds variants from clicked SKU data on a hand-written page', () => {
    const html =
      '<html><body><h1>Kingston FURY Beast DDR5 8GB 16GB 32GB</h1>' +
      '<div class="price-default--current--abc">฿3,200.00</div></body></html>';
    const listing = aliexpress.parseListing(
      listingSnapshot(html, {
        base: '฿3,200.00',
        skus: [
          { options: { Capacity: '16GB', Speed: '5600MHz' }, price: '฿3,200.00', soldOut: false },
          { options: { Capacity: '16GB', Speed: '6000MHz' }, price: '฿3,450.50', soldOut: false },
          { options: { Capacity: '32GB', Speed: '5600MHz' }, price: '', soldOut: true },
        ],
      }),
      ctx,
    );
    expect(listing.url).toBe('https://www.aliexpress.com/item/1005008405079309.html');
    expect(listing.title).toBe('Kingston FURY Beast DDR5 8GB 16GB 32GB');
    expect(listing.price).toEqual({ amount: 3200, currency: 'THB' });
    expect(listing.priceMax).toEqual({ amount: 3450.5, currency: 'THB' });
    expect(listing.stock).toBe('in_stock');
    expect(listing.variants).toEqual([
      {
        name: '16GB / 5600MHz',
        options: { Capacity: '16GB', Speed: '5600MHz' },
        price: { amount: 3200, currency: 'THB' },
        stock: 'in_stock',
      },
      {
        name: '16GB / 6000MHz',
        options: { Capacity: '16GB', Speed: '6000MHz' },
        price: { amount: 3450.5, currency: 'THB' },
        stock: 'in_stock',
      },
      {
        name: '32GB / 5600MHz',
        options: { Capacity: '32GB', Speed: '5600MHz' },
        price: null,
        stock: 'out_of_stock',
      },
    ]);
  });

  it('reports out of stock when every option is sold out', () => {
    const listing = aliexpress.parseListing(
      listingSnapshot('<html><body><h1>Item</h1></body></html>', {
        skus: [{ options: { Colour: 'Black' }, price: '', soldOut: true }],
      }),
      ctx,
    );
    expect(listing.stock).toBe('out_of_stock');
    expect(listing.price).toBeNull();
  });
});
