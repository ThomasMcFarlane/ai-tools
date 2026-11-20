import {
  absoluteUrl,
  detectBlockWith,
  guessCondition,
  hostMatches,
  normaliseText,
  parseDocument,
  parseRating,
  parseSoldCount,
  pick,
  pickText,
  selectorFor,
  textOf,
  type BlockPattern,
  type Doc,
  type El,
} from '../html.js';
import { parsePrice } from '../money.js';
import type {
  Condition,
  Listing,
  ParseCtx,
  SearchHit,
  SiteAdapter,
  Stock,
  Variant,
} from '../types.js';

const ID = 'lazada-th';
const DOMAINS = ['lazada.co.th'];

const URL_BLOCKS: BlockPattern[] = [
  { test: /punish|captcha|\/sec\//i, reason: 'captcha (punish page)' },
];
const HTML_BLOCKS: BlockPattern[] = [
  { test: /_____tmd_____|punish|baxia|slide to verify/i, reason: 'captcha (punish page)' },
  { test: /captcha/i, reason: 'captcha page' },
];

const LISTING_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (el) => ((el && el.textContent) || '').replace(/\\s+/g, ' ').trim();
  const fields =
    (window.__moduleData__ && window.__moduleData__.data && window.__moduleData__.data.root && window.__moduleData__.data.root.fields) || {};
  const skuBase = (fields.productOption && fields.productOption.skuBase) || {};
  const infos = fields.skuInfos || {};
  const properties = skuBase.properties || [];
  const price = () => text(document.querySelector('[class*="pdp-v2-product-price-content-salePrice-amount"]'));
  const groupFor = (name) =>
    Array.from(document.querySelectorAll('[class*="sku-prop-selection"]')).find((g) => text(g.querySelector('h6')).replace(/:$/, '') === name);
  const out = { base: price(), skus: [] };
  for (const sku of (skuBase.skus || []).slice(0, 40)) {
    const options = {};
    for (const part of String(sku.propPath || '').split(',')) {
      const [pid, vid] = part.split(':');
      const property = properties.find((p) => String(p.pid) === pid);
      const value = property && (property.values || []).find((v) => String(v.vid) === vid);
      if (property && value) options[property.name] = value.name;
    }
    for (const [name, value] of Object.entries(options)) {
      const group = groupFor(name);
      const leaf = group && Array.from(group.querySelectorAll('span, div')).find((e) => e.children.length === 0 && text(e) === value);
      if (leaf) leaf.click();
      await sleep(350);
    }
    const info = infos[sku.skuId] || {};
    out.skus.push({ skuId: sku.skuId, options, price: price(), disabled: !!(info.operation && info.operation.disable) });
  }
  const info = Object.values(infos)[0];
  out.disabled = !!(info && info.operation && info.operation.disable);
  return out;
})()`;

interface LazadaSku {
  skuId?: string;
  options?: Record<string, string>;
  price?: string;
  disabled?: boolean;
}

interface LazadaData {
  base?: string;
  disabled?: boolean;
  skus?: LazadaSku[];
}

export function canonicalLazadaUrl(href: string | null | undefined, base: string): string | null {
  const absolute = absoluteUrl(href, base);
  if (absolute === null) return null;
  const url = new URL(absolute);
  url.protocol = 'https:';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function cleanTitle(text: string): string {
  return normaliseText(text.replace(/\uFFFC/g, ''));
}

function conditionOf(title: string): Condition {
  const guessed = guessCondition(title);
  return guessed === 'unknown' ? 'new' : guessed;
}

function leafTexts(card: ParentNode): string[] {
  const texts: string[] = [];
  for (const el of Array.from(card.querySelectorAll('span'))) {
    if (el.children.length === 0) {
      const text = textOf(el);
      if (text !== '') texts.push(text);
    }
  }
  return texts;
}

const PRICE_TEXT = /^฿\s*\d[\d,]*(?:\.\d+)?$/;

function priceCandidates(card: El, ctx: ParseCtx): string[] {
  const selector = selectorFor(ctx, 'search.price');
  if (selector === null) return [];
  return Array.from(card.querySelectorAll(selector)).map((el) => textOf(el));
}

function parseCard(card: El, ctx: ParseCtx, baseUrl: string): SearchHit | null {
  const link = pick(card, ctx, 'search.link');
  const url = canonicalLazadaUrl(link?.getAttribute('href') ?? null, baseUrl);
  const title = cleanTitle(link?.getAttribute('title') ?? '') || cleanTitle(textOf(link));
  if (url === null || title === '') return null;
  const leaves = leafTexts(card);
  const priceText = priceCandidates(card, ctx).find((text) => PRICE_TEXT.test(text)) ?? '';
  const price = priceText === '' ? null : parsePrice(priceText, ctx.currency);
  const soldText = leaves.find((text) => /^[\d.,]+\s*[kK]?\s*ชิ้น$/.test(text)) ?? '';
  const location = pickText(card, ctx, 'search.location');
  const hit: SearchHit = {
    site: ID,
    title,
    url,
    price: price?.min ?? null,
    condition: conditionOf(title),
    stock: 'unknown',
    shop: null,
    seenAt: ctx.now,
  };
  if (price?.max !== undefined && price.max !== null) hit.priceMax = price.max;
  if (soldText !== '') hit.sold = parseSoldCount(soldText);
  const raw: Record<string, unknown> = {};
  const itemId = card.getAttribute('data-item-id');
  if (itemId) raw.itemId = itemId;
  if (location !== '') raw.location = location;
  if (Object.keys(raw).length > 0) hit.raw = raw;
  return hit;
}

function stockOf(data: LazadaData | null | undefined, variants: Variant[], doc: Doc): Stock {
  if (variants.length > 0) {
    return variants.some((variant) => variant.stock === 'in_stock') ? 'in_stock' : 'out_of_stock';
  }
  if (data?.disabled === true) return 'out_of_stock';
  if (data?.disabled === false) return 'in_stock';
  return /สินค้าหมด|out of stock/i.test(textOf(doc.body)) ? 'out_of_stock' : 'unknown';
}

export const lazadaTh: SiteAdapter = {
  id: ID,
  name: 'Lazada Thailand',
  country: 'TH',
  currency: 'THB',
  domains: DOMAINS,
  defaultMode: 'headless',
  selectors: {
    'search.card': '[data-qa-locator="product-item"]',
    'search.link': 'a[title]',
    'search.price': 'span',
    'search.location': 'span[title]',
    'listing.title': 'h1',
    'listing.price': '[class*="pdp-v2-product-price-content-salePrice-amount"]',
    'listing.shop': '[class*="seller-name-v2__detail-name"]',
    'listing.rating': '[class*="score-average"]',
  },
  listingScript: LISTING_SCRIPT,
  searchUrl(query, opts) {
    const url = new URL('https://www.lazada.co.th/catalog/');
    url.searchParams.set('q', query);
    if (opts.page !== undefined && opts.page > 1) url.searchParams.set('page', String(opts.page));
    return url.toString();
  },
  parseSearch(snap, ctx) {
    const doc = parseDocument(snap.html);
    const cardSelector = selectorFor(ctx, 'search.card');
    if (cardSelector === null) return [];
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const card of Array.from(doc.querySelectorAll(cardSelector))) {
      const hit = parseCard(card as El, ctx, snap.url);
      if (hit === null || seen.has(hit.url)) continue;
      seen.add(hit.url);
      hits.push(hit);
    }
    return hits;
  },
  parseListing(snap, ctx) {
    const doc = parseDocument(snap.html);
    const data = snap.data as LazadaData | null | undefined;
    const title = pickText(doc, ctx, 'listing.title') || textOf(doc.querySelector('title'));
    const variants: Variant[] = [];
    for (const sku of data?.skus ?? []) {
      const options = sku.options ?? {};
      if (Object.keys(options).length === 0) continue;
      const price = parsePrice(sku.price ?? '', ctx.currency);
      variants.push({
        name: Object.values(options).join(' / '),
        options,
        price: price?.min ?? null,
        stock: sku.disabled === true ? 'out_of_stock' : 'in_stock',
        sku: sku.skuId ?? null,
      });
    }
    const priceText = pickText(doc, ctx, 'listing.price') || (data?.base ?? '');
    const base = priceText === '' ? null : parsePrice(priceText, ctx.currency);
    const prices = variants.flatMap((variant) =>
      variant.price === null ? [] : [variant.price.amount],
    );
    const listing: Listing = {
      site: ID,
      title,
      url: canonicalLazadaUrl(snap.url, snap.url) ?? snap.url,
      price: base?.min ?? null,
      condition: conditionOf(title),
      stock: stockOf(data, variants, doc),
      shop: pickText(doc, ctx, 'listing.shop') || null,
      seenAt: ctx.now,
      variants,
    };
    if (prices.length > 0) {
      const low = Math.min(...prices);
      const high = Math.max(...prices);
      listing.price = { amount: low, currency: ctx.currency };
      if (high > low) listing.priceMax = { amount: high, currency: ctx.currency };
    }
    const ratingText = pickText(doc, ctx, 'listing.rating');
    if (ratingText !== '') listing.rating = parseRating(ratingText);
    return listing;
  },
  detectBlock(snap) {
    return detectBlockWith(snap, URL_BLOCKS, HTML_BLOCKS);
  },
  matchesUrl(url) {
    return hostMatches(url, DOMAINS);
  },
};
