import type { ShopperDefaults } from './defaults.js';
import { CONDITIONS, type Condition, type SearchHit } from './types.js';

export interface ConditionChoice {
  allowed: Condition[];
  unresolved: boolean;
}

export function resolveConditions(
  query: string,
  defaults: ShopperDefaults,
  override?: Condition[],
): ConditionChoice {
  if (override !== undefined && override.length > 0)
    return { allowed: override, unresolved: false };
  for (const rule of defaults.condition.rules) {
    if (new RegExp(rule.match, 'i').test(query)) {
      return { allowed: rule.allow as Condition[], unresolved: false };
    }
  }
  if (defaults.condition.unmatched === 'ask') {
    return { allowed: [...CONDITIONS], unresolved: true };
  }
  return { allowed: defaults.condition.default as Condition[], unresolved: false };
}

export function allowedConditions(
  query: string,
  defaults: ShopperDefaults,
  override?: Condition[],
): Condition[] {
  return resolveConditions(query, defaults, override).allowed;
}

export function effectivePrice(hit: SearchHit, includeShipping: boolean): number | null {
  if (hit.price === null) return null;
  const shipping =
    includeShipping && hit.shipping !== null && hit.shipping !== undefined
      ? hit.shipping.amount
      : 0;
  return hit.price.amount + shipping;
}

export interface FilterOptions {
  allowed: Condition[];
  maxPrice: number | null;
  includeOos: boolean;
  includeShipping: boolean;
  currency: string;
}

export function filterHits(hits: SearchHit[], opts: FilterOptions): SearchHit[] {
  return hits.filter((hit) => {
    const conditionOk =
      opts.allowed.includes(hit.condition) ||
      (hit.condition === 'unknown' && opts.allowed.includes('new'));
    if (!conditionOk) return false;
    const price = effectivePrice(hit, opts.includeShipping);
    if (price === null) return false;
    if (opts.maxPrice !== null && hit.price?.currency === opts.currency && price > opts.maxPrice) {
      return false;
    }
    if (!opts.includeOos && hit.stock === 'out_of_stock') return false;
    return true;
  });
}

function siteRank(site: string, order: string[]): number {
  const index = order.indexOf(site);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function tieBreak(a: SearchHit, b: SearchHit, order: string[]): number {
  return (
    siteRank(a.site, order) - siteRank(b.site, order) ||
    a.site.localeCompare(b.site) ||
    a.title.localeCompare(b.title) ||
    a.url.localeCompare(b.url)
  );
}

export function rankHits(
  hits: SearchHit[],
  style: 'cheapest' | 'value' | 'premium',
  includeShipping: boolean,
  siteOrder: string[] = [],
): SearchHit[] {
  const price = (hit: SearchHit): number => effectivePrice(hit, includeShipping) ?? Infinity;
  const sorted = [...hits];
  if (style === 'premium') {
    sorted.sort(
      (a, b) =>
        (b.rating ?? -1) - (a.rating ?? -1) || price(a) - price(b) || tieBreak(a, b, siteOrder),
    );
    return sorted;
  }
  const tier = (hit: SearchHit): number =>
    style === 'value' && hit.stock === 'in_stock' && (hit.rating ?? 0) >= 4 ? 0 : 1;
  sorted.sort((a, b) => tier(a) - tier(b) || price(a) - price(b) || tieBreak(a, b, siteOrder));
  return sorted;
}
