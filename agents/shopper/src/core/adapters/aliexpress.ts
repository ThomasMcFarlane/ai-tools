import {
  absoluteUrl,
  detectBlockWith,
  guessCondition,
  hostMatches,
  normaliseText,
  parseDocument,
  parseRating,
  parseSoldCount,
  pickText,
  selectorFor,
  textOf,
  type BlockPattern,
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

const ID = 'aliexpress';
const DOMAINS = ['aliexpress.com'];

const URL_BLOCKS: BlockPattern[] = [
  { test: /_____tmd_____|punish|captcha|x5secdata/i, reason: 'captcha (punish page)' },
];
const HTML_BLOCKS: BlockPattern[] = [
  { test: /_____tmd_____|x5secdata|punish|slide to verify/i, reason: 'captcha (punish page)' },
  { test: /captcha/i, reason: 'captcha page' },
];

const SEARCH_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 6; i += 1) {
    window.scrollBy(0, window.innerHeight);
    await sleep(500);
  }
  window.scrollTo(0, 0);
  return { scrolled: true };
})()`;

const LISTING_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (el) => ((el && el.textContent) || '').replace(/\\s+/g, ' ').trim();
  const price = () => text(document.querySelector('[class*="price-default--current"]'));
  const groups = Array.from(document.querySelectorAll('[class*="sku-item--property"]')).map((group) => ({
    name: text(group.querySelector('[class*="sku-item--title"]')).split(':')[0].trim(),
    items: Array.from(group.querySelectorAll('[class*="sku-item--image"], [class*="sku-item--text"]')).map((item) => {
      const img = item.querySelector('img');
      const label = (item.getAttribute('title') || text(item) || (img && img.alt) || '').trim();
      return { el: item, label, soldOut: /disabled|soldout|sold-out|unavailable/i.test(String(item.className)) };
    }),
  })).filter((group) => group.items.length > 0);
  let combos = [[]];
  for (const group of groups) {
    const next = [];
    for (const combo of combos) for (const item of group.items) next.push([...combo, { group: group.name, item }]);
    combos = next.slice(0, 40);
  }
  const out = { base: price(), skus: [] };
  for (const combo of combos) {
    const options = {};
    let soldOut = false;
    for (const { group, item } of combo) {
      item.el.click();
      await sleep(400);
      options[group || 'option'] = item.label;
      soldOut = soldOut || item.soldOut;
    }
    out.skus.push({ options, price: soldOut ? '' : price(), soldOut });
  }
  return out;
})()`;

interface AliSku {
  options?: Record<string, string>;
  price?: string;
  soldOut?: boolean;
}

interface AliData {
  base?: string;
  skus?: AliSku[];
  groups?: Array<{ name?: string; options?: Array<{ label?: string; price?: string }> }>;
}

function skusOf(data: AliData | null | undefined): AliSku[] {
  if (data?.skus !== undefined) return data.skus;
  return (data?.groups ?? []).flatMap((group) =>
    (group.options ?? []).map((option) => ({
      options: { [group.name ?? '']: option.label ?? '' },
      price: option.price ?? '',
    })),
  );
}

export function canonicalAliexpressUrl(
  href: string | null | undefined,
  base: string,
): string | null {
  const absolute = absoluteUrl(href, base);
  if (absolute === null) return null;
  const id = /\/item\/(?:[^/]*\/)?(\d{6,})\.html/.exec(new URL(absolute).pathname)?.[1];
  return id === undefined ? null : `https://www.aliexpress.com/item/${id}.html`;
}

function conditionOf(title: string): Condition {
  const guessed = guessCondition(title);
  return guessed === 'unknown' ? 'new' : guessed;
}

function leafTexts(card: ParentNode): string[] {
  const texts: string[] = [];
  for (const el of Array.from(card.querySelectorAll('span, strong'))) {
    if (el.children.length === 0) {
      const text = textOf(el);
      if (text !== '') texts.push(text);
    }
  }
  return texts;
}

const PRICE_TEXT = /^(?:฿|US\s*\$|\$|€|£)\s*\d[\d,]*(?:\.\d+)?$/;

function priceCandidates(card: El, ctx: ParseCtx): string[] {
  const selector = selectorFor(ctx, 'search.price');
  if (selector === null) return [];
  return Array.from(card.querySelectorAll(selector)).map((el) => textOf(el));
}

function parseCard(card: El, ctx: ParseCtx, baseUrl: string): SearchHit | null {
  const url = canonicalAliexpressUrl(card.getAttribute('href'), baseUrl);
  const title = pickText(card, ctx, 'search.title');
  if (url === null || title === '') return null;
  const leaves = leafTexts(card);
  const priceText = priceCandidates(card, ctx).find((text) => PRICE_TEXT.test(text)) ?? '';
  const price = priceText === '' ? null : parsePrice(priceText, ctx.currency);
  const soldText = leaves.find((text) => /\bsold$/i.test(text)) ?? '';
  const ratingText = pickText(card, ctx, 'search.rating');
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
  if (soldText !== '') hit.sold = parseSoldCount(soldText.replace(/\+/g, ''));
  if (ratingText !== '') hit.rating = parseRating(ratingText);
  if (leaves.some((text) => /^free shipping$/i.test(text))) {
    hit.shipping = { amount: 0, currency: hit.price?.currency ?? ctx.currency };
  }
  return hit;
}

function stockOf(variants: Variant[]): Stock {
  if (variants.length === 0) return 'unknown';
  return variants.some((variant) => variant.stock === 'in_stock') ? 'in_stock' : 'out_of_stock';
}

export const aliexpress: SiteAdapter = {
  id: ID,
  name: 'AliExpress',
  country: null,
  currency: 'THB',
  domains: DOMAINS,
  defaultMode: 'headless',
  selectors: {
    'search.card': 'a.search-card-item[href*="/item/"]',
    'search.title': 'h3',
    'search.price': 'span, strong',
    'search.rating': '[class*="starRating"]',
    'listing.title': 'h1',
    'listing.price': '[class*="price-default--current"]',
    'listing.shop': '[data-pl="store-name"], [class*="store-detail--storeName"]',
  },
  searchScript: SEARCH_SCRIPT,
  listingScript: LISTING_SCRIPT,
  searchUrl(query, opts) {
    const url = new URL('https://www.aliexpress.com/wholesale');
    url.searchParams.set('SearchText', query);
    if (opts.page !== undefined && opts.page > 1) url.searchParams.set('page', String(opts.page));
    return url.toString();
  },
  cookies({ currency }) {
    if (currency !== 'THB') return [];
    return [
      {
        name: 'aep_usuc_f',
        value: 'site=glo&c_tp=THB&region=TH&b_locale=en_US',
        domain: '.aliexpress.com',
      },
    ];
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
    const data = snap.data as AliData | null | undefined;
    const title = pickText(doc, ctx, 'listing.title') || textOf(doc.querySelector('title'));
    const variants: Variant[] = [];
    for (const sku of skusOf(data)) {
      const options: Record<string, string> = {};
      for (const [name, label] of Object.entries(sku.options ?? {})) {
        const clean = normaliseText(label);
        if (clean !== '') options[normaliseText(name) || 'option'] = clean;
      }
      if (Object.keys(options).length === 0) continue;
      const price = sku.soldOut === true ? null : parsePrice(sku.price ?? '', ctx.currency);
      variants.push({
        name: Object.values(options).join(' / '),
        options,
        price: price?.min ?? null,
        stock: sku.soldOut === true ? 'out_of_stock' : 'in_stock',
      });
    }
    const priceText = pickText(doc, ctx, 'listing.price') || (data?.base ?? '');
    const base = priceText === '' ? null : parsePrice(priceText, ctx.currency);
    const listing: Listing = {
      site: ID,
      title,
      url: canonicalAliexpressUrl(snap.url, snap.url) ?? snap.url,
      price: base?.min ?? null,
      condition: conditionOf(title),
      stock: stockOf(variants),
      shop: pickText(doc, ctx, 'listing.shop') || null,
      seenAt: ctx.now,
      variants,
    };
    const prices = variants.flatMap((variant) =>
      variant.price === null ? [] : [variant.price.amount],
    );
    if (prices.length > 0) {
      const low = Math.min(...prices);
      const high = Math.max(...prices);
      listing.price = { amount: low, currency: base?.min.currency ?? ctx.currency };
      if (high > low) listing.priceMax = { amount: high, currency: listing.price.currency };
    }
    return listing;
  },
  detectBlock(snap) {
    return detectBlockWith(snap, URL_BLOCKS, HTML_BLOCKS);
  },
  matchesUrl(url) {
    return hostMatches(url, DOMAINS);
  },
};
