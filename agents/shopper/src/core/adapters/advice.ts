import {
  detectBlockWith,
  hitsFromCards,
  hostMatches,
  listingFromSelectors,
  type BlockPattern,
} from '../html.js';
import type { SiteAdapter } from '../types.js';

const ID = 'advice';
const DOMAINS = ['advice.co.th'];

const URL_BLOCKS: BlockPattern[] = [];

export const advice: SiteAdapter = {
  id: ID,
  name: 'Advice IT',
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
    const url = new URL('https://www.advice.co.th/product/search');
    url.searchParams.set('keyword', query);
    if (page > 1) url.searchParams.set('page', String(page));
    return url.toString();
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
