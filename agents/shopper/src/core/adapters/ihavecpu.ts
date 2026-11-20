import {
  detectBlockWith,
  hitsFromCards,
  hostMatches,
  listingFromSelectors,
  type BlockPattern,
} from '../html.js';
import type { SiteAdapter } from '../types.js';

const ID = 'ihavecpu';
const DOMAINS = ['ihavecpu.com'];

const URL_BLOCKS: BlockPattern[] = [];

export const ihavecpu: SiteAdapter = {
  id: ID,
  name: 'iHAVECPU',
  country: 'TH',
  currency: 'THB',
  domains: DOMAINS,
  defaultMode: 'http',
  selectors: {
    'search.card': '[class*="product-item"], [class*="product-card"]',
    'search.link': 'a[href]',
    'search.title': '[class*="name"], [class*="title"]',
    'search.price': '[class*="price"]',
    'listing.title': 'h1',
    'listing.price': '[class*="price"]',
  },
  searchUrl(query, opts) {
    const page = opts.page !== undefined && opts.page > 1 ? opts.page : 1;
    const base = `https://www.ihavecpu.com/product/search/${encodeURIComponent(query)}`;
    return page > 1 ? `${base}?page=${page}` : base;
  },
  parseSearch(snap, ctx) {
    return hitsFromCards(snap, ctx, { site: ID });
  },
  parseListing(snap, ctx) {
    return listingFromSelectors(snap, ctx, ID);
  },
  detectBlock(snap) {
    return detectBlockWith(snap, URL_BLOCKS);
  },
  matchesUrl(url) {
    return hostMatches(url, DOMAINS);
  },
};
