import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/index.js';
import type { Deps } from '../src/cli/context.js';
import { canonicalShopeeUrl, parseShopeeSold, shopeeTh } from '../src/core/adapters/shopee-th.js';
import { FIXTURE_NOW, fixtureCtx, loadFixture } from './helpers/fixture.js';

const ctx = fixtureCtx(shopeeTh);
const SEARCH_URL = 'https://shopee.co.th/search?keyword=ddr5%2032gb';

function search() {
  return loadFixture('shopee-th', 'search', { url: SEARCH_URL, mode: 'user-browser' });
}

describe('shopee-th search parsing', () => {
  it('builds search URLs without a price sort', () => {
    expect(shopeeTh.searchUrl('ddr5 32gb', {})).toBe(
      'https://shopee.co.th/search?keyword=ddr5+32gb',
    );
    expect(shopeeTh.searchUrl('ddr5 32gb', { page: 3 })).toContain('page=2');
    expect(shopeeTh.searchUrl('ddr5 32gb', {})).not.toContain('sortBy');
  });

  it('parses item cards into hits with canonical URLs', () => {
    const hits = shopeeTh.parseSearch(search(), ctx);
    expect(hits).toHaveLength(5);
    expect(hits[0]).toEqual({
      site: 'shopee-th',
      title: 'Kingston FURY Beast DDR5 32GB (2x16GB) 5600MHz Desktop RAM',
      url: 'https://shopee.co.th/product/100200300/9100000001',
      price: { amount: 1290, currency: 'THB' },
      condition: 'unknown',
      stock: 'unknown',
      shop: null,
      sold: 1200,
      seenAt: FIXTURE_NOW,
      raw: { location: 'Bangkok' },
    });
  });

  it('gives every hit an absolute item URL without a query string', () => {
    for (const hit of shopeeTh.parseSearch(search(), ctx)) {
      expect(hit.url).toMatch(/^https:\/\/shopee\.co\.th\/product\/\d+\/\d+$/);
      expect(hit.price?.currency).toBe('THB');
    }
  });

  it('drops duplicate links and links that are not items', () => {
    const urls = shopeeTh.parseSearch(search(), ctx).map((hit) => hit.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.some((url) => url.includes('/shop/'))).toBe(false);
  });

  it('parses a price range into a low and a high price', () => {
    const hit = shopeeTh.parseSearch(search(), ctx)[1];
    expect(hit?.price).toEqual({ amount: 990, currency: 'THB' });
    expect(hit?.priceMax).toEqual({ amount: 1490, currency: 'THB' });
    expect(hit?.sold).toBe(350);
    expect(hit?.raw).toEqual({ location: 'Samut Prakan' });
  });

  it('parses Thai titles and Thai sold counts', () => {
    const hit = shopeeTh.parseSearch(search(), ctx)[2];
    expect(hit?.title).toBe('แรมคอม DDR5 32GB 6400MHz รับประกันตลอดอายุการใช้งาน');
    expect(hit?.price).toEqual({ amount: 2190, currency: 'THB' });
    expect(hit?.sold).toBe(1200);
    expect(hit?.raw).toEqual({ location: 'กรุงเทพมหานคร' });
  });

  it('keeps decimals, sold counts with a plus sign and the used condition', () => {
    const hit = shopeeTh.parseSearch(search(), ctx)[3];
    expect(hit?.price).toEqual({ amount: 850.5, currency: 'THB' });
    expect(hit?.sold).toBe(10000);
    expect(hit?.condition).toBe('used');
  });

  it('ignores a discount badge next to the price', () => {
    const hit = shopeeTh.parseSearch(search(), ctx)[4];
    expect(hit?.title).toBe('Thermal paste 4g');
    expect(hit?.price).toEqual({ amount: 59, currency: 'THB' });
    expect(hit?.priceMax).toBeUndefined();
    expect(hit?.sold).toBe(80);
  });

  it('returns no hits for an empty snapshot', () => {
    expect(shopeeTh.parseSearch({ ...search(), html: '' }, ctx)).toEqual([]);
  });
});

describe('shopee-th helpers', () => {
  it('parses sold counts in English and Thai', () => {
    expect(parseShopeeSold('1.2k sold')).toBe(1200);
    expect(parseShopeeSold('350 sold')).toBe(350);
    expect(parseShopeeSold('10k+ sold')).toBe(10000);
    expect(parseShopeeSold('1,234 sold')).toBe(1234);
    expect(parseShopeeSold('ขายแล้ว 1.2พัน')).toBe(1200);
    expect(parseShopeeSold('ขายแล้ว 1.2พัน ชิ้น')).toBe(1200);
    expect(parseShopeeSold('ขายแล้ว 350 ชิ้น')).toBe(350);
    expect(parseShopeeSold('ขายแล้ว 2 หมื่น')).toBe(20000);
    expect(parseShopeeSold('Bangkok')).toBeNull();
  });

  it('builds canonical item URLs', () => {
    expect(canonicalShopeeUrl('/Some-Name-i.12.34?sp_atk=x#y', 'https://shopee.co.th/search')).toBe(
      'https://shopee.co.th/product/12/34',
    );
    expect(canonicalShopeeUrl('https://shopee.co.th/product/12/34?x=1', 'https://x.test')).toBe(
      'https://shopee.co.th/product/12/34',
    );
    expect(canonicalShopeeUrl('/shop/9?x=1', 'https://shopee.co.th/')).toBe(
      'https://shopee.co.th/shop/9',
    );
    expect(canonicalShopeeUrl('', 'https://shopee.co.th/')).toBeNull();
  });

  it('prints a search script that returns the URL and the results HTML', () => {
    expect(shopeeTh.searchScript).toContain('a[href*="-i."]');
    expect(shopeeTh.searchScript).toContain('url: location.href');
    expect(shopeeTh.searchScript).toContain('html:');
  });
});

describe('shopee-th block detection', () => {
  it('flags the verification URL', () => {
    const snap = loadFixture('shopee-th', 'verify', {
      url: 'https://shopee.co.th/verify/traffic/error',
      mode: 'user-browser',
    });
    expect(shopeeTh.detectBlock(snap)).toBe('verification or login wall');
  });

  it('flags a login redirect', () => {
    const snap = { ...search(), url: 'https://shopee.co.th/buyer/login?next=x' };
    expect(shopeeTh.detectBlock(snap)).toBe('verification or login wall');
  });

  it('flags a captcha page', () => {
    const snap = loadFixture('shopee-th', 'captcha', { url: SEARCH_URL, mode: 'user-browser' });
    expect(shopeeTh.detectBlock(snap)).toBe('captcha page');
  });

  it('does not flag a result page', () => {
    expect(shopeeTh.detectBlock(search())).toBeNull();
  });
});

describe('shopee-th CLI path', () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shopper-shopee-'));
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

  const html = readFileSync(new URL('./fixtures/shopee-th/search.html', import.meta.url), 'utf8');

  it('prints the search script', async () => {
    expect(await exec(['script', 'shopee-th', 'search'])).toBe(0);
    const script = out.join('\n');
    expect(script).toContain('a[href*="-i."]');
    expect(script).toContain('html:');
  });

  it('turns a snapshot file into hits', async () => {
    const file = join(dir, 'snapshot.json');
    writeFileSync(file, JSON.stringify({ url: SEARCH_URL, html }));
    const code = await exec([
      'parse',
      'shopee-th',
      'search',
      '--url',
      SEARCH_URL,
      '--file',
      file,
      '--json',
    ]);
    expect(code).toBe(0);
    const json = JSON.parse(out.join('\n'));
    expect(json.parsed).toBe(5);
    expect(json.hits.map((hit: { price: { amount: number } }) => hit.price.amount)).toEqual([
      59, 990, 1290, 2190,
    ]);
    const first = json.hits.find((hit: { url: string }) => hit.url.endsWith('/9100000001'));
    expect(first).toMatchObject({
      site: 'shopee-th',
      url: 'https://shopee.co.th/product/100200300/9100000001',
      price: { amount: 1290, currency: 'THB' },
      sold: 1200,
    });
    expect(json.hits.map((hit: { url: string }) => hit.url)).toContain(
      'https://shopee.co.th/product/100200302/9100000003',
    );
  });

  it('reads the URL from the snapshot when --url is missing', async () => {
    const code = await exec(
      ['parse', 'shopee-th', 'search', '--json'],
      JSON.stringify({ url: SEARCH_URL, html }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n')).parsed).toBe(5);
  });

  it('refuses a verification page', async () => {
    const code = await exec(
      ['parse', 'shopee-th', 'search', '--json'],
      JSON.stringify({ url: 'https://shopee.co.th/verify/traffic/error', html: '' }),
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('block page');
  });
});
