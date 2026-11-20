import {
  absoluteUrl,
  COMMON_BLOCK_PATTERNS,
  detectBlockWith,
  hostMatches,
  listingFromSelectors,
  normaliseText,
  parseDocument,
  parseSoldCount,
  pick,
  pickText,
  selectorFor,
  textOf,
  type BlockPattern,
} from '../html.js';
import { parsePrice } from '../money.js';
import { readJsonLdProduct } from '../product-jsonld.js';
import type { Listing, SearchHit, SiteAdapter, Stock } from '../types.js';

const ID = 'jib';
const NAME = 'JIB';
const DOMAINS = ['jib.co.th'];
const PAGE_SIZE = 100;

const URL_BLOCKS: BlockPattern[] = [];
const HTML_BLOCKS: BlockPattern[] = [
  ...COMMON_BLOCK_PATTERNS,
  {
    test: /<title>\s*(?:just a moment|attention required|access denied)/i,
    reason: 'access denied',
  },
  { test: /id="challenge-form"|cf-chl-/i, reason: 'captcha page' },
];

export function jibStock(text: string): Stock {
  if (/หมด|out of stock|sold out/i.test(text)) return 'out_of_stock';
  if (/พรีออเดอร์|สั่งจอง|pre-?order/i.test(text)) return 'preorder';
  if (/ซื้อเลย|หยิบใส่|พร้อมส่ง|มีสินค้า|add to cart|in stock/i.test(text)) return 'in_stock';
  return 'unknown';
}

export function canonicalJibUrl(href: string | null | undefined, base: string): string | null {
  const absolute = absoluteUrl(href, base);
  if (absolute === null) return null;
  const match = /\/web\/(?:index\.php\/)?product\/readProduct\/(\d+)/i.exec(absolute);
  return match === null ? absolute : `https://www.jib.co.th/web/product/readProduct/${match[1]}`;
}

export const jib: SiteAdapter = {
  id: ID,
  name: NAME,
  country: 'TH',
  currency: 'THB',
  domains: DOMAINS,
  defaultMode: 'http',
  selectors: {
    'search.card': '.divboxpro',
    'search.link': 'a[href*="/readProduct/"]',
    'search.title': '.promo_name',
    'search.price': '.price_total',
    'search.normalPrice': '.boxprice .price',
    'search.stock': '.buy_promo',
    'search.stats': '.boxprice',
    'listing.title': 'h1',
    'listing.price': '.price_block',
    'listing.stock': '.out_stock, .cart_modal',
  },
  searchUrl(query, opts) {
    const page = opts.page !== undefined && opts.page > 1 ? opts.page : 1;
    const offset = (page - 1) * PAGE_SIZE;
    return `https://www.jib.co.th/web/product/product_search/${offset}?str_search=${encodeURIComponent(query)}`;
  },
  parseSearch(snap, ctx) {
    const doc = parseDocument(snap.html);
    const cardSelector = selectorFor(ctx, 'search.card');
    if (cardSelector === null) return [];
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const card of Array.from(doc.querySelectorAll(cardSelector))) {
      const linkEl = pick(card, ctx, 'search.link');
      const url = canonicalJibUrl(linkEl?.getAttribute('href') ?? null, snap.url);
      const titleEl = pick(card, ctx, 'search.title');
      const title = textOf(titleEl) || normaliseText(linkEl?.getAttribute('title') ?? '');
      if (url === null || title === '' || seen.has(url)) continue;
      seen.add(url);
      const priceText = pickText(card, ctx, 'search.price');
      const price = priceText === '' ? null : parsePrice(priceText, ctx.currency);
      const normalText = pickText(card, ctx, 'search.normalPrice');
      const normal = normalText === '' ? null : parsePrice(normalText, ctx.currency);
      const stockText = pickText(card, ctx, 'search.stock');
      const hit: SearchHit = {
        site: ID,
        title,
        url,
        price: price?.min ?? null,
        condition: 'new',
        stock: jibStock(stockText),
        shop: NAME,
        seenAt: ctx.now,
      };
      const sold = parseSoldCount(pickText(card, ctx, 'search.stats'));
      if (sold !== null) hit.sold = sold;
      if (normal !== null) hit.raw = { normalPrice: normal.min.amount, stockText };
      else if (stockText !== '') hit.raw = { stockText };
      hits.push(hit);
    }
    return hits;
  },
  parseListing(snap, ctx): Listing {
    const doc = parseDocument(snap.html);
    const base = listingFromSelectors(snap, ctx, ID);
    const product = readJsonLdProduct(doc);
    const listing: Listing = { ...base, condition: 'new', shop: NAME };
    if (product === null) {
      if (listing.stock === 'unknown')
        listing.stock = jibStock(pickText(doc, ctx, 'listing.stock'));
      return listing;
    }
    if (product.name !== null) listing.title = product.name;
    if (product.price !== null) {
      listing.price = { amount: product.price, currency: product.currency ?? ctx.currency };
    }
    if (product.stock !== 'unknown') listing.stock = product.stock;
    else listing.stock = jibStock(pickText(doc, ctx, 'listing.stock'));
    listing.url = canonicalJibUrl(product.url ?? snap.url, snap.url) ?? snap.url;
    if (product.description !== null) listing.description = product.description;
    if (product.sku !== null) listing.raw = { sku: product.sku, brand: product.brand };
    return listing;
  },
  detectBlock(snap) {
    return detectBlockWith(snap, URL_BLOCKS, HTML_BLOCKS);
  },
  matchesUrl(url) {
    return hostMatches(url, DOMAINS);
  },
};
