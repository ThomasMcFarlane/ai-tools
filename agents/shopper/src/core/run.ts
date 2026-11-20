import { foldLearnings, liveBlock, type Learning, type NewLearning } from '@ai-tools/agent-kit';
import type { ShopperDefaults } from './defaults.js';
import { createFetcher, UserBrowserRequiredError, type Fetcher } from './fetcher.js';
import { ADAPTERS } from './registry.js';
import { filterHits, rankHits, resolveConditions } from './rank.js';
import {
  FETCH_MODES,
  ShopperError,
  type Condition,
  type FetchMode,
  type Listing,
  type PageSnapshot,
  type ParseCtx,
  type SearchHit,
  type SiteAdapter,
} from './types.js';

export const SITE_TIMEOUT_MS = 45_000;
export const CONCURRENCY = 4;
export const BLOCK_TTL_MS = 24 * 3_600_000;

export interface RunDeps {
  fetcher: Fetcher;
  adapters: readonly SiteAdapter[];
  learnings: Learning[];
  recordLearning: (entry: NewLearning) => Learning;
  now: () => Date;
  concurrency?: number;
  siteTimeoutMs?: number;
}

export function defaultRunDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    fetcher: createFetcher(),
    adapters: ADAPTERS,
    learnings: [],
    recordLearning: () => {
      throw new ShopperError('no learning recorder configured');
    },
    now: () => new Date(),
    ...overrides,
  };
}

export interface SearchOptions {
  query: string;
  sites?: string[];
  condition?: Condition[];
  maxPrice?: number;
  limit?: number;
  includeOos?: boolean;
  defaults: ShopperDefaults;
  defaultsSource: string;
  warnings?: string[];
}

export type SiteStatus = 'ok' | 'empty' | 'blocked' | 'skipped' | 'error' | 'needs-user-browser';

export interface SiteReport {
  status: SiteStatus;
  count: number;
  ms: number;
  mode: FetchMode;
  reason?: string;
}

export interface NeedsUserBrowser {
  site: string;
  name: string;
  searchUrl: string;
  scriptCommand: string;
  parseCommand: string;
}

export interface SearchOutput {
  query: string;
  defaultsSource: string;
  conditions: Condition[];
  conditionUnresolved: boolean;
  warnings: string[];
  sites: Record<string, SiteReport>;
  hits: SearchHit[];
  needsUserBrowser: NeedsUserBrowser[];
  errors: Array<{ site: string; message: string }>;
  learned: Learning[];
}

export function effectiveMode(
  adapter: SiteAdapter,
  defaults: ShopperDefaults,
  learnings: Learning[],
  now: Date,
): FetchMode {
  if (adapter.defaultMode === 'user-browser') return 'user-browser';
  if (defaults.browser.userBrowserSites.includes(adapter.id)) return 'user-browser';
  const method = foldLearnings(learnings, now).find(
    (entry) => entry.kind === 'method' && entry.site === adapter.id && entry.key === 'fetch',
  );
  const value = method?.value;
  if (typeof value === 'string' && (FETCH_MODES as readonly string[]).includes(value)) {
    return value as FetchMode;
  }
  return adapter.defaultMode;
}

export function selectorsFor(
  adapter: SiteAdapter,
  learnings: Learning[],
  now: Date,
): Record<string, string> {
  const merged = { ...adapter.selectors };
  for (const entry of foldLearnings(learnings, now)) {
    if (entry.kind === 'selector' && entry.site === adapter.id && typeof entry.value === 'string') {
      merged[entry.key] = entry.value;
    }
  }
  return merged;
}

function parseCtx(adapter: SiteAdapter, learnings: Learning[], now: Date): ParseCtx {
  return {
    selectors: selectorsFor(adapter, learnings, now),
    now: now.toISOString(),
    currency: adapter.currency,
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ShopperError(`${label} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function recordBlock(
  deps: RunDeps,
  site: string,
  key: string,
  reason: string,
  now: Date,
): Learning {
  return deps.recordLearning({
    kind: 'block',
    site,
    key,
    value: { reason },
    expires: new Date(now.getTime() + BLOCK_TTL_MS).toISOString(),
    evidence: reason,
  });
}

export function resolveSites(
  requested: string[] | undefined,
  defaults: ShopperDefaults,
  adapters: readonly SiteAdapter[],
): { ids: string[]; unknown: string[] } {
  const known = new Set(adapters.map((adapter) => adapter.id));
  let ids: string[];
  if (requested !== undefined && requested.length > 0) {
    ids = requested;
  } else {
    const preferred =
      defaults.sites.preferred.length > 0 ? defaults.sites.preferred : adapters.map((a) => a.id);
    ids = preferred.filter((id) => !defaults.sites.blocked.includes(id));
  }
  return { ids: ids.filter((id) => known.has(id)), unknown: ids.filter((id) => !known.has(id)) };
}

export function userBrowserHint(
  adapter: SiteAdapter,
  query: string,
  city?: string,
): NeedsUserBrowser {
  return {
    site: adapter.id,
    name: adapter.name,
    searchUrl: adapter.searchUrl(query, city === undefined ? {} : { city }),
    scriptCommand: `shopper script ${adapter.id} search`,
    parseCommand: `shopper parse ${adapter.id} search --url '<tab url>' --file <snapshot.json>`,
  };
}

export function finalise(
  hits: SearchHit[],
  opts: Pick<
    SearchOptions,
    'query' | 'condition' | 'maxPrice' | 'limit' | 'includeOos' | 'defaults'
  >,
): { hits: SearchHit[]; conditions: Condition[]; conditionUnresolved: boolean } {
  const { defaults } = opts;
  const choice = resolveConditions(opts.query, defaults, opts.condition);
  const conditions = choice.allowed;
  const filtered = filterHits(hits, {
    allowed: conditions,
    maxPrice: opts.maxPrice ?? defaults.budget.max ?? null,
    includeOos: opts.includeOos === true,
    includeShipping: defaults.budget.includeShipping,
    currency: defaults.currency,
  });
  const ranked = rankHits(
    filtered,
    defaults.budget.style,
    defaults.budget.includeShipping,
    defaults.sites.preferred,
  );
  return {
    hits: ranked.slice(0, opts.limit ?? defaults.report.limit),
    conditions,
    conditionUnresolved: choice.unresolved,
  };
}

export async function runSearch(opts: SearchOptions, deps: RunDeps): Promise<SearchOutput> {
  const now = deps.now();
  const { ids, unknown } = resolveSites(opts.sites, opts.defaults, deps.adapters);
  const unknownRequested = opts.sites !== undefined && opts.sites.length > 0 ? unknown : [];
  const output: SearchOutput = {
    query: opts.query,
    defaultsSource: opts.defaultsSource,
    conditions: [],
    conditionUnresolved: false,
    warnings: opts.warnings ?? [],
    sites: {},
    hits: [],
    needsUserBrowser: [],
    errors: unknownRequested.map((site) => ({ site, message: 'unknown site id' })),
    learned: [],
  };
  const collected: SearchHit[] = [];
  const work: SiteAdapter[] = [];
  for (const id of ids) {
    const adapter = deps.adapters.find((candidate) => candidate.id === id) as SiteAdapter;
    const mode = effectiveMode(adapter, opts.defaults, deps.learnings, now);
    if (mode === 'user-browser') {
      output.needsUserBrowser.push(
        userBrowserHint(adapter, opts.query, opts.defaults.location.city),
      );
      output.sites[id] = { status: 'needs-user-browser', count: 0, ms: 0, mode };
      continue;
    }
    const block = liveBlock(deps.learnings, id, now);
    if (block !== null) {
      const reason = `blocked (${block.evidence ?? 'earlier block'})`;
      output.sites[id] = { status: 'skipped', count: 0, ms: 0, mode, reason };
      continue;
    }
    work.push(adapter);
  }

  await mapLimit(work, deps.concurrency ?? CONCURRENCY, async (adapter) => {
    const started = Date.now();
    const mode = effectiveMode(adapter, opts.defaults, deps.learnings, now);
    const report: SiteReport = { status: 'ok', count: 0, ms: 0, mode };
    output.sites[adapter.id] = report;
    try {
      const hits = await withTimeout(
        searchSite(adapter, mode, opts, deps, now, output),
        deps.siteTimeoutMs ?? SITE_TIMEOUT_MS,
        adapter.id,
      );
      if (hits === null) {
        report.status = 'blocked';
      } else {
        report.count = hits.length;
        report.status = hits.length === 0 ? 'empty' : 'ok';
        collected.push(...hits);
      }
    } catch (error) {
      report.status = 'error';
      report.reason = error instanceof Error ? error.message : String(error);
      output.errors.push({ site: adapter.id, message: report.reason });
    } finally {
      report.ms = Date.now() - started;
    }
  });

  const final = finalise(collected, opts);
  output.hits = final.hits;
  output.conditions = final.conditions;
  output.conditionUnresolved = final.conditionUnresolved;
  return output;
}

async function searchSite(
  adapter: SiteAdapter,
  mode: FetchMode,
  opts: SearchOptions,
  deps: RunDeps,
  now: Date,
  output: SearchOutput,
): Promise<SearchHit[] | null> {
  const request = {
    url: adapter.searchUrl(
      opts.query,
      opts.defaults.location.city === undefined
        ? { page: 1 }
        : { page: 1, city: opts.defaults.location.city },
    ),
    mode,
    ...(adapter.searchScript === undefined ? {} : { script: adapter.searchScript }),
    ...(adapter.cookies === undefined
      ? {}
      : { cookies: adapter.cookies({ currency: opts.defaults.currency }) }),
  };
  const snap = await deps.fetcher.fetch(request);
  const reason = adapter.detectBlock(snap);
  if (reason !== null) {
    const learned = recordBlock(deps, adapter.id, 'search', reason, now);
    output.learned.push(learned);
    const report = output.sites[adapter.id];
    if (report !== undefined) report.reason = reason;
    return null;
  }
  return adapter.parseSearch(snap, parseCtx(adapter, deps.learnings, now));
}

export async function runListing(
  url: string,
  defaults: ShopperDefaults,
  deps: RunDeps,
): Promise<{ adapter: SiteAdapter; listing: Listing; learned: Learning[] }> {
  const now = deps.now();
  const adapter = deps.adapters.find((candidate) => candidate.matchesUrl(url));
  if (adapter === undefined) throw new ShopperError(`no adapter matches ${url}`);
  const mode = effectiveMode(adapter, defaults, deps.learnings, now);
  if (mode === 'user-browser') throw new UserBrowserRequiredError(url);
  const block = liveBlock(deps.learnings, adapter.id, now);
  if (block !== null) {
    throw new ShopperError(`${adapter.id} skipped: blocked (${block.evidence ?? 'earlier block'})`);
  }
  const snap: PageSnapshot = await withTimeout(
    deps.fetcher.fetch({
      url,
      mode,
      ...(adapter.listingScript === undefined ? {} : { script: adapter.listingScript }),
      ...(adapter.cookies === undefined
        ? {}
        : { cookies: adapter.cookies({ currency: defaults.currency }) }),
    }),
    deps.siteTimeoutMs ?? SITE_TIMEOUT_MS,
    adapter.id,
  );
  const reason = adapter.detectBlock(snap);
  if (reason !== null) {
    const learned = recordBlock(deps, adapter.id, 'listing', reason, now);
    throw new BlockedError(adapter.id, reason, learned);
  }
  return {
    adapter,
    listing: adapter.parseListing(snap, parseCtx(adapter, deps.learnings, now)),
    learned: [],
  };
}

export class BlockedError extends ShopperError {
  constructor(
    readonly site: string,
    readonly reason: string,
    readonly learned: Learning,
  ) {
    super(`${site} blocked the request: ${reason}`);
    this.name = 'BlockedError';
  }
}
