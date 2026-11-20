import { describe, expect, it } from 'vitest';
import type { Learning, NewLearning } from '@ai-tools/agent-kit';
import { builtinDefaults, shopperDefaultsSchema } from '../src/core/defaults.js';
import { UserBrowserRequiredError, type FetchRequest, type Fetcher } from '../src/core/fetcher.js';
import { ADAPTERS } from '../src/core/registry.js';
import {
  BlockedError,
  defaultRunDeps,
  effectiveMode,
  runListing,
  runSearch,
} from '../src/core/run.js';
import type { PageSnapshot, SiteAdapter } from '../src/core/types.js';
import { FIXTURE_NOW } from './helpers/fixture.js';

const NOW = new Date(FIXTURE_NOW);
const defaults = shopperDefaultsSchema.parse(builtinDefaults(ADAPTERS.map((a) => a.id)));

function card(href: string, title: string, price: string): string {
  return `<div class="card"><a class="t" href="${href}">${title}</a><span class="pr">${price}</span></div>`;
}

function fakeAdapter(id: string, mode: SiteAdapter['defaultMode']): SiteAdapter {
  return {
    ...ADAPTERS[2]!,
    id,
    name: id,
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
    parseSearch: ADAPTERS[2]!.parseSearch,
    parseListing: ADAPTERS[2]!.parseListing,
    cookies: undefined,
    searchScript: undefined,
    listingScript: undefined,
  };
}

class FakeFetcher implements Fetcher {
  requests: FetchRequest[] = [];
  closed = false;
  constructor(private readonly pages: Record<string, string | Error>) {}
  async fetch(request: FetchRequest): Promise<PageSnapshot> {
    this.requests.push(request);
    if (request.mode === 'user-browser') throw new UserBrowserRequiredError(request.url);
    const host = new URL(request.url).hostname.split('.')[0] as string;
    const page = this.pages[host];
    if (page instanceof Error) throw page;
    return { url: request.url, html: page ?? '', fetchedAt: FIXTURE_NOW, mode: request.mode };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function setup(
  pages: Record<string, string | Error>,
  adapters: SiteAdapter[],
  learnings: Learning[] = [],
) {
  const recorded: Learning[] = [];
  const fetcher = new FakeFetcher(pages);
  const deps = defaultRunDeps({
    fetcher,
    adapters,
    learnings,
    now: () => NOW,
    recordLearning: (entry: NewLearning) => {
      const learning: Learning = {
        v: 1,
        ts: FIXTURE_NOW,
        agent: 'shopper',
        kind: entry.kind,
        site: entry.site ?? null,
        key: entry.key,
        value: entry.value,
        expires: entry.expires ?? null,
        evidence: entry.evidence ?? null,
      };
      recorded.push(learning);
      return learning;
    },
  });
  return { deps, fetcher, recorded };
}

const options = (extra = {}) => ({
  query: 'widget',
  defaults: shopperDefaults(),
  defaultsSource: 'builtin',
  ...extra,
});

function shopperDefaults() {
  return shopperDefaultsSchema.parse({
    ...builtinDefaults([]),
    sites: { preferred: [], blocked: [] },
  });
}

describe('runSearch', () => {
  const alpha = fakeAdapter('alpha', 'http');
  const beta = fakeAdapter('beta', 'headless');
  const gamma = fakeAdapter('gamma', 'user-browser');

  it('searches every site, merges and ranks the offers', async () => {
    const { deps } = setup(
      {
        alpha: `<html>${card('/1', 'Alpha item', '฿300')}${card('/2', 'Alpha cheap', '฿100')}</html>`,
        beta: `<html>${card('/3', 'Beta item', '฿200')}</html>`,
      },
      [alpha, beta, gamma],
    );
    const out = await runSearch(options(), deps);
    expect(out.hits.map((h) => h.title)).toEqual(['Alpha cheap', 'Beta item', 'Alpha item']);
    expect(out.sites.alpha).toMatchObject({ status: 'ok', count: 2, mode: 'http' });
    expect(out.sites.beta?.mode).toBe('headless');
    expect(out.needsUserBrowser.map((n) => n.site)).toEqual(['gamma']);
    expect(out.sites.gamma?.status).toBe('needs-user-browser');
    expect(out.errors).toEqual([]);
  });

  it('records a block learning and reports the site as blocked', async () => {
    const { deps, recorded } = setup(
      { alpha: '<html>CAPTCHA</html>', beta: `<html>${card('/3', 'B', '฿5')}</html>` },
      [alpha, beta],
    );
    const out = await runSearch(options(), deps);
    expect(out.sites.alpha).toMatchObject({ status: 'blocked', reason: 'captcha page' });
    expect(out.hits).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      kind: 'block',
      site: 'alpha',
      expires: '2026-11-22T00:00:00.000Z',
    });
    expect(out.learned).toHaveLength(1);
  });

  it('skips a site with a live block learning', async () => {
    const block: Learning = {
      v: 1,
      ts: FIXTURE_NOW,
      agent: 'shopper',
      kind: 'block',
      site: 'alpha',
      key: 'search',
      value: null,
      expires: '2026-11-22T00:00:00.000Z',
      evidence: 'captcha page',
    };
    const { deps, fetcher } = setup({ alpha: '', beta: '' }, [alpha, beta], [block]);
    const out = await runSearch(options(), deps);
    expect(out.sites.alpha).toMatchObject({ status: 'skipped', reason: 'blocked (captcha page)' });
    expect(fetcher.requests.map((r) => new URL(r.url).hostname)).toEqual(['beta.example.com']);
  });

  it('keeps going when one site fails', async () => {
    const { deps } = setup(
      { alpha: new Error('boom'), beta: `<html>${card('/3', 'B', '฿5')}</html>` },
      [alpha, beta],
    );
    const out = await runSearch(options(), deps);
    expect(out.sites.alpha?.status).toBe('error');
    expect(out.errors).toEqual([{ site: 'alpha', message: 'boom' }]);
    expect(out.hits).toHaveLength(1);
  });

  it('honours --sites, blocked sites and unknown ids', async () => {
    const { deps, fetcher } = setup({ alpha: '', beta: '' }, [alpha, beta]);
    const out = await runSearch(options({ sites: ['beta', 'nope'] }), deps);
    expect(fetcher.requests).toHaveLength(1);
    expect(out.errors).toEqual([{ site: 'nope', message: 'unknown site id' }]);
    const blocked = shopperDefaultsSchema.parse({
      ...builtinDefaults([]),
      sites: { preferred: [], blocked: ['alpha'] },
    });
    const second = setup({ alpha: '', beta: '' }, [alpha, beta]);
    await runSearch(options({ defaults: blocked }), second.deps);
    expect(second.fetcher.requests).toHaveLength(1);
  });

  it('applies the condition filter, limit and budget', async () => {
    const { deps } = setup(
      {
        alpha: `<html>${card('/1', 'New one', '฿100')}${card('/2', 'Used one', '฿50')}${card('/3', 'New dear', '฿900')}</html>`,
        beta: '',
      },
      [alpha, beta],
    );
    const out = await runSearch(options({ maxPrice: 500, limit: 5 }), deps);
    expect(out.hits.map((h) => h.title)).toEqual(['New one']);
    const withUsed = await runSearch(
      options({ condition: ['used', 'new'], limit: 1 }),
      setup(
        {
          alpha: `<html>${card('/2', 'Used one', '฿50')}${card('/1', 'New one', '฿100')}</html>`,
          beta: '',
        },
        [alpha, beta],
      ).deps,
    );
    expect(withUsed.hits.map((h) => h.title)).toEqual(['Used one']);
  });

  it('lets a method learning change the fetch mode but never for user-browser sites', () => {
    const method = (site: string): Learning => ({
      v: 1,
      ts: FIXTURE_NOW,
      agent: 'shopper',
      kind: 'method',
      site,
      key: 'fetch',
      value: 'headless',
      expires: null,
      evidence: null,
    });
    expect(effectiveMode(alpha, shopperDefaults(), [method('alpha')], NOW)).toBe('headless');
    expect(effectiveMode(gamma, shopperDefaults(), [method('gamma')], NOW)).toBe('user-browser');
    const pinned = shopperDefaultsSchema.parse({
      version: 1,
      browser: { userBrowserSites: ['alpha'] },
    });
    expect(effectiveMode(alpha, pinned, [method('alpha')], NOW)).toBe('user-browser');
  });

  it('applies a selector learning', async () => {
    const learning: Learning = {
      v: 1,
      ts: FIXTURE_NOW,
      agent: 'shopper',
      kind: 'selector',
      site: 'alpha',
      key: 'search.price',
      value: '.alt',
      expires: null,
      evidence: null,
    };
    const html =
      '<div class="card"><a class="t" href="/1">Item</a><span class="pr">฿1</span><span class="alt">฿7</span></div>';
    const { deps } = setup({ alpha: html }, [alpha], [learning]);
    const out = await runSearch(options({ sites: ['alpha'] }), deps);
    expect(out.hits[0]?.price?.amount).toBe(7);
  });
});

describe('runListing', () => {
  const alpha = fakeAdapter('alpha', 'http');
  const gamma = fakeAdapter('gamma', 'user-browser');

  it('reads a listing through the matching adapter', async () => {
    const { deps } = setup({ alpha: '<html><h1>Thing</h1></html>' }, [alpha]);
    const out = await runListing('https://alpha.example.com/p/1', defaults, deps);
    expect(out.listing.title).toBe('Thing');
  });

  it('refuses user-browser sites, unknown URLs and block pages', async () => {
    const { deps, recorded } = setup({ alpha: 'CAPTCHA' }, [alpha, gamma]);
    await expect(runListing('https://gamma.example.com/p', defaults, deps)).rejects.toBeInstanceOf(
      UserBrowserRequiredError,
    );
    await expect(runListing('https://other.example.org/', defaults, deps)).rejects.toThrow(
      /no adapter/,
    );
    await expect(runListing('https://alpha.example.com/p', defaults, deps)).rejects.toBeInstanceOf(
      BlockedError,
    );
    expect(recorded).toHaveLength(1);
  });
});
