import { spacedText, textLines } from '../card-text.js';
import { parsePrice } from '../money.js';
import {
  absoluteUrl,
  detectBlockWith,
  guessCondition,
  hostMatches,
  listingFromSelectors,
  normaliseText,
  parseDocument,
  pick,
  selectorFor,
  type BlockPattern,
} from '../html.js';
import type { Listing, ParseCtx, SearchHit, SiteAdapter } from '../types.js';

const ID = 'shopee-th';
const DOMAINS = ['shopee.co.th'];
const ORIGIN = 'https://shopee.co.th';

const URL_BLOCKS: BlockPattern[] = [
  { test: /\/verify\/|traffic\/error|\/buyer\/login/i, reason: 'verification or login wall' },
];

const SEARCH_SCRIPT = `(async () => {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const startY = window.scrollY;
  for (let step = 0; step < 6; step += 1) {
    window.scrollBy(0, window.innerHeight);
    await pause(500);
  }
  window.scrollTo(0, startY);
  const links = Array.from(document.querySelectorAll('a[href*="-i."]'));
  if (links.length === 0) return { url: location.href, html: '' };
  const last = links[links.length - 1];
  let node = links[0].parentElement;
  while (node && node.parentElement && !node.contains(last)) node = node.parentElement;
  if (!node) return { url: location.href, html: '' };
  const copy = node.cloneNode(true);
  copy.querySelectorAll('script, style, svg, noscript').forEach((el) => el.remove());
  return { url: location.href, html: copy.outerHTML.slice(0, 400000) };
})()`;

const LISTING_SCRIPT = `(() => {
  const root = document.querySelector('main') || document.body;
  const copy = root.cloneNode(true);
  copy.querySelectorAll('script, style, svg, noscript').forEach((el) => el.remove());
  return { url: location.href, html: copy.outerHTML.slice(0, 400000) };
})()`;

const ITEM_PATH = /-i\.(\d+)\.(\d+)/;
const PRODUCT_PATH = /\/product\/(\d+)\/(\d+)/;
const PRICE_TEXT = /฿\s*[\d,]+(?:\.\d+)?(?:\s*[-–~]\s*฿\s*[\d,]+(?:\.\d+)?)?/;

const SOLD_UNITS: Record<string, number> = {
  k: 1_000,
  พัน: 1_000,
  หมื่น: 10_000,
  แสน: 100_000,
  m: 1_000_000,
  ล้าน: 1_000_000,
};

const UNIT = '(k|m|พัน|หมื่น|แสน|ล้าน)?';

export function canonicalShopeeUrl(href: string | null | undefined, base: string): string | null {
  const absolute = absoluteUrl(href, base);
  if (absolute === null) return null;
  const url = new URL(absolute);
  const ids = ITEM_PATH.exec(url.pathname) ?? PRODUCT_PATH.exec(url.pathname);
  if (ids !== null) return `${ORIGIN}/product/${ids[1]}/${ids[2]}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function parseShopeeSold(text: string): number | null {
  const lower = text.toLowerCase();
  const thai = new RegExp(`ขายแล้ว\\s*([\\d.,]+)\\s*${UNIT}`).exec(lower);
  const english = new RegExp(`([\\d.,]+)\\s*${UNIT}\\+?\\s*(?:sold|ชิ้น)`).exec(lower);
  const match = lower.includes('ขายแล้ว') ? (thai ?? english) : (english ?? thai);
  if (match === null) return null;
  const base = Number((match[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  return Math.round(base * (SOLD_UNITS[match[2] ?? ''] ?? 1));
}

function titleOf(card: ParentNode, link: Element, ctx: ParseCtx): string {
  const el = pick(card, ctx, 'search.title');
  if (el !== null) {
    const attr = normaliseText(el.getAttribute('title') ?? '');
    if (attr !== '') return attr;
    const alt = normaliseText(el.getAttribute('alt') ?? '');
    if (alt !== '') return alt;
    const text = normaliseText(el.textContent);
    if (text !== '') return text;
  }
  const image = card.querySelector('img[alt]');
  const alt = normaliseText(image?.getAttribute('alt') ?? '');
  if (alt !== '') return alt;
  return normaliseText(link.getAttribute('title') ?? '') || normaliseText(link.textContent);
}

function priceOf(card: ParentNode, ctx: ParseCtx, lines: string[]) {
  const el = pick(card, ctx, 'search.price');
  const own = el === null ? '' : spacedText(el);
  if (/\d/.test(own)) return parsePrice(own, ctx.currency);
  const found = PRICE_TEXT.exec(lines.join(' '));
  return found === null ? null : parsePrice(found[0], ctx.currency);
}

function soldOf(card: ParentNode, ctx: ParseCtx, lines: string[]): number | null {
  const el = pick(card, ctx, 'search.sold');
  const own = el === null ? '' : normaliseText(el.textContent);
  if (own !== '') return parseShopeeSold(own);
  const line = lines.find((text) => /sold|ขายแล้ว/i.test(text));
  return line === undefined ? null : parseShopeeSold(line);
}

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
    'search.location': '[class*="location"]',
    'listing.title': 'h1, [class*="title"]',
    'listing.price': '[class*="price"]',
  },
  searchScript: SEARCH_SCRIPT,
  listingScript: LISTING_SCRIPT,
  searchUrl(query, opts) {
    const url = new URL(`${ORIGIN}/search`);
    url.searchParams.set('keyword', query);
    if (opts.page !== undefined && opts.page > 1)
      url.searchParams.set('page', String(opts.page - 1));
    return url.toString();
  },
  parseSearch(snap, ctx) {
    const doc = parseDocument(snap.html);
    const cardSelector = selectorFor(ctx, 'search.card');
    if (cardSelector === null) return [];
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const card of Array.from(doc.querySelectorAll(cardSelector))) {
      const linkEl = card.matches('a')
        ? card
        : (pick(card, ctx, 'search.link') ?? card.querySelector('a[href]'));
      if (linkEl === null) continue;
      const url = canonicalShopeeUrl(linkEl.getAttribute('href'), snap.url);
      const title = titleOf(card, linkEl, ctx);
      if (url === null || title === '' || seen.has(url)) continue;
      seen.add(url);
      const lines = textLines(card);
      const price = priceOf(card, ctx, lines);
      const hit: SearchHit = {
        site: ID,
        title,
        url,
        price: price?.min ?? null,
        condition: guessCondition(title),
        stock: 'unknown',
        shop: null,
        seenAt: ctx.now,
      };
      if (price?.max !== undefined && price.max !== null) hit.priceMax = price.max;
      const sold = soldOf(card, ctx, lines);
      if (sold !== null) hit.sold = sold;
      const location = normaliseText(pick(card, ctx, 'search.location')?.textContent);
      if (location !== '') hit.raw = { location };
      hits.push(hit);
    }
    return hits;
  },
  parseListing(snap, ctx): Listing {
    const listing = listingFromSelectors(snap, ctx, ID);
    listing.url = canonicalShopeeUrl(snap.url, ORIGIN) ?? listing.url;
    return listing;
  },
  detectBlock(snap) {
    return detectBlockWith(snap, URL_BLOCKS);
  },
  matchesUrl(url) {
    return hostMatches(url, DOMAINS);
  },
};
