import {
  absoluteUrl,
  COMMON_BLOCK_PATTERNS,
  detectBlockWith,
  hostMatches,
  listingFromSelectors,
  normaliseText,
  parseDocument,
  pick,
  pickText,
  selectorFor,
  textOf,
  type BlockPattern,
} from '../html.js';
import { parsePrice } from '../money.js';
import { readJsonLdProduct } from '../product-jsonld.js';
import type { Listing, SearchHit, SiteAdapter, Stock } from '../types.js';

const ID = 'advice';
const NAME = 'Advice IT';
const DOMAINS = ['advice.co.th'];

const URL_BLOCKS: BlockPattern[] = [];
const HTML_BLOCKS: BlockPattern[] = [
  ...COMMON_BLOCK_PATTERNS,
  {
    test: /<title>\s*(?:just a moment|attention required|access denied)/i,
    reason: 'access denied',
  },
  { test: /id="challenge-form"|cf-chl-/i, reason: 'captcha page' },
];

const SEARCH_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const count = () => document.querySelectorAll('.col-product-list').length;
  for (let wait = 0; wait < 40 && count() === 0; wait += 1) await sleep(250);
  let clicks = 0;
  for (let round = 0; round < 4; round += 1) {
    const button = document.querySelector('.showproduct-more');
    if (!button || count() === 0) break;
    const before = count();
    button.click();
    clicks += 1;
    for (let wait = 0; wait < 20 && count() === before; wait += 1) await sleep(250);
  }
  return { clicks, cards: count() };
})()`;

export function adviceStock(text: string): Stock {
  if (/สินค้าหมด|หมดชั่วคราว|out of stock|sold out/i.test(text)) return 'out_of_stock';
  if (/สำรองสิทธิ์|by ?order|pre-?order|พรีออเดอร์|สั่งจอง/i.test(text)) return 'preorder';
  if (/ซื้อเลย|add cart|เพิ่มลงตะกร้า|พร้อมส่ง/i.test(text)) return 'in_stock';
  return 'unknown';
}

export const advice: SiteAdapter = {
  id: ID,
  name: NAME,
  country: 'TH',
  currency: 'THB',
  domains: DOMAINS,
  defaultMode: 'headless',
  selectors: {
    'search.card': '.col-product-list',
    'search.link': 'a.fn-name',
    'search.title': 'a.fn-name',
    'search.price': '.item-price-sale',
    'search.normalPrice': '.item-price-srp del',
    'search.stock': '.item-btn-add-cart',
    'search.shipping': '.item-shipping',
    'listing.title': 'h1',
    'listing.price': '.product-price-save .item-price',
    'listing.stock': '.btn-add-cart-2',
  },
  searchScript: SEARCH_SCRIPT,
  searchUrl(query, opts) {
    const page = opts.page !== undefined && opts.page > 1 ? opts.page : 1;
    const url = new URL('https://www.advice.co.th/product/search');
    url.searchParams.set('keyword', query);
    if (page > 1) url.searchParams.set('page', String(page));
    return url.toString();
  },
  parseSearch(snap, ctx) {
    const doc = parseDocument(snap.html);
    const cardSelector = selectorFor(ctx, 'search.card');
    if (cardSelector === null) return [];
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const card of Array.from(doc.querySelectorAll(cardSelector))) {
      const linkEl = pick(card, ctx, 'search.link');
      const url = absoluteUrl(linkEl?.getAttribute('href') ?? null, snap.url);
      const titleEl = pick(card, ctx, 'search.title');
      const title = textOf(titleEl) || normaliseText(linkEl?.getAttribute('title') ?? '');
      if (url === null || title === '' || seen.has(url)) continue;
      seen.add(url);
      const priceText = pickText(card, ctx, 'search.price');
      const price = priceText === '' ? null : parsePrice(priceText, ctx.currency);
      const normalText = pickText(card, ctx, 'search.normalPrice');
      const normal = normalText === '' ? null : parsePrice(normalText, ctx.currency);
      const stockText = pickText(card, ctx, 'search.stock');
      const shippingText = pickText(card, ctx, 'search.shipping');
      const hit: SearchHit = {
        site: ID,
        title,
        url,
        price: price?.min ?? null,
        condition: 'new',
        stock: adviceStock(stockText),
        shop: NAME,
        seenAt: ctx.now,
      };
      const raw: Record<string, unknown> = {};
      if (normal !== null) raw['normalPrice'] = normal.min.amount;
      if (stockText !== '') raw['stockText'] = stockText;
      if (shippingText !== '') raw['shippingText'] = shippingText;
      if (Object.keys(raw).length > 0) hit.raw = raw;
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
        listing.stock = adviceStock(pickText(doc, ctx, 'listing.stock'));
      return listing;
    }
    if (product.name !== null) listing.title = product.name;
    if (product.price !== null) {
      listing.price = { amount: product.price, currency: product.currency ?? ctx.currency };
    }
    listing.stock =
      product.stock === 'unknown'
        ? adviceStock(pickText(doc, ctx, 'listing.stock'))
        : product.stock;
    listing.url = absoluteUrl(product.url, snap.url) ?? snap.url;
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
