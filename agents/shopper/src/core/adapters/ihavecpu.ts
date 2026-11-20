import { textLines } from '../card-text.js';
import { parsePrice } from '../money.js';
import {
  COMMON_BLOCK_PATTERNS,
  absoluteUrl,
  detectBlockWith,
  guessCondition,
  guessStock,
  hostMatches,
  normaliseText,
  parseDocument,
  pick,
  selectorFor,
  type BlockPattern,
} from '../html.js';
import {
  ShopperError,
  type Condition,
  type Listing,
  type PageSnapshot,
  type ParseCtx,
  type SearchHit,
  type SiteAdapter,
  type Stock,
  type Variant,
} from '../types.js';

const ID = 'ihavecpu';
const NAME = 'iHAVECPU';
const DOMAINS = ['ihavecpu.com'];
const ORIGIN = 'https://ihavecpu.com';

const URL_BLOCKS: BlockPattern[] = [];

const HTML_BLOCKS: BlockPattern[] = [
  { test: /<title>\s*(?:Just a moment|Attention Required)/i, reason: 'Cloudflare challenge page' },
  { test: /challenge-platform|cf-turnstile/i, reason: 'Cloudflare challenge page' },
  { test: /<title>\s*(?:Access denied|403 Forbidden)/i, reason: 'access denied' },
];

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? normaliseText(value) : '';
}

function pageProps(snap: PageSnapshot, ctx: ParseCtx): Json | null {
  const doc = parseDocument(snap.html);
  const selector = selectorFor(ctx, 'data.script') ?? 'script#__NEXT_DATA__';
  const text = doc.querySelector(selector)?.textContent ?? '';
  if (text.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ShopperError(`${NAME}: page data block is not valid JSON`);
  }
  const props = asRecord(asRecord(asRecord(parsed)?.props)?.pageProps);
  if (props === null) throw new ShopperError(`${NAME}: page data has no pageProps`);
  return props;
}

function hitsFromMarkup(snap: PageSnapshot, ctx: ParseCtx): SearchHit[] {
  const doc = parseDocument(snap.html);
  const cardSelector = selectorFor(ctx, 'search.card');
  if (cardSelector === null) return [];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const card of Array.from(doc.querySelectorAll(cardSelector))) {
    const url = absoluteUrl(card.getAttribute('href'), ORIGIN);
    const title = normaliseText(pick(card, ctx, 'search.title')?.textContent);
    if (url === null || title === '' || seen.has(url)) continue;
    seen.add(url);
    const own = normaliseText(pick(card, ctx, 'search.price')?.textContent);
    const text = /\d/.test(own) ? own : textLines(card).join(' ');
    const found = /฿\s*[\d,]+(?:\.\d+)?/.exec(text);
    const price = found === null ? null : parsePrice(found[0], ctx.currency);
    hits.push({
      site: ID,
      title,
      url,
      price: price?.min ?? null,
      condition: conditionOf(title),
      stock: 'unknown',
      shop: NAME,
      seenAt: ctx.now,
    });
  }
  return hits;
}

function slugOf(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-');
}

function productUrl(id: number, name: string, href: string | null): string {
  const fromHref = absoluteUrl(href, ORIGIN);
  if (fromHref !== null) return fromHref;
  return absoluteUrl(`/product/${id}/${slugOf(name)}`, ORIGIN) ?? `${ORIGIN}/product/${id}`;
}

function conditionOf(title: string): Condition {
  const guessed = guessCondition(title);
  return guessed === 'unknown' ? 'new' : guessed;
}

function stockFromCount(count: number | null): Stock {
  if (count === null) return 'unknown';
  return count > 0 ? 'in_stock' : 'out_of_stock';
}

export const ihavecpu: SiteAdapter = {
  id: ID,
  name: NAME,
  country: 'TH',
  currency: 'THB',
  domains: DOMAINS,
  defaultMode: 'http',
  selectors: {
    'data.script': 'script#__NEXT_DATA__',
    'search.card': 'div[href^="/product/"]',
    'search.link': 'a[href^="/product/"]',
    'search.title': 'h3',
    'search.price': 'span[font-size="16px"]',
  },
  searchUrl(query, opts) {
    const page = opts.page !== undefined && opts.page > 1 ? opts.page : 1;
    const base = `${ORIGIN}/product/search/${encodeURIComponent(query)}`;
    return page > 1 ? `${base}?page=${page}` : base;
  },
  parseSearch(snap, ctx) {
    const props = pageProps(snap, ctx);
    if (props === null) return hitsFromMarkup(snap, ctx);
    const doc = parseDocument(snap.html);
    const items = asList(asRecord(props.product)?.data);
    const linkSelector = selectorFor(ctx, 'search.link');
    const hrefs = new Map<number, string>();
    if (linkSelector !== null) {
      for (const link of Array.from(doc.querySelectorAll(linkSelector))) {
        const href = link.getAttribute('href') ?? '';
        const id = /^\/product\/(\d+)\//.exec(href)?.[1];
        if (id !== undefined && !hrefs.has(Number(id))) hrefs.set(Number(id), href);
      }
    }
    const hits: SearchHit[] = [];
    const seen = new Set<number>();
    for (const item of items) {
      const record = asRecord(item);
      if (record === null) continue;
      const id = asNumber(record.product_id ?? record.id);
      const title = asText(record.name_gb) || asText(record.name_th);
      const amount = asNumber(record.price_sale);
      if (id === null || title === '' || seen.has(id)) continue;
      seen.add(id);
      const before = asNumber(record.price_before);
      const hit: SearchHit = {
        site: ID,
        title,
        url: productUrl(id, title, hrefs.get(id) ?? null),
        price: amount === null ? null : { amount, currency: ctx.currency },
        condition: conditionOf(title),
        stock: stockFromCount(asNumber(record.stock)),
        shop: NAME,
        seenAt: ctx.now,
        raw: { productId: id },
      };
      const brand = asText(record.brand_name_th);
      if (brand !== '') hit.raw = { ...hit.raw, brand };
      if (before !== null && amount !== null && before > amount) {
        hit.raw = { ...hit.raw, priceBefore: before };
      }
      hits.push(hit);
    }
    return hits;
  },
  parseListing(snap, ctx): Listing {
    const props = pageProps(snap, ctx);
    if (props === null) throw new ShopperError(`${NAME}: listing data block not found`);
    const product = asRecord(props.product);
    if (product === null) throw new ShopperError(`${NAME}: listing data has no product`);
    const title = asText(product.name_gb) || asText(product.name_th);
    const amount = asNumber(product.price_sale) ?? asNumber(product.sell_price);
    const options = asList(product.stock)
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Json => entry !== null);
    const counts = options.map((entry) => asNumber(entry.stock)).filter((n) => n !== null);
    const total = counts.length === 0 ? null : counts.reduce((sum, n) => sum + n, 0);
    const label = asText(asRecord(product.status_text)?.text);
    const labelled = label === '' ? 'unknown' : guessStock(label);
    const stock = labelled === 'unknown' ? stockFromCount(total) : labelled;
    const url = new URL(snap.url);
    url.search = '';
    url.hash = '';
    const sku = asText(product.product_code);
    const before = asNumber(product.price_before);
    const listing: Listing = {
      site: ID,
      title,
      url: url.toString(),
      price: amount === null ? null : { amount, currency: ctx.currency },
      condition: conditionOf(title),
      stock,
      shop: NAME,
      seenAt: ctx.now,
      variants: [] as Variant[],
      raw: {},
    };
    const brand = asText(product.brand_name_th);
    if (brand !== '') listing.raw = { ...listing.raw, brand };
    if (sku !== '') listing.raw = { ...listing.raw, sku };
    if (total !== null) listing.raw = { ...listing.raw, stockCount: total };
    if (before !== null && amount !== null && before > amount) {
      listing.raw = { ...listing.raw, priceBefore: before };
    }
    return listing;
  },
  detectBlock(snap) {
    if (snap.html.includes('id="__NEXT_DATA__"')) return null;
    return detectBlockWith(snap, URL_BLOCKS, [...HTML_BLOCKS, ...COMMON_BLOCK_PATTERNS]);
  },
  matchesUrl(url) {
    return hostMatches(url, DOMAINS);
  },
};
