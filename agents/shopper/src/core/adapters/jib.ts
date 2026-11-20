import {
  detectBlockWith,
  hitsFromCards,
  hostMatches,
  listingFromSelectors,
  type BlockPattern,
} from '../html.js';
import type { SiteAdapter } from '../types.js';

const ID = 'jib';
const DOMAINS = ['jib.co.th'];

const URL_BLOCKS: BlockPattern[] = [];

export const jib: SiteAdapter = {
  id: ID,
  name: 'JIB',
  country: 'TH',
  currency: 'THB',
  domains: DOMAINS,
  defaultMode: 'http',
  selectors: {
    'search.card': '.promotion_card_product, [class*="product-item"], [class*="product_item"]',
    'search.link': 'a[href]',
    'search.title': '[class*="name"], a[title]',
    'search.price': '[class*="price"]',
    'listing.title': 'h1',
    'listing.price': '[class*="price"]',
  },
  searchUrl(query, opts) {
    const page = opts.page !== undefined && opts.page > 1 ? opts.page : 1;
    const base = `https://www.jib.co.th/web/product/product_search/${page - 1}`;
    return `${base}?str_search=${encodeURIComponent(query)}`;
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
