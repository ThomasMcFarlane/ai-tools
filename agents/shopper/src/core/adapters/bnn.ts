import {
  COMMON_BLOCK_PATTERNS,
  detectBlockWith,
  hitsFromCards,
  hostMatches,
  listingFromSelectors,
  type BlockPattern,
} from '../html.js';
import type { SiteAdapter } from '../types.js';

const ID = 'bnn';
const DOMAINS = ['bnn.in.th'];

const URL_BLOCKS: BlockPattern[] = [];

const HTML_BLOCKS: BlockPattern[] = [
  {
    test: /<title>\s*Just a moment|Performing security verification|cf-turnstile|challenge-platform/i,
    reason: 'Cloudflare challenge page',
  },
  { test: /<title>\s*(?:Attention Required|Access denied)/i, reason: 'access denied' },
];

const PAGE_SCRIPT = `(() => {
  const copy = document.body.cloneNode(true);
  copy.querySelectorAll('script, style, svg, noscript').forEach((el) => el.remove());
  return { url: location.href, html: copy.outerHTML.slice(0, 400000) };
})()`;

export const bnn: SiteAdapter = {
  id: ID,
  name: 'Banana IT',
  country: 'TH',
  currency: 'THB',
  domains: DOMAINS,
  defaultMode: 'user-browser',
  searchScript: PAGE_SCRIPT,
  listingScript: PAGE_SCRIPT,
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
    const url = new URL('https://www.bnn.in.th/en/p');
    url.searchParams.set('q', query);
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
    return detectBlockWith(snap, URL_BLOCKS, [...HTML_BLOCKS, ...COMMON_BLOCK_PATTERNS]);
  },
  matchesUrl(url) {
    return hostMatches(url, DOMAINS);
  },
};
