import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/index.js';
import type { Deps } from '../src/cli/context.js';
import type { FetchRequest, Fetcher } from '../src/core/fetcher.js';
import { UserBrowserRequiredError } from '../src/core/fetcher.js';
import type { PageSnapshot } from '../src/core/types.js';
import { FIXTURE_NOW } from './helpers/fixture.js';
import { VERSION } from '../src/version.js';

let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shopper-cli-'));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function page(title: string, price: string, href = '/products/1.html'): string {
  return `<div data-qa-locator="product-item"><a href="${href}" title="${title}">${title}</a><span class="price">${price}</span></div>`;
}

function fetcherFor(pages: Record<string, string>): { fetcher: Fetcher; requests: FetchRequest[] } {
  const requests: FetchRequest[] = [];
  const fetcher: Fetcher = {
    async fetch(request) {
      requests.push(request);
      if (request.mode === 'user-browser') throw new UserBrowserRequiredError(request.url);
      const host = new URL(request.url).hostname;
      const html = Object.entries(pages).find(([key]) => host.includes(key))?.[1] ?? '';
      const snap: PageSnapshot = {
        url: request.url,
        html,
        fetchedAt: FIXTURE_NOW,
        mode: request.mode,
      };
      return snap;
    },
    async close() {},
  };
  return { fetcher, requests };
}

function exec(
  args: string[],
  opts: { pages?: Record<string, string>; stdin?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const { fetcher, requests } = fetcherFor(opts.pages ?? {});
  const deps: Partial<Deps> = {
    print: (text) => out.push(text),
    printErr: (text) => err.push(text),
    readStdin: async () => opts.stdin ?? '',
    env: { AGENTS_MEMORY_DIR: join(dir, 'mem'), AGENTS_STATE_DIR: join(dir, 'state'), ...opts.env },
    home: dir,
    now: () => new Date(FIXTURE_NOW),
    makeFetcher: () => fetcher,
  };
  return run(['node', 'shopper', ...args], deps).then((code) => ({ code, requests }));
}

describe('shopper CLI', () => {
  it('prints the version', async () => {
    expect((await exec(['--version'])).code).toBe(0);
    expect(out).toEqual([VERSION]);
  });

  it('searches with an injected fetcher and prints a table', async () => {
    const { code, requests } = await exec(['search', 'gpu', '--sites', 'lazada-th'], {
      pages: {
        lazada: `<html>${page('Card One', '฿1,500')}${page('Card Two', '฿900', '/products/2.html')}</html>`,
      },
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    const text = out.join('\n');
    expect(text.indexOf('Card Two')).toBeLessThan(text.indexOf('Card One'));
    expect(text).toContain('฿900');
  });

  it('prints JSON with the documented fields', async () => {
    const { code } = await exec(['search', 'gpu', '--sites', 'lazada-th', '--json'], {
      pages: { lazada: `<html>${page('Card One', '฿1,500')}</html>` },
    });
    expect(code).toBe(0);
    const json = JSON.parse(out.join('\n'));
    expect(Object.keys(json)).toEqual(
      expect.arrayContaining([
        'query',
        'defaultsSource',
        'sites',
        'hits',
        'needsUserBrowser',
        'errors',
        'learned',
      ]),
    );
    expect(json.defaultsSource).toBe('builtin');
    expect(json.sites['lazada-th'].status).toBe('ok');
  });

  it('exits 1 when nothing is found and lists the user-browser sites', async () => {
    const { code } = await exec(['search', 'gpu', '--sites', 'lazada-th,shopee-th'], {
      pages: { lazada: '<html></html>' },
    });
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('shopee-th: needs the user');
  });

  it('exits 2 for unknown options, conditions and bad defaults', async () => {
    expect((await exec(['search', 'x', '--bogus'])).code).toBe(2);
    expect((await exec(['search', 'x', '--condition', 'shiny'])).code).toBe(2);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ currency: 'baht' }));
    const result = await exec(['search', 'x', '--defaults', bad]);
    expect(result.code).toBe(2);
    expect(err.join('\n')).toContain('currency');
  });

  it('records a block learning during a search', async () => {
    const { code } = await exec(['search', 'gpu', '--sites', 'lazada-th', '--json'], {
      pages: { lazada: '<html>captcha</html>' },
    });
    expect(code).toBe(1);
    const json = JSON.parse(out.join('\n'));
    expect(json.learned[0]).toMatchObject({ kind: 'block', site: 'lazada-th' });
    out.length = 0;
    await exec(['learn', 'list', '--json']);
    expect(JSON.parse(out.join('\n'))[0].kind).toBe('block');
    out.length = 0;
    await exec(['sites', '--json']);
    const sites = JSON.parse(out.join('\n'));
    expect(sites.find((s: { id: string }) => s.id === 'lazada-th').blocked).not.toBeNull();
    out.length = 0;
    const again = await exec(['search', 'gpu', '--sites', 'lazada-th', '--json'], {
      pages: { lazada: `<html>${page('A', '฿1')}</html>` },
    });
    expect(again.requests).toHaveLength(0);
    expect(JSON.parse(out.join('\n')).sites['lazada-th'].status).toBe('skipped');
  });

  it('shows, locates and validates defaults', async () => {
    await exec(['defaults', 'show', '--json']);
    expect(JSON.parse(out.join('\n')).source).toBe('builtin');
    out.length = 0;
    const file = join(dir, 'd.json');
    writeFileSync(file, JSON.stringify({ version: 1, budget: { style: 'premium' } }));
    expect((await exec(['defaults', 'validate', file])).code).toBe(0);
    expect(out.join('\n')).toContain('ok:');
    out.length = 0;
    await exec(['defaults', 'path', '--defaults', file, '--json']);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ source: 'flag', file });
    out.length = 0;
    writeFileSync(file, JSON.stringify({ budget: { style: 'fancy' } }));
    expect((await exec(['defaults', 'validate', file, '--json'])).code).toBe(2);
    expect(JSON.parse(out.join('\n')).ok).toBe(false);
    out.length = 0;
    await exec(['defaults', 'schema']);
    expect(JSON.parse(out.join('\n')).title).toBe('ShopperDefaults');
  });

  it('adds, lists and flushes learnings', async () => {
    expect(
      (await exec(['learn', 'add', '--kind', 'note', '--key', 'tip', '--value', '"use cash"']))
        .code,
    ).toBe(0);
    expect(
      (
        await exec([
          'learn',
          'add',
          '--kind',
          'block',
          '--site',
          'jib',
          '--key',
          'search',
          '--value',
          '{"r":1}',
          '--expires',
          '24h',
        ])
      ).code,
    ).toBe(0);
    out.length = 0;
    await exec(['learn', 'list', '--site', 'jib', '--json']);
    const listed = JSON.parse(out.join('\n'));
    expect(listed).toHaveLength(1);
    expect(listed[0].expires).toBe('2026-11-22T00:00:00.000Z');
    out.length = 0;
    expect((await exec(['learn', 'flush', '--json'])).code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({
      status: 'persisted',
      lines: 2,
      method: 'append',
    });
    expect(readFileSync(join(dir, 'mem', 'shopper', 'learnings.jsonl'), 'utf8')).toContain(
      'use cash',
    );
    expect(
      (await exec(['learn', 'add', '--kind', 'weird', '--key', 'k', '--value', '1'])).code,
    ).toBe(2);
  });

  it('exits 2 when flush has nowhere to write', async () => {
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'x');
    await exec(['learn', 'add', '--kind', 'note', '--key', 'k', '--value', '1']);
    const result = await exec(['learn', 'flush', '--memory-dir', join(blocker, 'x')]);
    expect(result.code).toBe(2);
    expect(err.join('\n')).toContain('AGENTS_MEMORY_PERSIST');
  });

  it('prints in-page scripts and refuses a missing one', async () => {
    expect((await exec(['script', 'shopee-th', 'search'])).code).toBe(0);
    expect(out.join('\n')).toContain('a[href*="-i."]');
    expect((await exec(['script', 'jib', 'search'])).code).toBe(2);
    expect((await exec(['script', 'nope', 'search'])).code).toBe(2);
  });

  it('parses a user-browser snapshot from stdin and from a file', async () => {
    const html = `<div>${page('Card One', '฿1,500').replace('data-qa-locator="product-item"', 'class="x"')}</div>`;
    const snapshot = JSON.stringify({ url: 'https://shopee.co.th/search?keyword=gpu', html });
    const custom = ['--url', 'https://shopee.co.th/search?keyword=gpu'];
    await exec([
      'learn',
      'add',
      '--kind',
      'selector',
      '--site',
      'shopee-th',
      '--key',
      'search.card',
      '--value',
      '".x"',
    ]);
    await exec([
      'learn',
      'add',
      '--kind',
      'selector',
      '--site',
      'shopee-th',
      '--key',
      'search.link',
      '--value',
      '"a"',
    ]);
    out.length = 0;
    const result = await exec(['parse', 'shopee-th', 'search', '--json'], { stdin: snapshot });
    expect(result.code).toBe(0);
    const json = JSON.parse(out.join('\n'));
    expect(json.hits[0]).toMatchObject({
      site: 'shopee-th',
      title: 'Card One',
      price: { amount: 1500 },
    });
    out.length = 0;
    const file = join(dir, 'snap.html');
    writeFileSync(file, html);
    const raw = await exec(['parse', 'shopee-th', 'search', '--file', file, ...custom, '--json']);
    expect(raw.code).toBe(0);
    expect((await exec(['parse', 'shopee-th', 'search'], { stdin: html })).code).toBe(2);
  });

  it('refuses a listing for a user-browser site and unknown URLs', async () => {
    const result = await exec(['listing', 'https://shopee.co.th/x-i.1.2']);
    expect(result.code).toBe(2);
    expect(result.requests).toHaveLength(0);
    expect(err.join('\n')).toContain('tab the user already has open');
    expect((await exec(['listing', 'https://example.com/'])).code).toBe(2);
  });

  it('reads a listing through the injected fetcher', async () => {
    const { code } = await exec(['listing', 'https://www.lazada.co.th/products/x.html', '--json'], {
      pages: { lazada: '<html><h1>Thing</h1><div class="pdp-price">฿10</div></html>' },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n')).title).toBe('Thing');
  });

  it('flags an unresolved condition when unmatched is ask', async () => {
    const file = join(dir, 'ask.json');
    writeFileSync(file, JSON.stringify({ version: 1, condition: { unmatched: 'ask' } }));
    const pages = { lazada: `<html>${page('Card One', '฿1,500')}</html>` };
    await exec(['search', 'gpu', '--sites', 'lazada-th', '--json', '--defaults', file], { pages });
    const json = JSON.parse(out.join('\n'));
    expect(json.conditionUnresolved).toBe(true);
    out.length = 0;
    await exec(['search', 'gpu', '--sites', 'lazada-th', '--defaults', file], { pages });
    expect(out.join('\n')).toContain('Ask the user which conditions');
    out.length = 0;
    await exec(
      ['search', 'gpu', '--sites', 'lazada-th', '--json', '--defaults', file, '--condition', 'new'],
      { pages },
    );
    expect(JSON.parse(out.join('\n')).conditionUnresolved).toBe(false);
  });

  it('shows the seen time in every configured zone, first zone first', async () => {
    const file = join(dir, 'zones.json');
    writeFileSync(
      file,
      JSON.stringify({ version: 1, report: { timeZones: ['Asia/Bangkok', 'Europe/London'] } }),
    );
    await exec(['search', 'gpu', '--sites', 'lazada-th', '--defaults', file], {
      pages: { lazada: `<html>${page('Card One', '฿1,500')}</html>` },
    });
    expect(out.join('\n')).toContain(
      '2026-11-21 07:00 Asia/Bangkok | 2026-11-21 00:00 Europe/London',
    );
  });

  it('prints warnings for unknown site ids and still validates', async () => {
    const file = join(dir, 'warn.json');
    writeFileSync(
      file,
      JSON.stringify({ version: 1, sites: { preferred: ['jib', 'facebook-marketplace'] } }),
    );
    const result = await exec(['defaults', 'validate', file]);
    expect(result.code).toBe(0);
    expect(out.join('\n')).toContain(
      "warning: sites.preferred: unknown site 'facebook-marketplace'",
    );
    out.length = 0;
    await exec(['defaults', 'validate', file, '--json']);
    expect(JSON.parse(out.join('\n')).warnings).toHaveLength(1);
    out.length = 0;
    const searched = await exec(['search', 'gpu', '--json', '--defaults', file], {
      pages: { jib: '<html></html>' },
    });
    expect(searched.requests).toHaveLength(1);
    const json = JSON.parse(out.join('\n'));
    expect(json.errors).toEqual([]);
    expect(json.warnings).toHaveLength(1);
  });

  it('lets SHOPPER_NOTIFY_CMD override watch.notifyCommand', async () => {
    const file = join(dir, 'notify.json');
    writeFileSync(file, JSON.stringify({ version: 1, watch: { notifyCommand: 'from-file' } }));
    await exec(['defaults', 'show', '--json', '--defaults', file]);
    expect(JSON.parse(out.join('\n')).defaults.watch.notifyCommand).toBe('from-file');
    out.length = 0;
    await exec(['defaults', 'show', '--json', '--defaults', file], {
      env: { SHOPPER_NOTIFY_CMD: 'from-env' },
    });
    expect(JSON.parse(out.join('\n')).defaults.watch.notifyCommand).toBe('from-env');
  });
});
