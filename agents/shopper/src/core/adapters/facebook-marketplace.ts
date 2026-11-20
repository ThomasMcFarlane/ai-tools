import { textLines } from '../card-text.js';
import {
  detectBlockWith,
  guessCondition,
  hostMatches,
  normaliseText,
  parseDocument,
  pick,
  selectorFor,
  COMMON_BLOCK_PATTERNS,
  type BlockPattern,
} from '../html.js';
import { parsePrice } from '../money.js';
import type { Condition, Listing, ParseCtx, SearchHit, SiteAdapter, Stock } from '../types.js';

const ID = 'facebook-marketplace';
const DOMAINS = ['facebook.com'];
const ORIGIN = 'https://www.facebook.com';
const ITEM_ID = /\/marketplace\/item\/(\d+)/;

const URL_BLOCKS: BlockPattern[] = [
  {
    test: /\/marketplace\/ineligible/i,
    reason: 'Marketplace needs a personal profile, not a Page',
  },
  { test: /\/login(?:[/.?]|$)/i, reason: 'login wall' },
  { test: /\/checkpoint\//i, reason: 'security checkpoint' },
];

const HTML_BLOCKS: BlockPattern[] = [
  { test: /id="login_form"|name="pass"|you must log in/i, reason: 'login wall' },
  ...COMMON_BLOCK_PATTERNS,
];

const SEARCH_SCRIPT = `(async () => {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const startY = window.scrollY;
  for (let step = 0; step < 6; step += 1) {
    window.scrollBy(0, window.innerHeight);
    await pause(700);
  }
  window.scrollTo(0, startY);
  const links = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));
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
  const root = document.querySelector('[role="main"]') || document.querySelector('main') || document.body;
  const copy = root.cloneNode(true);
  copy.querySelectorAll('script, style, svg, noscript').forEach((el) => el.remove());
  return { url: location.href, html: copy.outerHTML.slice(0, 400000) };
})()`;

const PRICE_TOKEN = /(?:฿|THB)\s*\d[\d,]*(?:\.\d+)?/i;
const FREE_LINE = /^free$/i;
const STATUS_LINE = /^(?:sold|pending)$/i;

export interface FacebookSearchOptions {
  location?: string;
  minPrice?: number;
  maxPrice?: number;
  sortByPrice?: boolean;
  condition?: 'new' | 'used';
  exact?: boolean;
}

export function facebookLocationSlug(city: string | undefined): string | null {
  const slug = (city ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9_-]/g, '');
  return slug === '' ? null : slug;
}

export function facebookSearchUrl(query: string, opts: FacebookSearchOptions = {}): string {
  const slug = facebookLocationSlug(opts.location);
  const url = new URL(`${ORIGIN}/marketplace/${slug === null ? '' : `${slug}/`}search`);
  url.searchParams.set('query', query);
  if (opts.minPrice !== undefined) url.searchParams.set('minPrice', String(opts.minPrice));
  if (opts.maxPrice !== undefined) url.searchParams.set('maxPrice', String(opts.maxPrice));
  if (opts.sortByPrice === true) url.searchParams.set('sortBy', 'price_ascend');
  if (opts.condition === 'new') url.searchParams.set('itemCondition', 'new');
  if (opts.condition === 'used')
    url.searchParams.set('itemCondition', 'used_like_new,used_good,used_fair');
  if (opts.exact === false) url.searchParams.set('exact', 'false');
  return url.toString();
}

export function canonicalFacebookUrl(href: string | null | undefined): string | null {
  const match = ITEM_ID.exec(href ?? '');
  return match === null ? null : `${ORIGIN}/marketplace/item/${match[1]}/`;
}

function isPriceLine(line: string): boolean {
  return FREE_LINE.test(line) || PRICE_TOKEN.test(line);
}

function priceOfLines(lines: string[], currency: string): SearchHit['price'] {
  const line = lines.find(isPriceLine);
  if (line === undefined) return null;
  if (FREE_LINE.test(line)) return { amount: 0, currency };
  const token = PRICE_TOKEN.exec(line);
  return token === null ? null : (parsePrice(token[0], currency)?.min ?? null);
}

function stockOfLines(lines: string[]): Stock {
  const status = lines.find((line) => STATUS_LINE.test(line));
  if (status === undefined) return 'in_stock';
  return /^sold$/i.test(status) ? 'out_of_stock' : 'unknown';
}

function conditionOfLines(lines: string[]): Condition | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const inline = /^condition\s*:?\s*(.+)$/i.exec(line);
    const value =
      inline !== null
        ? (inline[1] as string)
        : /^condition$/i.test(line)
          ? lines[i + 1]
          : undefined;
    if (value === undefined) continue;
    if (/^new\b/i.test(value)) return 'new';
    if (/^used\b/i.test(value)) return 'used';
    if (/^refurbished\b/i.test(value)) return 'refurbished';
  }
  return null;
}

function textOfPick(card: ParentNode, ctx: ParseCtx, key: string): string {
  return normaliseText(pick(card, ctx, key)?.textContent);
}

const PRICE_SOURCE = '(?:(?:฿|THB)\\s*\\d[\\d,]*(?:\\.\\d+)?|Free)';
const ARIA_LABEL = new RegExp(
  `^(.*), (${PRICE_SOURCE})(?:, reduced from ${PRICE_SOURCE})?, (.+), listing (\\d+)$`,
  'is',
);

interface CardFields {
  title: string;
  price: SearchHit['price'];
  location: string;
}

function priceOfText(text: string, currency: string): SearchHit['price'] {
  return priceOfLines([text], currency);
}

function dropBadge(title: string, spans: string[]): string {
  if (spans.includes(title)) return title;
  let at = title.indexOf(', ');
  while (at !== -1) {
    const rest = title.slice(at + 2);
    if (spans.includes(rest)) return rest;
    at = title.indexOf(', ', at + 2);
  }
  return title;
}

function fieldsFromLabel(card: Element, ctx: ParseCtx, lines: string[]): CardFields | null {
  const label = normaliseText(card.getAttribute('aria-label'));
  const match = ARIA_LABEL.exec(label);
  if (match === null) return null;
  const spans = Array.from(card.querySelectorAll('span[dir="auto"]')).map((el) =>
    normaliseText(el.textContent),
  );
  const title = dropBadge(normaliseText(match[1]), spans.length > 0 ? spans : lines);
  return {
    title,
    price: priceOfText(match[2] ?? '', ctx.currency),
    location: normaliseText(match[3]),
  };
}

function fieldsFromLines(lines: string[], ctx: ParseCtx): CardFields {
  const priceAt = lines.findIndex(isPriceLine);
  let last = priceAt;
  while (last !== -1 && lines[last + 1] !== undefined && isPriceLine(lines[last + 1] as string))
    last += 1;
  const rest = lines.slice(last + 1).filter((line) => !STATUS_LINE.test(line));
  const plain = last === -1 ? lines.filter((line) => !STATUS_LINE.test(line)) : rest;
  return {
    title: plain[0] ?? '',
    price: priceOfLines(lines, ctx.currency),
    location: plain[1] ?? '',
  };
}

export const facebookMarketplace: SiteAdapter = {
  id: ID,
  name: 'Facebook Marketplace',
  country: null,
  currency: 'THB',
  domains: DOMAINS,
  defaultMode: 'user-browser',
  selectors: {
    'search.card': 'a[href*="/marketplace/item/"]',
    'search.title': '',
    'search.price': '',
    'search.location': '',
  },
  searchScript: SEARCH_SCRIPT,
  listingScript: LISTING_SCRIPT,
  searchUrl(query, opts) {
    return facebookSearchUrl(query, opts.city === undefined ? {} : { location: opts.city });
  },
  parseSearch(snap, ctx) {
    const doc = parseDocument(snap.html);
    const cardSelector = selectorFor(ctx, 'search.card');
    if (cardSelector === null) return [];
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const card of Array.from(doc.querySelectorAll(cardSelector))) {
      const url = canonicalFacebookUrl(card.getAttribute('href'));
      if (url === null || seen.has(url)) continue;
      const lines = textLines(card);
      const fields = fieldsFromLabel(card, ctx, lines) ?? fieldsFromLines(lines, ctx);
      const title = textOfPick(card, ctx, 'search.title') || fields.title;
      if (title === '') continue;
      seen.add(url);
      const ownPrice = textOfPick(card, ctx, 'search.price');
      const price = ownPrice === '' ? fields.price : priceOfLines([ownPrice], ctx.currency);
      const location = textOfPick(card, ctx, 'search.location') || fields.location;
      const hit: SearchHit = {
        site: ID,
        title,
        url,
        price,
        condition: guessCondition(title),
        stock: stockOfLines(lines),
        shop: null,
        seenAt: ctx.now,
      };
      if (location !== '') hit.raw = { location };
      hits.push(hit);
    }
    return hits;
  },
  parseListing(snap, ctx): Listing {
    const doc = parseDocument(snap.html);
    const lines = textLines(doc);
    const heading = normaliseText(doc.querySelector('h1')?.textContent);
    const title = heading || normaliseText(doc.querySelector('title')?.textContent);
    const listing: Listing = {
      site: ID,
      title,
      url: canonicalFacebookUrl(snap.url) ?? snap.url,
      price: priceOfLines(lines, ctx.currency),
      condition: conditionOfLines(lines) ?? guessCondition(title),
      stock: stockOfLines(lines),
      shop: null,
      seenAt: ctx.now,
      variants: [],
    };
    const listed = lines.findIndex((line) => /^listed\b.*\bin$/i.test(line));
    const location = listed === -1 ? '' : (lines[listed + 1] ?? '');
    if (location !== '') listing.raw = { location };
    return listing;
  },
  detectBlock(snap) {
    return detectBlockWith(snap, URL_BLOCKS, HTML_BLOCKS);
  },
  matchesUrl(url) {
    return hostMatches(url, DOMAINS) && /\/marketplace\//i.test(url);
  },
};
