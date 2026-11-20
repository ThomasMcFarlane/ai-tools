import { describe, expect, it } from 'vitest';
import type { BrowserSession } from '@ai-tools/agent-kit';
import { UserBrowserRequiredError, createFetcher } from '../src/core/fetcher.js';

const NOW = new Date('2026-11-21T00:00:00.000Z');

function fakeBrowser() {
  const log: string[] = [];
  const page = {
    setCookies: async (cookies: unknown[]) => void log.push(`cookies:${cookies.length}`),
    goto: async (url: string) => void log.push(`goto:${url}`),
    url: async () => 'https://example.com/final',
    evaluate: async (script: string) => {
      log.push(`eval:${script}`);
      return { ok: true };
    },
    content: async () => '<html>page</html>',
    close: async () => void log.push('page-closed'),
  };
  const session = {
    newPage: async () => page,
    close: async () => void log.push('browser-closed'),
  } as unknown as BrowserSession;
  let launches = 0;
  return {
    log,
    launch: async () => {
      launches += 1;
      return session;
    },
    launches: () => launches,
  };
}

describe('createFetcher', () => {
  it('fetches over HTTP', async () => {
    const fetcher = createFetcher({
      fetchText: async (url) => ({ url, status: 200, text: '<p>hi</p>', headers: {} }),
      now: () => NOW,
    });
    const snap = await fetcher.fetch({ url: 'https://example.com/', mode: 'http' });
    expect(snap).toEqual({
      url: 'https://example.com/',
      html: '<p>hi</p>',
      fetchedAt: NOW.toISOString(),
      mode: 'http',
    });
  });

  it('never fetches a user-browser page', async () => {
    const fetcher = createFetcher({
      fetchText: async () => {
        throw new Error('must not be called');
      },
    });
    await expect(
      fetcher.fetch({ url: 'https://example.com/', mode: 'user-browser' }),
    ).rejects.toBeInstanceOf(UserBrowserRequiredError);
  });

  it('renders headless pages with one shared browser, runs the script and closes everything', async () => {
    const browser = fakeBrowser();
    const fetcher = createFetcher({ launch: browser.launch, now: () => NOW });
    const first = await fetcher.fetch({
      url: 'https://example.com/a',
      mode: 'headless',
      script: '1+1',
      cookies: [{ name: 'a', value: 'b', domain: 'example.com' }],
    });
    await fetcher.fetch({ url: 'https://example.com/b', mode: 'headless' });
    expect(browser.launches()).toBe(1);
    expect(first).toMatchObject({
      url: 'https://example.com/final',
      html: '<html>page</html>',
      data: { ok: true },
      mode: 'headless',
    });
    expect(browser.log).toContain('cookies:1');
    expect(browser.log.filter((entry) => entry === 'page-closed')).toHaveLength(2);
    await fetcher.close();
    expect(browser.log.at(-1)).toBe('browser-closed');
  });

  it('does not launch a browser when none was needed', async () => {
    const browser = fakeBrowser();
    const fetcher = createFetcher({ launch: browser.launch });
    await fetcher.close();
    expect(browser.launches()).toBe(0);
  });
});
