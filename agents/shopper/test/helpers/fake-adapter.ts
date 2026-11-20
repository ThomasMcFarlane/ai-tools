import { absoluteUrl, normaliseText, parseDocument, selectorFor } from '../../src/core/html.js';
import { parsePrice } from '../../src/core/money.js';
import type {
  Condition,
  FetchMode,
  Listing,
  PageSnapshot,
  ParseCtx,
  SearchHit,
  SiteAdapter,
} from '../../src/core/types.js';

const CONDITION = /\b(used|refurbished)\b/i;

function conditionOf(text: string): Condition {
  const match = CONDITION.exec(text);
  return match === null ? 'new' : (match[1]?.toLowerCase() as Condition);
}

function parseSearch(id: string, snap: PageSnapshot, ctx: ParseCtx): SearchHit[] {
  const doc = parseDocument(snap.html);
  const hits: SearchHit[] = [];
  for (const card of Array.from(doc.querySelectorAll(selectorFor(ctx, 'search.card') ?? '.card'))) {
    const link = card.querySelector(selectorFor(ctx, 'search.link') ?? 'a');
    const url = absoluteUrl(link?.getAttribute('href'), snap.url);
    const title = normaliseText(link?.textContent);
    const priceText = normaliseText(
      card.querySelector(selectorFor(ctx, 'search.price') ?? '.pr')?.textContent,
    );
    const price = parsePrice(priceText, ctx.currency);
    if (url === null || title === '') continue;
    hits.push({
      site: id,
      title,
      url,
      price: price?.min ?? null,
      condition: conditionOf(title),
      stock: 'in_stock',
      seenAt: ctx.now,
    });
  }
  return hits;
}

function parseListing(id: string, snap: PageSnapshot, ctx: ParseCtx): Listing {
  const doc = parseDocument(snap.html);
  const title = normaliseText(doc.querySelector('h1')?.textContent);
  return {
    site: id,
    title,
    url: snap.url,
    price: null,
    condition: conditionOf(title),
    stock: 'unknown',
    seenAt: ctx.now,
    variants: [],
  };
}

export function fakeAdapter(id: string, mode: FetchMode): SiteAdapter {
  return {
    id,
    name: id,
    country: null,
    currency: 'THB',
    domains: [`${id}.example.com`],
    defaultMode: mode,
    selectors: {
      'search.card': '.card',
      'search.link': 'a.t',
      'search.title': 'a.t',
      'search.price': '.pr',
    },
    searchUrl: (query) => `https://${id}.example.com/s?q=${encodeURIComponent(query)}`,
    matchesUrl: (url) => url.includes(`${id}.example.com`),
    detectBlock: (snap) => (snap.html.includes('CAPTCHA') ? 'captcha page' : null),
    parseSearch: (snap, ctx) => parseSearch(id, snap, ctx),
    parseListing: (snap, ctx) => parseListing(id, snap, ctx),
  };
}
