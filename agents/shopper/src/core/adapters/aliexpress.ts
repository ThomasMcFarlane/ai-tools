import {
  detectBlockWith,
  hitsFromCards,
  hostMatches,
  listingFromSelectors,
  normaliseText,
  type BlockPattern,
} from '../html.js';
import { parsePrice } from '../money.js';
import type { SiteAdapter, Variant } from '../types.js';

const ID = 'aliexpress';
const DOMAINS = ['aliexpress.com'];

const URL_BLOCKS: BlockPattern[] = [
  { test: /punish|captcha|x5secdata/i, reason: 'captcha (punish page)' },
];
const HTML_BLOCKS: BlockPattern[] = [
  { test: /x5secdata|punish|slide to verify/i, reason: 'captcha (punish page)' },
  { test: /captcha/i, reason: 'captcha page' },
];

const SEARCH_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 6; i += 1) {
    window.scrollBy(0, window.innerHeight);
    await sleep(500);
  }
  window.scrollTo(0, 0);
  return { scrolled: true };
})()`;

const LISTING_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (el) => ((el && el.textContent) || '').trim();
  const price = () => text(document.querySelector('[class*="price-default--current"]'));
  const out = { base: price(), groups: [] };
  const groups = Array.from(document.querySelectorAll('[class*="sku-item--property"]'));
  for (const group of groups) {
    const options = [];
    const items = group.querySelectorAll('[class*="sku-item--image"], [class*="sku-item--text"]');
    for (const item of Array.from(items)) {
      item.click();
      await sleep(400);
      const img = item.querySelector('img');
      const label = item.getAttribute('title') || text(item) || (img && img.alt) || '';
      options.push({ label: label.trim(), price: price() });
    }
    out.groups.push({ name: text(group.querySelector('[class*="sku-item--title"]')).replace(/:$/, ''), options });
  }
  return out;
})()`;

interface SkuData {
  groups?: Array<{ name?: string; options?: Array<{ label?: string; price?: string }> }>;
}

export const aliexpress: SiteAdapter = {
  id: ID,
  name: 'AliExpress',
  country: null,
  currency: 'THB',
  domains: DOMAINS,
  defaultMode: 'headless',
  selectors: {
    'search.card': 'a[href*="/item/"]',
    'search.link': '',
    'search.title': 'h3, [class*="title"]',
    'search.price': '[class*="price"]',
    'search.sold': '[class*="sold"]',
    'listing.title': 'h1',
    'listing.price': '[class*="price-default--current"]',
  },
  searchScript: SEARCH_SCRIPT,
  listingScript: LISTING_SCRIPT,
  searchUrl(query, opts) {
    const url = new URL('https://www.aliexpress.com/wholesale');
    url.searchParams.set('SearchText', query);
    if (opts.page !== undefined && opts.page > 1) url.searchParams.set('page', String(opts.page));
    return url.toString();
  },
  cookies({ currency }) {
    if (currency !== 'THB') return [];
    return [
      {
        name: 'aep_usuc_f',
        value: 'site=glo&c_tp=THB&region=TH&b_locale=en_US',
        domain: '.aliexpress.com',
      },
    ];
  },
  parseSearch(snap, ctx) {
    return hitsFromCards(snap, ctx, { site: ID, soldKey: 'search.sold' });
  },
  parseListing(snap, ctx) {
    const listing = listingFromSelectors(snap, ctx, ID);
    const data = snap.data as SkuData | null | undefined;
    const variants: Variant[] = [];
    for (const group of data?.groups ?? []) {
      for (const option of group.options ?? []) {
        const label = normaliseText(option.label);
        if (label === '') continue;
        const price = parsePrice(option.price ?? '', ctx.currency);
        variants.push({
          name: label,
          options: { [normaliseText(group.name) || 'option']: label },
          price: price?.min ?? null,
          stock: 'unknown',
        });
      }
    }
    return { ...listing, variants };
  },
  detectBlock(snap) {
    return detectBlockWith(snap, URL_BLOCKS, HTML_BLOCKS);
  },
  matchesUrl(url) {
    return hostMatches(url, DOMAINS);
  },
};
