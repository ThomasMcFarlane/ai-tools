import type { Doc } from './html.js';
import type { Condition, Stock } from './types.js';

export interface JsonLdProduct {
  name: string | null;
  url: string | null;
  sku: string | null;
  brand: string | null;
  description: string | null;
  price: number | null;
  currency: string | null;
  stock: Stock;
  condition: Condition;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeIncludes(node: Json, type: string): boolean {
  const raw = node['@type'];
  return Array.isArray(raw) ? raw.includes(type) : raw === type;
}

function collect(value: unknown, into: Json[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
    return;
  }
  if (!isRecord(value)) return;
  into.push(value);
  collect(value['@graph'], into);
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = text(value);
  if (raw === null) return null;
  const parsed = Number(raw.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function stockFromAvailability(value: unknown): Stock {
  const raw = text(value);
  if (raw === null) return 'unknown';
  const key = raw.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase();
  if (key === 'instock' || key === 'onlineonly' || key === 'instoreonly') return 'in_stock';
  if (key === 'limitedavailability') return 'low_stock';
  if (key === 'outofstock' || key === 'soldout' || key === 'discontinued') return 'out_of_stock';
  if (key === 'preorder' || key === 'presale' || key === 'backorder') return 'preorder';
  return 'unknown';
}

export function conditionFromSchema(value: unknown): Condition {
  const raw = text(value);
  if (raw === null) return 'unknown';
  const key = raw.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase();
  if (key === 'newcondition') return 'new';
  if (key === 'usedcondition' || key === 'damagedcondition') return 'used';
  if (key === 'refurbishedcondition') return 'refurbished';
  return 'unknown';
}

function firstOffer(value: unknown): Json | null {
  const offers = Array.isArray(value) ? value : [value];
  for (const offer of offers) {
    if (isRecord(offer)) return offer;
  }
  return null;
}

export function readJsonLdProduct(doc: Doc): JsonLdProduct | null {
  const nodes: Json[] = [];
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      collect(JSON.parse(script.textContent ?? ''), nodes);
    } catch {
      continue;
    }
  }
  const product = nodes.find((node) => typeIncludes(node, 'Product'));
  if (product === undefined) return null;
  const offer = firstOffer(product['offers']);
  const brand = product['brand'];
  return {
    name: text(product['name']),
    url: text(product['url']) ?? (offer === null ? null : text(offer['url'])),
    sku: text(product['sku']),
    brand: isRecord(brand) ? text(brand['name']) : text(brand),
    description: text(product['description']),
    price: offer === null ? null : (numeric(offer['price']) ?? numeric(offer['lowPrice'])),
    currency: offer === null ? null : text(offer['priceCurrency']),
    stock: offer === null ? 'unknown' : stockFromAvailability(offer['availability']),
    condition: offer === null ? 'unknown' : conditionFromSchema(offer['itemCondition']),
  };
}
