import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shopperDefaultsSchema, type ShopperDefaults } from '../../src/core/defaults.js';
import type { Fetcher } from '../../src/core/fetcher.js';
import { defaultRunDeps } from '../../src/core/run.js';
import type { FetchMode, PageSnapshot, SearchHit, SiteAdapter } from '../../src/core/types.js';
import type { SpawnFn, SpawnRequest } from '../../src/core/watch/notify.js';
import type { WatchDeps } from '../../src/core/watch/runner.js';
import { watchPaths } from '../../src/core/watch/store.js';

export const START = new Date('2026-11-21T00:00:00.000Z');

export function fakeAdapter(id: string, defaultMode: FetchMode = 'http'): SiteAdapter {
  return {
    id,
    name: id,
    country: null,
    currency: 'THB',
    domains: [`${id}.example.com`],
    defaultMode,
    selectors: {},
    searchUrl: (query) => `https://${id}.example.com/search?q=${encodeURIComponent(query)}`,
    parseSearch: (snap) => JSON.parse(snap.html) as SearchHit[],
    parseListing: () => {
      throw new Error('not used');
    },
    detectBlock: (snap) => (snap.html.includes('CAPTCHA') ? 'captcha' : null),
    matchesUrl: (url) => url.includes(`${id}.example.com`),
  };
}

export function fakeHit(
  site: string,
  title: string,
  amount: number,
  extra: Partial<SearchHit> = {},
): SearchHit {
  return {
    site,
    title,
    url: `https://${site}.example.com/p/${title.toLowerCase().replace(/\W+/g, '-')}`,
    price: { amount, currency: 'THB' },
    condition: 'new',
    stock: 'in_stock',
    seenAt: START.toISOString(),
    ...extra,
  };
}

export interface World {
  pages: Record<string, string | Error>;
  requests: string[];
  clock: { now: Date };
}

export function setPage(world: World, site: string, hits: SearchHit[] | Error | string): void {
  world.pages[site] =
    hits instanceof Error || typeof hits === 'string' ? hits : JSON.stringify(hits);
}

export function fakeFetcher(world: World): Fetcher {
  return {
    async fetch(request) {
      world.requests.push(request.url);
      const site = new URL(request.url).hostname.split('.')[0] as string;
      const page = world.pages[site];
      if (page instanceof Error) throw page;
      const snap: PageSnapshot = {
        url: request.url,
        html: page ?? '[]',
        fetchedAt: world.clock.now.toISOString(),
        mode: request.mode,
      };
      return snap;
    },
    async close() {},
  };
}

export interface Harness {
  dir: string;
  world: World;
  deps: WatchDeps;
  sent: SpawnRequest[];
  printed: string[];
  cleanup: () => void;
}

export function harness(
  sites: string[],
  overrides: {
    defaults?: Record<string, unknown>;
    spawn?: SpawnFn;
    notifyCommand?: string | null;
  } = {},
  adapters: SiteAdapter[] = sites.map((id) => fakeAdapter(id)),
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'shopper-watch-'));
  const world: World = { pages: {}, requests: [], clock: { now: START } };
  const defaults: ShopperDefaults = shopperDefaultsSchema.parse({
    version: 1,
    sites: { preferred: sites },
    ...overrides.defaults,
  });
  const sent: SpawnRequest[] = [];
  const printed: string[] = [];
  const spawn: SpawnFn =
    overrides.spawn ??
    (async (request) => {
      sent.push(request);
      return { code: 0, stderr: '' };
    });
  const deps: WatchDeps = {
    runDeps: defaultRunDeps({
      fetcher: fakeFetcher(world),
      adapters,
      now: () => world.clock.now,
      recordLearning: (entry) => ({
        v: 1,
        ts: world.clock.now.toISOString(),
        agent: 'shopper',
        kind: entry.kind,
        site: entry.site ?? null,
        key: entry.key,
        value: entry.value,
        expires: entry.expires ?? null,
        evidence: entry.evidence ?? null,
      }),
    }),
    defaults,
    defaultsSource: 'builtin',
    paths: watchPaths({ env: { AGENTS_STATE_DIR: join(dir, 'state') } }),
    now: () => world.clock.now,
    notifyCommand: overrides.notifyCommand === undefined ? 'alert' : overrides.notifyCommand,
    env: {},
    spawn,
    print: (text) => printed.push(text),
  };
  return {
    dir,
    world,
    deps,
    sent,
    printed,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function advance(world: World, hours: number): void {
  world.clock.now = new Date(world.clock.now.getTime() + hours * 3_600_000);
}
