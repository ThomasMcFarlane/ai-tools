import { parseHTML } from 'linkedom';
import { parsePrice } from './money.js';
import type { Condition, Listing, PageSnapshot, ParseCtx, SearchHit, Stock } from './types.js';

export type Doc = ReturnType<typeof parseHTML>['document'];
export type El = ReturnType<Doc['querySelector']> & object;

export function parseDocument(html: string): Doc {
  return parseHTML(html).document;
}

export function normaliseText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export function textOf(el: { textContent: string | null } | null | undefined): string {
  return normaliseText(el?.textContent);
}

export function absoluteUrl(href: string | null | undefined, base: string): string | null {
  if (href === null || href === undefined || href.trim() === '') return null;
  try {
    return new URL(href.trim(), base).toString();
  } catch {
    return null;
  }
}

export function selectorFor(ctx: ParseCtx, key: string): string | null {
  const selector = ctx.selectors[key];
  return selector === undefined || selector === '' ? null : selector;
}

export function pick(root: ParentNode, ctx: ParseCtx, key: string): El | null {
  const selector = selectorFor(ctx, key);
  if (selector === null) return null;
  return root.querySelector(selector) as El | null;
}

export function pickText(root: ParentNode, ctx: ParseCtx, key: string): string {
  return textOf(pick(root, ctx, key));
}

export function guessCondition(text: string): Condition {
  if (/\brefurbished\b|\brenewed\b|มือสองสภาพดี/i.test(text)) return 'refurbished';
  if (/\bused\b|\bsecond[- ]hand\b|มือสอง/i.test(text)) return 'used';
  if (/\bbrand new\b|\bnew\b|มือหนึ่ง/i.test(text)) return 'new';
  return 'unknown';
}

export function guessStock(text: string): Stock {
  if (/out of stock|sold out|สินค้าหมด|หมดชั่วคราว/i.test(text)) return 'out_of_stock';
  if (/pre-?order|พรีออเดอร์|สั่งจอง/i.test(text)) return 'preorder';
  if (/low stock|only \d+ left|เหลือน้อย/i.test(text)) return 'low_stock';
  if (/in stock|available|พร้อมส่ง|มีสินค้า/i.test(text)) return 'in_stock';
  return 'unknown';
}

export function parseSoldCount(text: string): number | null {
  const match = /([\d.,]+)\s*([kK]|พัน)?\s*(?:sold|ชิ้น|ขายแล้ว)/i.exec(text);
  if (match === null) return null;
  const base = Number((match[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  return match[2] === undefined ? base : base * 1000;
}

export function parseRating(text: string): number | null {
  const match = /\b([0-5](?:\.\d)?)\b/.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  return value >= 0 && value <= 5 ? value : null;
}

export interface CardOptions {
  cardKey?: string;
  titleKey?: string;
  linkKey?: string;
  priceKey?: string;
  shopKey?: string;
  stockKey?: string;
  ratingKey?: string;
  soldKey?: string;
  site: string;
  defaultStock?: Stock;
}

export function hitsFromCards(snap: PageSnapshot, ctx: ParseCtx, opts: CardOptions): SearchHit[] {
  const doc = parseDocument(snap.html);
  const cardSelector = selectorFor(ctx, opts.cardKey ?? 'search.card');
  if (cardSelector === null) return [];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const card of Array.from(doc.querySelectorAll(cardSelector))) {
    const linkEl =
      pick(card, ctx, opts.linkKey ?? 'search.link') ?? (card.matches?.('a') ? card : null);
    const url = absoluteUrl(linkEl?.getAttribute('href') ?? null, snap.url);
    const titleEl = pick(card, ctx, opts.titleKey ?? 'search.title');
    const title =
      normaliseText(titleEl?.getAttribute('title') ?? '') || textOf(titleEl) || textOf(linkEl);
    if (url === null || title === '' || seen.has(url)) continue;
    seen.add(url);
    const priceText = pickText(card, ctx, opts.priceKey ?? 'search.price');
    const price = priceText === '' ? null : parsePrice(priceText, ctx.currency);
    const stockText = opts.stockKey === undefined ? '' : pickText(card, ctx, opts.stockKey);
    const shop = opts.shopKey === undefined ? '' : pickText(card, ctx, opts.shopKey);
    const hit: SearchHit = {
      site: opts.site,
      title,
      url,
      price: price?.min ?? null,
      condition: guessCondition(title),
      stock: stockText === '' ? (opts.defaultStock ?? 'unknown') : guessStock(stockText),
      shop: shop === '' ? null : shop,
      seenAt: ctx.now,
    };
    if (price?.max !== undefined && price.max !== null) hit.priceMax = price.max;
    const ratingText = opts.ratingKey === undefined ? '' : pickText(card, ctx, opts.ratingKey);
    if (ratingText !== '') hit.rating = parseRating(ratingText);
    const soldText = opts.soldKey === undefined ? '' : pickText(card, ctx, opts.soldKey);
    if (soldText !== '') hit.sold = parseSoldCount(soldText);
    hits.push(hit);
  }
  return hits;
}

export function listingFromSelectors(snap: PageSnapshot, ctx: ParseCtx, site: string): Listing {
  const doc = parseDocument(snap.html);
  const title =
    pickText(doc, ctx, 'listing.title') ||
    textOf(doc.querySelector('h1')) ||
    textOf(doc.querySelector('title'));
  const priceText = pickText(doc, ctx, 'listing.price');
  const price = priceText === '' ? null : parsePrice(priceText, ctx.currency);
  const stockText = pickText(doc, ctx, 'listing.stock');
  const shop = pickText(doc, ctx, 'listing.shop');
  const listing: Listing = {
    site,
    title,
    url: snap.url,
    price: price?.min ?? null,
    condition: guessCondition(title),
    stock: stockText === '' ? 'unknown' : guessStock(stockText),
    shop: shop === '' ? null : shop,
    seenAt: ctx.now,
    variants: [],
  };
  if (price?.max !== undefined && price.max !== null) listing.priceMax = price.max;
  return listing;
}

export interface BlockPattern {
  test: RegExp;
  reason: string;
}

export const COMMON_BLOCK_PATTERNS: BlockPattern[] = [
  { test: /captcha|recaptcha|hcaptcha/i, reason: 'captcha page' },
  { test: /verify (that )?you are (a )?human|are you a robot/i, reason: 'human verification page' },
  { test: /access denied|request blocked|forbidden/i, reason: 'access denied' },
  { test: /unusual traffic|too many requests/i, reason: 'rate limited' },
];

const MAX_BLOCK_PAGE_BYTES = 60_000;

export function detectBlockWith(
  snap: PageSnapshot,
  urlPatterns: BlockPattern[],
  htmlPatterns: BlockPattern[] = COMMON_BLOCK_PATTERNS,
): string | null {
  for (const pattern of urlPatterns) {
    if (pattern.test.test(snap.url)) return pattern.reason;
  }
  if (snap.html.length > MAX_BLOCK_PAGE_BYTES) return null;
  const head = snap.html;
  for (const pattern of htmlPatterns) {
    if (pattern.test.test(head)) return pattern.reason;
  }
  return null;
}

export function hostMatches(url: string, domains: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
