import {
  detectBlockWith,
  hitsFromCards,
  hostMatches,
  listingFromSelectors,
  type BlockPattern,
} from '../html.js';
import type { SiteAdapter } from '../types.js';

const ID = 'shopee-th';
const DOMAINS = ['shopee.co.th'];

const URL_BLOCKS: BlockPattern[] = [
  { test: /\/verify\/|traffic\/error|\/buyer\/login/i, reason: 'verification or login wall' },
];

const SEARCH_SCRIPT = `(() => {
  const links = Array.from(document.querySelectorAll('a[href*="-i."]'));
  if (links.length === 0) return { url: location.href, html: '' };
  const last = links[links.length - 1];
  let node = links[0].parentElement;
  while (node && node.parentElement && !node.contains(last)) node = node.parentElement;
  return { url: location.href, html: node ? node.outerHTML.slice(0, 400000) : '' };
})()`;

const LISTING_SCRIPT = `(() => {
  const root = document.querySelector('main') || document.body;
  return { url: location.href, html: root.outerHTML.slice(0, 400000) };
})()`;

export const shopeeTh: SiteAdapter = {
  id: ID,
  name: 'Shopee Thailand',
  country: 'TH',
  currency: 'THB',
  domains: DOMAINS,
  defaultMode: 'user-browser',
  selectors: {
    'search.card': 'a[href*="-i."]',
    'search.link': '',
    'search.title': '[class*="line-clamp"], img[alt]',
    'search.price': '[class*="price"]',
    'search.sold': '[class*="sold"]',
    'listing.title': 'h1, [class*="title"]',
    'listing.price': '[class*="price"]',
  },
  searchScript: SEARCH_SCRIPT,
  listingScript: LISTING_SCRIPT,
  searchUrl(query, opts) {
    const url = new URL('https://shopee.co.th/search');
    url.searchParams.set('keyword', query);
    if (opts.page !== undefined && opts.page > 1)
      url.searchParams.set('page', String(opts.page - 1));
    return url.toString();
  },
  parseSearch(snap, ctx) {
    return hitsFromCards(snap, ctx, { site: ID, soldKey: 'search.sold' });
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
