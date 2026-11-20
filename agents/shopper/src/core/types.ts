export type FetchMode = 'http' | 'headless' | 'user-browser';
export type Condition = 'new' | 'used' | 'refurbished' | 'unknown';
export type Stock = 'in_stock' | 'low_stock' | 'out_of_stock' | 'preorder' | 'unknown';

export const FETCH_MODES: readonly FetchMode[] = ['http', 'headless', 'user-browser'];
export const CONDITIONS: readonly Condition[] = ['new', 'used', 'refurbished', 'unknown'];

export interface Money {
  amount: number;
  currency: string;
}

export interface SearchHit {
  site: string;
  title: string;
  url: string;
  price: Money | null;
  priceMax?: Money | null;
  condition: Condition;
  stock: Stock;
  shop?: string | null;
  shipping?: Money | null;
  rating?: number | null;
  sold?: number | null;
  seenAt: string;
  raw?: Record<string, unknown>;
}

export interface Variant {
  name: string;
  options: Record<string, string>;
  price: Money | null;
  stock: Stock;
  sku?: string | null;
}

export interface Listing extends SearchHit {
  variants: Variant[];
  shippingNote?: string | null;
  description?: string | null;
}

export interface PageSnapshot {
  url: string;
  html: string;
  data?: unknown;
  fetchedAt: string;
  mode: FetchMode;
}

export interface ParseCtx {
  selectors: Record<string, string>;
  now: string;
  currency: string;
}

export interface FetchCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

export interface SiteAdapter {
  id: string;
  name: string;
  country: string | null;
  currency: string;
  domains: string[];
  defaultMode: FetchMode;
  selectors: Record<string, string>;
  searchUrl(query: string, opts: { page?: number }): string;
  parseSearch(snap: PageSnapshot, ctx: ParseCtx): SearchHit[];
  parseListing(snap: PageSnapshot, ctx: ParseCtx): Listing;
  detectBlock(snap: PageSnapshot): string | null;
  searchScript?: string;
  listingScript?: string;
  cookies?(opts: { currency: string }): FetchCookie[];
  matchesUrl(url: string): boolean;
}

export class ShopperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopperError';
  }
}

export class NothingFoundError extends ShopperError {
  constructor(message: string) {
    super(message);
    this.name = 'NothingFoundError';
  }
}
