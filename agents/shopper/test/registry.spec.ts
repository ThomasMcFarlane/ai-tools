import { describe, expect, it } from 'vitest';
import { ADAPTERS, adapterForUrl, getAdapter } from '../src/core/registry.js';
import { FIXTURE_NOW, fixtureCtx } from './helpers/fixture.js';

const EXPECTED = ['lazada-th', 'aliexpress', 'jib', 'advice', 'ihavecpu', 'bnn', 'shopee-th'];

describe('registry', () => {
  it('registers every adapter once', () => {
    expect(ADAPTERS.map((a) => a.id)).toEqual(EXPECTED);
    expect(new Set(ADAPTERS.map((a) => a.id)).size).toBe(EXPECTED.length);
  });

  it('looks adapters up by id and URL', () => {
    expect(getAdapter('jib')?.name).toBe('JIB');
    expect(getAdapter('nope')).toBeNull();
    expect(adapterForUrl('https://www.lazada.co.th/products/x.html')?.id).toBe('lazada-th');
    expect(adapterForUrl('https://shopee.co.th/x-i.1.2')?.id).toBe('shopee-th');
    expect(adapterForUrl('https://example.com/')).toBeNull();
  });

  it('sets only shopee-th to user-browser mode', () => {
    expect(ADAPTERS.filter((a) => a.defaultMode === 'user-browser').map((a) => a.id)).toEqual([
      'shopee-th',
    ]);
  });
});

describe.each(ADAPTERS.map((adapter) => [adapter.id, adapter] as const))('%s', (_id, adapter) => {
  it('builds a search URL on its own domain with the query', () => {
    const url = adapter.searchUrl('rtx 5070', {});
    expect(adapter.matchesUrl(url)).toBe(true);
    expect(decodeURIComponent(url.replace(/\+/g, ' '))).toContain('rtx 5070');
  });

  it('has selectors for cards and prices', () => {
    expect(adapter.selectors['search.card']).toBeTruthy();
    expect(adapter.selectors['search.price']).toBeTruthy();
  });

  it('returns no hits and no block for an empty page', () => {
    const snap = {
      url: 'https://example.com',
      html: '<html></html>',
      fetchedAt: FIXTURE_NOW,
      mode: 'http' as const,
    };
    expect(adapter.parseSearch(snap, fixtureCtx(adapter))).toEqual([]);
    expect(adapter.detectBlock(snap)).toBeNull();
  });

  it('reports a captcha page as blocked', () => {
    const snap = {
      url: 'https://example.com',
      html: '<html><body>Please complete the captcha</body></html>',
      fetchedAt: FIXTURE_NOW,
      mode: 'http' as const,
    };
    expect(adapter.detectBlock(snap)).not.toBeNull();
  });
});

describe('adapter specifics', () => {
  it('sets the Thai Baht cookie for AliExpress only when the currency is THB', () => {
    const adapter = getAdapter('aliexpress');
    expect(adapter?.cookies?.({ currency: 'THB' })[0]?.value).toContain('c_tp=THB');
    expect(adapter?.cookies?.({ currency: 'USD' })).toEqual([]);
  });

  it('gives shopee-th scripts that return url and html', () => {
    const adapter = getAdapter('shopee-th');
    expect(adapter?.searchScript).toContain('a[href*="-i."]');
    expect(adapter?.searchScript).toContain('html:');
    expect(adapter?.searchUrl('gpu', {})).not.toContain('sortBy');
  });

  it('builds variants from AliExpress option data', () => {
    const adapter = getAdapter('aliexpress');
    const listing = adapter?.parseListing(
      {
        url: 'https://www.aliexpress.com/item/1.html',
        html: '<h1>Cable</h1>',
        data: {
          groups: [
            {
              name: 'Length',
              options: [
                { label: '1 m', price: '฿99' },
                { label: '2 m', price: '฿149' },
              ],
            },
          ],
        },
        fetchedAt: FIXTURE_NOW,
        mode: 'headless',
      },
      fixtureCtx(adapter as NonNullable<typeof adapter>),
    );
    expect(listing?.variants.map((v) => [v.name, v.price?.amount])).toEqual([
      ['1 m', 99],
      ['2 m', 149],
    ]);
    expect(listing?.variants[0]?.options).toEqual({ Length: '1 m' });
  });
});
