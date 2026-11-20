import { WATCH_EVENTS } from '../defaults.js';
import type { Money, SearchHit, Stock } from '../types.js';

export type WatchEventType = (typeof WATCH_EVENTS)[number];

export const FAILURE_STREAK = 3;

export interface WatchEvent {
  type: WatchEventType;
  key: string;
  site: string;
  title: string;
  url: string;
  price: Money | null;
  previousPrice?: Money | null;
  stock: Stock;
  previousStock?: Stock;
  note?: string;
  recovered?: boolean;
}

export type SiteOutcomeStatus =
  'ok' | 'empty' | 'blocked' | 'skipped' | 'error' | 'needs-user-browser';

export interface SiteOutcome {
  status: SiteOutcomeStatus;
  count?: number;
  reason?: string;
}

export function siteSucceeded(status: string): boolean {
  return status === 'ok' || status === 'empty';
}

export function siteFailed(status: string): boolean {
  return status === 'error' || status === 'blocked' || status === 'skipped';
}

export type OutcomeKind = 'ok' | 'empty' | 'failed' | 'ignored';

export function outcomeKind(status: string, hitCount: number): OutcomeKind {
  if (status === 'needs-user-browser') return 'ignored';
  if (siteFailed(status)) return 'failed';
  if (status === 'empty') return 'empty';
  if (status === 'ok') return hitCount > 0 ? 'ok' : 'empty';
  return 'ignored';
}

export const RECENT_RUNS = 5;

export interface PreviousState {
  hasHistory: boolean;
  recent: Record<string, SearchHit[][]>;
  failures: Record<string, number>;
}

export const EMPTY_PREVIOUS: PreviousState = { hasHistory: false, recent: {}, failures: {} };

export interface DiffOptions {
  maxPrice: number | null;
  minDropPercent: number;
  currency: string;
  notifyOn: readonly WatchEventType[];
  queryIdParams?: Record<string, readonly string[]>;
}

export interface DiffInput {
  hits: SearchHit[];
  sites: Record<string, SiteOutcome>;
  previous: PreviousState;
  options: DiffOptions;
}

export function canonicalUrl(url: string, keepParams: readonly string[] = []): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url.trim().replace(/[?#].*$/, '');
  }
  const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
  const kept = keepParams
    .map((name) => [name, parsed.searchParams.get(name)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${kept === '' ? '' : `?${kept}`}`;
}

export function hitKey(
  hit: Pick<SearchHit, 'site' | 'url'>,
  queryIdParams: Record<string, readonly string[]> = {},
): string {
  return `${hit.site} ${canonicalUrl(hit.url, queryIdParams[hit.site] ?? [])}`;
}

function amountOf(price: Money | null | undefined, currency: string): number | null {
  if (price === null || price === undefined) return null;
  if (price.currency !== currency) return null;
  return price.amount;
}

function atOrBelow(price: Money | null | undefined, max: number | null, currency: string): boolean {
  if (max === null) return false;
  const amount = amountOf(price, currency);
  return amount !== null && amount <= max;
}

function dedupe(
  hits: SearchHit[],
  queryIdParams: Record<string, readonly string[]>,
  currency: string,
): Map<string, SearchHit> {
  const byKey = new Map<string, SearchHit>();
  for (const hit of hits) {
    const key = hitKey(hit, queryIdParams);
    const current = byKey.get(key);
    if (current === undefined) {
      byKey.set(key, hit);
      continue;
    }
    const next = amountOf(hit.price, currency);
    const best = amountOf(current.price, currency);
    if (next !== null && (best === null || next < best)) byKey.set(key, hit);
  }
  return byKey;
}

function eventFor(
  type: WatchEventType,
  key: string,
  hit: SearchHit,
  before?: SearchHit,
): WatchEvent {
  const event: WatchEvent = {
    type,
    key,
    site: hit.site,
    title: hit.title,
    url: hit.url,
    price: hit.price,
    stock: hit.stock,
  };
  if (before !== undefined) {
    event.previousPrice = before.price;
    event.previousStock = before.stock;
  }
  return event;
}

const TYPE_ORDER: Record<WatchEventType, number> = {
  new: 0,
  price_drop: 1,
  back_in_stock: 2,
  threshold: 3,
  scanner_failing: 4,
};

export function compareEvents(a: WatchEvent, b: WatchEvent): number {
  return (
    TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
    a.site.localeCompare(b.site) ||
    a.key.localeCompare(b.key) ||
    (a.recovered === true ? 1 : 0) - (b.recovered === true ? 1 : 0)
  );
}

export function diffRun(input: DiffInput): WatchEvent[] {
  const { options, previous } = input;
  const queryIdParams = options.queryIdParams ?? {};
  const { currency, maxPrice } = options;
  const events: WatchEvent[] = [];
  const current = dedupe(input.hits, queryIdParams, currency);

  const hitCounts = new Map<string, number>();
  for (const hit of input.hits) hitCounts.set(hit.site, (hitCounts.get(hit.site) ?? 0) + 1);

  const known = new Map<string, Map<string, SearchHit>>();
  for (const [site, snapshots] of Object.entries(previous.recent)) {
    const lookup = new Map<string, SearchHit>();
    for (const snapshot of snapshots) {
      for (const [key, hit] of dedupe(snapshot, queryIdParams, currency)) lookup.set(key, hit);
    }
    known.set(site, lookup);
  }

  for (const [key, hit] of current) {
    const siteOutcome = input.sites[hit.site];
    if (siteOutcome !== undefined && outcomeKind(siteOutcome.status, 1) !== 'ok') continue;
    const knownSite = known.get(hit.site);
    const nowAtThreshold = atOrBelow(hit.price, maxPrice, currency);
    if (knownSite === undefined) {
      if (nowAtThreshold) events.push(eventFor('threshold', key, hit));
      continue;
    }
    const old = knownSite.get(key);
    if (old === undefined) {
      events.push(eventFor('new', key, hit));
      if (nowAtThreshold) events.push(eventFor('threshold', key, hit));
      continue;
    }
    const oldAmount = amountOf(old.price, currency);
    const newAmount = amountOf(hit.price, currency);
    if (
      oldAmount !== null &&
      newAmount !== null &&
      newAmount < oldAmount &&
      (oldAmount - newAmount) * 100 > options.minDropPercent * oldAmount
    ) {
      events.push(eventFor('price_drop', key, hit, old));
    }
    if (old.stock === 'out_of_stock' && (hit.stock === 'in_stock' || hit.stock === 'low_stock')) {
      events.push(eventFor('back_in_stock', key, hit, old));
    }
    if (nowAtThreshold && !atOrBelow(old.price, maxPrice, currency)) {
      events.push(eventFor('threshold', key, hit, old));
    }
  }

  for (const [site, outcome] of Object.entries(input.sites)) {
    const streak = previous.failures[site] ?? 0;
    const kind = outcomeKind(outcome.status, hitCounts.get(site) ?? 0);
    if (kind === 'failed' || kind === 'empty') {
      if (streak + 1 === FAILURE_STREAK) {
        const detail = outcome.reason ?? (kind === 'empty' ? 'no listings' : undefined);
        const reason = detail === undefined ? '' : `: ${detail}`;
        events.push({
          type: 'scanner_failing',
          key: `scanner ${site}`,
          site,
          title: `${site} failed ${FAILURE_STREAK} runs in a row${reason}`,
          url: '',
          price: null,
          stock: 'unknown',
          note: `failed ${FAILURE_STREAK} runs in a row${reason}`,
        });
      }
    } else if (kind === 'ok' && streak >= FAILURE_STREAK) {
      events.push({
        type: 'scanner_failing',
        key: `scanner ${site}`,
        site,
        title: `${site} works again after ${streak} failed runs`,
        url: '',
        price: null,
        stock: 'unknown',
        note: `recovered after ${streak} failed runs`,
        recovered: true,
      });
    }
  }

  return events.filter((event) => options.notifyOn.includes(event.type)).sort(compareEvents);
}

export function mergeEvents(older: WatchEvent[], newer: WatchEvent[]): WatchEvent[] {
  const byId = new Map<string, WatchEvent>();
  for (const event of [...older, ...newer]) byId.set(`${event.type}\u0000${event.key}`, event);
  return [...byId.values()].sort(compareEvents);
}
