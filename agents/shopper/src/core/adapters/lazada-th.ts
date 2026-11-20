import {
  detectBlockWith,
  hitsFromCards,
  hostMatches,
  listingFromSelectors,
  type BlockPattern,
} from '../html.js';
import type { SiteAdapter } from '../types.js';

const ID = 'lazada-th';
const DOMAINS = ['lazada.co.th'];

const URL_BLOCKS: BlockPattern[] = [
  { test: /punish|captcha|\/sec\//i, reason: 'captcha (punish page)' },
];
const HTML_BLOCKS: BlockPattern[] = [
  { test: /_____tmd_____|punish|baxia|slide to verify/i, reason: 'captcha (punish page)' },
  { test: /captcha/i, reason: 'captcha page' },
];

export const lazadaTh: SiteAdapter = {
  id: ID,
  name: 'Lazada Thailand',
  country: 'TH',
  currency: 'THB',
  domains: DOMAINS,
  defaultMode: 'headless',
  selectors: {
    'search.card': '[data-qa-locator="product-item"]',
    'search.link': 'a[href*="/products/"]',
    'search.title': 'a[title]',
    'search.price': '[class*="price"]',
    'search.shop': '[class*="location"]',
    'search.sold': '[class*="sold"]',
    'listing.title': 'h1',
    'listing.price': '[class*="pdp-price"]',
  },
  searchUrl(query, opts) {
    const url = new URL('https://www.lazada.co.th/catalog/');
    url.searchParams.set('q', query);
    if (opts.page !== undefined && opts.page > 1) url.searchParams.set('page', String(opts.page));
    return url.toString();
  },
  parseSearch(snap, ctx) {
    return hitsFromCards(snap, ctx, { site: ID, soldKey: 'search.sold', shopKey: 'search.shop' });
  },
  parseListing(snap, ctx) {
    return listingFromSelectors(snap, ctx, ID);
  },
  detectBlock(snap) {
    return detectBlockWith(snap, URL_BLOCKS, HTML_BLOCKS);
  },
  matchesUrl(url) {
    return hostMatches(url, DOMAINS);
  },
};
