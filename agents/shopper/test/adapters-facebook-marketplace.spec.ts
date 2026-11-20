import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/index.js';
import type { Deps } from '../src/cli/context.js';
import {
  canonicalFacebookUrl,
  facebookLocationSlug,
  facebookMarketplace,
  facebookSearchUrl,
} from '../src/core/adapters/facebook-marketplace.js';
import { FIXTURE_NOW, fixtureCtx, loadFixture } from './helpers/fixture.js';

const ctx = fixtureCtx(facebookMarketplace);
const SEARCH_URL = 'https://www.facebook.com/marketplace/bangkok/search?query=ddr5';
const ITEM_URL = 'https://www.facebook.com/marketplace/item/1161356103342099/?ref=search';

function search() {
  return loadFixture('facebook-marketplace', 'search', {
    url: SEARCH_URL,
    mode: 'user-browser',
  });
}

describe('facebook-marketplace URLs', () => {
  it('builds a search URL without a location', () => {
    expect(facebookMarketplace.searchUrl('ddr5 32gb', {})).toBe(
      'https://www.facebook.com/marketplace/search?query=ddr5+32gb',
    );
  });

  it('puts the city slug into the path', () => {
    expect(facebookMarketplace.searchUrl('ddr5', { city: 'Chiang Mai' })).toBe(
      'https://www.facebook.com/marketplace/chiangmai/search?query=ddr5',
    );
    expect(facebookMarketplace.searchUrl('ddr5', { city: '  ' })).toBe(
      'https://www.facebook.com/marketplace/search?query=ddr5',
    );
    expect(facebookLocationSlug('Bangkok')).toBe('bangkok');
    expect(facebookLocationSlug(undefined)).toBeNull();
  });

  it('adds the optional filters', () => {
    const url = new URL(
      facebookSearchUrl('ddr5', {
        location: 'bangkok',
        minPrice: 500,
        maxPrice: 3000,
        sortByPrice: true,
        condition: 'used',
        exact: false,
      }),
    );
    expect(url.pathname).toBe('/marketplace/bangkok/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: 'ddr5',
      minPrice: '500',
      maxPrice: '3000',
      sortBy: 'price_ascend',
      itemCondition: 'used_like_new,used_good,used_fair',
      exact: 'false',
    });
    expect(
      new URL(facebookSearchUrl('x', { condition: 'new' })).searchParams.get('itemCondition'),
    ).toBe('new');
  });

  it('normalises item URLs', () => {
    expect(canonicalFacebookUrl('/marketplace/item/123/?ref=search&x=1')).toBe(
      'https://www.facebook.com/marketplace/item/123/',
    );
    expect(canonicalFacebookUrl('https://www.facebook.com/marketplace/item/456')).toBe(
      'https://www.facebook.com/marketplace/item/456/',
    );
    expect(canonicalFacebookUrl('/marketplace/category/electronics')).toBeNull();
    expect(canonicalFacebookUrl(null)).toBeNull();
  });

  it('matches Marketplace URLs only', () => {
    expect(facebookMarketplace.matchesUrl(ITEM_URL)).toBe(true);
    expect(facebookMarketplace.matchesUrl('https://www.facebook.com/somepage')).toBe(false);
    expect(facebookMarketplace.matchesUrl('https://example.com/marketplace/item/1')).toBe(false);
  });
});

describe('facebook-marketplace search parsing (real capture)', () => {
  it('parses every card into a hit with a canonical URL', () => {
    const hits = facebookMarketplace.parseSearch(search(), ctx);
    expect(hits).toHaveLength(8);
    expect(hits[0]).toEqual({
      site: 'facebook-marketplace',
      title: 'i5-14400F & B760M WIFI',
      url: 'https://www.facebook.com/marketplace/item/1161356103342099/',
      price: { amount: 7090, currency: 'THB' },
      condition: 'unknown',
      stock: 'in_stock',
      shop: null,
      seenAt: FIXTURE_NOW,
      raw: { location: 'Bangkok, Thailand' },
    });
    expect(hits.map((hit) => hit.url.replace(/\D/g, ''))).toEqual([
      '1161356103342099',
      '981244524697366',
      '1344906937760544',
      '1834102617732471',
      '913059495133567',
      '1820301782716203',
      '1698458738343111',
      '1702908927439084',
    ]);
  });

  it('does not take a badge as the title', () => {
    const hit = facebookMarketplace.parseSearch(search(), ctx)[1];
    expect(hit?.title).toBe('Asus Rog Strix B760-i gaming wifi ddr5');
    expect(hit?.price).toEqual({ amount: 4300, currency: 'THB' });
  });

  it('keeps Thai titles and titles that hold a price', () => {
    const hits = facebookMarketplace.parseSearch(search(), ctx);
    expect(hits[2]?.title).toBe('ตั้งรับ RAM DDR5 32GB KINGSTON FURY BEAST BUS 5600');
    expect(hits[3]?.title).toContain('2TB SSD | 18,500 THB');
    expect(hits[3]?.price).toEqual({ amount: 18500, currency: 'THB' });
  });

  it('takes the current price and ignores the old price', () => {
    const hits = facebookMarketplace.parseSearch(search(), ctx);
    expect(hits[5]?.title).toBe('อัพเดท 11 พ.ย. แรม ddr5 8gb 16gb 32gb 48gb');
    expect(hits[5]?.price).toEqual({ amount: 2750, currency: 'THB' });
    expect(hits[5]?.priceMax).toBeUndefined();
    expect(hits[6]?.price).toEqual({ amount: 5300, currency: 'THB' });
    expect(hits[6]?.title).toBe('DDR 5 5600 RGB 16 GB');
  });

  it('drops links that are not items', () => {
    const html = `${search().html}<a href="/marketplace/category/electronics">Electronics</a>`;
    expect(facebookMarketplace.parseSearch({ ...search(), html }, ctx)).toHaveLength(8);
  });

  it('parses commas in a title from the right of the label', () => {
    const html =
      '<a aria-label="Just listed, RAM, 2x16GB, 5600, ฿3,000, reduced from ฿4,000, Chiang Mai, Thailand, listing 77" href="/marketplace/item/77/?ref=x">' +
      '<span dir="auto">Just listed</span><span dir="auto">฿3,000</span><span dir="auto">฿4,000</span>' +
      '<span dir="auto">RAM, 2x16GB, 5600</span><span dir="auto">Chiang Mai, Thailand</span></a>';
    const [hit] = facebookMarketplace.parseSearch({ ...search(), html }, ctx);
    expect(hit).toMatchObject({
      title: 'RAM, 2x16GB, 5600',
      url: 'https://www.facebook.com/marketplace/item/77/',
      price: { amount: 3000, currency: 'THB' },
      raw: { location: 'Chiang Mai, Thailand' },
    });
  });

  it('returns no hits for an empty snapshot', () => {
    expect(facebookMarketplace.parseSearch({ ...search(), html: '' }, ctx)).toEqual([]);
  });

  it('prints scripts that return the URL and the HTML', () => {
    expect(facebookMarketplace.searchScript).toContain('a[href*="/marketplace/item/"]');
    expect(facebookMarketplace.searchScript).toContain('url: location.href');
    expect(facebookMarketplace.listingScript).toContain('html:');
  });
});

describe('facebook-marketplace search parsing (synthetic cards)', () => {
  const synthetic = () =>
    loadFixture('facebook-marketplace', 'search-synthetic', {
      url: SEARCH_URL,
      mode: 'user-browser',
    });

  it('reads price, title and location from the span order', () => {
    const hits = facebookMarketplace.parseSearch(synthetic(), ctx);
    expect(hits).toHaveLength(6);
    expect(hits[0]).toMatchObject({
      title: 'Kingston FURY Beast DDR5 32GB 5600MHz',
      url: 'https://www.facebook.com/marketplace/item/100000000000001/',
      price: { amount: 4500, currency: 'THB' },
      raw: { location: 'Bangkok, Bangkok' },
    });
  });

  it('takes the current price when an old price is struck out', () => {
    const hit = facebookMarketplace.parseSearch(synthetic(), ctx)[1];
    expect(hit?.title).toBe('Corsair Vengeance DDR5 32GB 6000MHz');
    expect(hit?.price).toEqual({ amount: 3900, currency: 'THB' });
  });

  it('reads Free as a price of zero', () => {
    const hit = facebookMarketplace.parseSearch(synthetic(), ctx)[2];
    expect(hit?.price).toEqual({ amount: 0, currency: 'THB' });
    expect(hit?.title).toBe('Old DDR3 RAM sticks, 4GB x 2');
  });

  it('marks sold and pending items', () => {
    const hits = facebookMarketplace.parseSearch(synthetic(), ctx);
    expect(hits[3]?.stock).toBe('out_of_stock');
    expect(hits[3]?.title).toBe('G.Skill Ripjaws DDR4 16GB 3200MHz');
    expect(hits[5]?.stock).toBe('unknown');
  });

  it('parses a THB-prefixed price', () => {
    expect(facebookMarketplace.parseSearch(synthetic(), ctx)[4]?.price).toEqual({
      amount: 1750,
      currency: 'THB',
    });
  });

  it('drops repeated links', () => {
    const urls = facebookMarketplace.parseSearch(synthetic(), ctx).map((hit) => hit.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe('facebook-marketplace listing parsing', () => {
  const item = () =>
    loadFixture('facebook-marketplace', 'listing', {
      url: 'https://www.facebook.com/marketplace/item/913059495133567/?ref=search',
      mode: 'user-browser',
    });

  it('reads title, price, condition, stock and location from the real capture', () => {
    expect(facebookMarketplace.parseListing(item(), ctx)).toEqual({
      site: 'facebook-marketplace',
      title: 'RAM DDR5 32GB (16X2) BUS 6000 CORSAIR VENGEANCE BLACK RGB',
      url: 'https://www.facebook.com/marketplace/item/913059495133567/',
      price: { amount: 13300, currency: 'THB' },
      condition: 'used',
      stock: 'in_stock',
      shop: null,
      seenAt: FIXTURE_NOW,
      variants: [],
      raw: { location: 'ดินแดง, กรุงเทพมหานคร' },
    });
  });

  it('maps the condition values', () => {
    const page = (value: string) =>
      facebookMarketplace.parseListing(
        {
          ...item(),
          html: `<h1>X</h1><span>฿1</span><div><span>Condition</span><span>${value}</span></div>`,
        },
        ctx,
      ).condition;
    expect(page('New')).toBe('new');
    expect(page('Used - like new')).toBe('used');
    expect(page('Used - Good')).toBe('used');
    expect(page('Used - fair')).toBe('used');
  });

  it('marks a sold or pending item page', () => {
    const page = (status: string) =>
      facebookMarketplace.parseListing(
        { ...item(), html: `<h1>X</h1><span>฿1</span><span>${status}</span>` },
        ctx,
      ).stock;
    expect(page('Sold')).toBe('out_of_stock');
    expect(page('Pending')).toBe('unknown');
  });
});

describe('facebook-marketplace block detection', () => {
  it('flags the ineligible page', () => {
    const snap = loadFixture('facebook-marketplace', 'ineligible', {
      url: 'https://www.facebook.com/marketplace/ineligible/',
      mode: 'user-browser',
    });
    expect(facebookMarketplace.detectBlock(snap)).toBe(
      'Marketplace needs a personal profile, not a Page',
    );
  });

  it('flags login and checkpoint URLs', () => {
    const base = { ...search(), html: '' };
    expect(
      facebookMarketplace.detectBlock({ ...base, url: 'https://www.facebook.com/login/?next=x' }),
    ).toBe('login wall');
    expect(
      facebookMarketplace.detectBlock({ ...base, url: 'https://www.facebook.com/checkpoint/1/' }),
    ).toBe('security checkpoint');
  });

  it('flags a login form', () => {
    const snap = loadFixture('facebook-marketplace', 'login', {
      url: SEARCH_URL,
      mode: 'user-browser',
    });
    expect(facebookMarketplace.detectBlock(snap)).toBe('login wall');
    expect(
      facebookMarketplace.detectBlock({ ...snap, html: '<p>You must log in to continue</p>' }),
    ).toBe('login wall');
  });

  it('does not flag a result page', () => {
    expect(facebookMarketplace.detectBlock(search())).toBeNull();
  });
});

describe('facebook-marketplace CLI path', () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shopper-facebook-'));
    out = [];
    err = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function exec(args: string[], stdin = '') {
    const deps: Partial<Deps> = {
      print: (text) => out.push(text),
      printErr: (text) => err.push(text),
      readStdin: async () => stdin,
      env: { AGENTS_MEMORY_DIR: join(dir, 'mem'), AGENTS_STATE_DIR: join(dir, 'state') },
      home: dir,
      now: () => new Date(FIXTURE_NOW),
    };
    return run(['node', 'shopper', ...args], deps);
  }

  const html = readFileSync(
    new URL('./fixtures/facebook-marketplace/search.html', import.meta.url),
    'utf8',
  );

  it('prints the search script', async () => {
    expect(await exec(['script', 'facebook-marketplace', 'search'])).toBe(0);
    expect(out.join('\n')).toContain('a[href*="/marketplace/item/"]');
  });

  it('turns a snapshot file into hits', async () => {
    const file = join(dir, 'snapshot.json');
    writeFileSync(file, JSON.stringify({ url: SEARCH_URL, html }));
    const code = await exec([
      'parse',
      'facebook-marketplace',
      'search',
      '--url',
      SEARCH_URL,
      '--file',
      file,
      '--json',
    ]);
    expect(code).toBe(0);
    const json = JSON.parse(out.join('\n'));
    expect(json.parsed).toBe(8);
    const first = json.hits.find((hit: { url: string }) => hit.url.includes('1161356103342099'));
    expect(first).toMatchObject({
      site: 'facebook-marketplace',
      url: 'https://www.facebook.com/marketplace/item/1161356103342099/',
      price: { amount: 7090, currency: 'THB' },
    });
  });

  it('refuses the ineligible page', async () => {
    const code = await exec(
      ['parse', 'facebook-marketplace', 'search', '--json'],
      JSON.stringify({ url: 'https://www.facebook.com/marketplace/ineligible/', html: '' }),
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('block page');
  });
});
