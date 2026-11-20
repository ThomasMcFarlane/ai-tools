import { describe, expect, it } from 'vitest';
import { lazadaTh } from '../src/core/adapters/lazada-th.js';
import type { PageSnapshot } from '../src/core/types.js';
import { fixtureCtx, loadFixture } from './helpers/fixture.js';

const SEARCH_URL =
  'https://www.lazada.co.th/tag/ddr5-32gb/?q=ddr5%2032gb&catalog_redirect_tag=true';
const ctx = fixtureCtx(lazadaTh);

function search() {
  return lazadaTh.parseSearch(loadFixture('lazada-th', 'search', { url: SEARCH_URL }), ctx);
}

describe('lazada-th adapter', () => {
  it('builds search URLs', () => {
    expect(lazadaTh.searchUrl('ddr5 32gb', {})).toBe(
      'https://www.lazada.co.th/catalog/?q=ddr5+32gb',
    );
    expect(lazadaTh.searchUrl('ram', { page: 2 })).toBe(
      'https://www.lazada.co.th/catalog/?q=ram&page=2',
    );
  });

  it('matches its own URLs only', () => {
    expect(lazadaTh.matchesUrl('https://www.lazada.co.th/products/pdp-i1.html')).toBe(true);
    expect(lazadaTh.matchesUrl('https://www.lazada.com.my/products/x.html')).toBe(false);
  });

  it('parses every card of a real search page', () => {
    const hits = search();
    expect(hits).toHaveLength(40);
    for (const hit of hits) {
      expect(hit.site).toBe('lazada-th');
      expect(hit.title).not.toBe('');
      expect(hit.price?.currency).toBe('THB');
      expect(hit.price?.amount).toBeGreaterThan(0);
      expect(hit.url).toMatch(/^https:\/\/www\.lazada\.co\.th\/products\/pdp-i\d+\.html$/);
    }
    expect(new Set(hits.map((hit) => hit.url)).size).toBe(hits.length);
  });

  it('reads exact values of the first and sixth hit', () => {
    const hits = search();
    expect(hits[0]).toMatchObject({
      title:
        'Glorimemo DDR5บูมหนึ่ง RGB 6000MHZ หน่วยความจำสำหรับเดสก์ท็อป32GB (16GB * 2) CL38 288-PIN DIMM',
      url: 'https://www.lazada.co.th/products/pdp-i5276717662.html',
      price: { amount: 4476.01, currency: 'THB' },
      condition: 'new',
      sold: 15,
      raw: { itemId: '5276717662' },
    });
    expect(hits[5]).toMatchObject({
      title:
        'RAM 32GB (16GBx2) DDR5 5600MHz CORSAIR VENGEANCE RGB (WHITE) (มือสอง ประกันตลอดอายุการใช้งาน)',
      url: 'https://www.lazada.co.th/products/pdp-i16212771674.html',
      price: { amount: 15890, currency: 'THB' },
      condition: 'used',
      raw: { location: 'นครราชสีมา' },
    });
  });

  it('reads sold counts and conditions', () => {
    const hits = search();
    expect(
      hits.filter((hit) => hit.sold !== undefined && hit.sold !== null).length,
    ).toBeGreaterThan(5);
    expect(hits.some((hit) => hit.condition === 'used')).toBe(true);
    expect(hits.filter((hit) => hit.condition === 'new').length).toBeGreaterThan(20);
  });

  it('parses a listing without options', () => {
    const snap = loadFixture('lazada-th', 'listing', {
      url: 'https://www.lazada.co.th/products/pdp-i6008787338.html?spm=a2o4m.pdp',
    });
    const listing = lazadaTh.parseListing(snap, ctx);
    expect(listing).toMatchObject({
      site: 'lazada-th',
      title: 'RAM DDR5(6000) 32GB (16GBX2) KINGSTON BEAST RGB BLACK (KF560C36BBE2AK2-32)',
      url: 'https://www.lazada.co.th/products/pdp-i6008787338.html',
      price: { amount: 24230, currency: 'THB' },
      shop: 'Advice Online',
      rating: 5,
      stock: 'in_stock',
      condition: 'new',
      variants: [],
    });
  });

  it('parses variants with their own prices', () => {
    const snap = loadFixture('lazada-th', 'listing-variants', {
      url: 'https://www.lazada.co.th/products/pdp-i5920072112.html',
    });
    const listing = lazadaTh.parseListing(snap, ctx);
    expect(listing.shop).toBe('E-Express Official Store');
    expect(listing.price).toEqual({ amount: 6950, currency: 'THB' });
    expect(listing.priceMax).toEqual({ amount: 22999, currency: 'THB' });
    expect(listing.variants.map((variant) => [variant.name, variant.price?.amount])).toEqual([
      ['8GB', 6950],
      ['16GB', 11799],
      ['32GB', 22999],
    ]);
    expect(listing.variants[1]).toMatchObject({
      options: { Capacity: '16GB' },
      stock: 'in_stock',
      sku: '25339641581',
    });
  });

  it('marks a disabled option as out of stock', () => {
    const snap = loadFixture('lazada-th', 'listing-variants', {
      url: 'https://www.lazada.co.th/products/pdp-i5920072112.html',
      data: {
        skus: [
          { skuId: '1', options: { Capacity: '8GB' }, price: '100.00', disabled: true },
          { skuId: '2', options: { Capacity: '16GB' }, price: '200.00', disabled: true },
        ],
      },
    });
    const listing = lazadaTh.parseListing(snap, ctx);
    expect(listing.stock).toBe('out_of_stock');
    expect(listing.variants.map((variant) => variant.stock)).toEqual([
      'out_of_stock',
      'out_of_stock',
    ]);
  });

  it('detects the punish page and passes normal pages', () => {
    const punish: PageSnapshot = {
      url: 'https://www.lazada.co.th/tag/ddr5/_____tmd_____/punish?x5secdata=abc',
      html: '<html><body>Sorry, we have detected unusual traffic</body></html>',
      fetchedAt: '2026-11-21T00:00:00.000Z',
      mode: 'headless',
    };
    expect(lazadaTh.detectBlock(punish)).toBe('captcha (punish page)');
    expect(
      lazadaTh.detectBlock({
        ...punish,
        url: 'https://www.lazada.co.th/catalog/?q=x',
        html: '<html><body><div id="baxia-dialog-content">slide to verify</div></body></html>',
      }),
    ).toBe('captcha (punish page)');
    expect(
      lazadaTh.detectBlock(loadFixture('lazada-th', 'search', { url: SEARCH_URL })),
    ).toBeNull();
    expect(lazadaTh.detectBlock(loadFixture('lazada-th', 'listing'))).toBeNull();
  });
});
