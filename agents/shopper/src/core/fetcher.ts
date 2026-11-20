import {
  fetchText,
  launchBrowser,
  type BrowserSession,
  type FetchTextOptions,
  type FetchTextResult,
} from '@ai-tools/agent-kit';
import { ShopperError, type FetchCookie, type FetchMode, type PageSnapshot } from './types.js';

export interface FetchRequest {
  url: string;
  mode: FetchMode;
  script?: string;
  cookies?: FetchCookie[];
  timeoutMs?: number;
}

export interface Fetcher {
  fetch(request: FetchRequest): Promise<PageSnapshot>;
  close(): Promise<void>;
}

export class UserBrowserRequiredError extends ShopperError {
  constructor(url: string) {
    super(`${url} must be read from a tab the user already has open; the CLI never fetches it`);
    this.name = 'UserBrowserRequiredError';
  }
}

export interface FetcherDeps {
  fetchText?: (url: string, opts?: FetchTextOptions) => Promise<FetchTextResult>;
  launch?: () => Promise<BrowserSession>;
  now?: () => Date;
}

export function createFetcher(deps: FetcherDeps = {}): Fetcher {
  const http = deps.fetchText ?? fetchText;
  const launch = deps.launch ?? (() => launchBrowser());
  const now = deps.now ?? (() => new Date());
  let session: Promise<BrowserSession> | null = null;

  async function viaHttp(request: FetchRequest): Promise<PageSnapshot> {
    const result = await http(request.url, { timeoutMs: request.timeoutMs ?? 20_000 });
    return {
      url: result.url,
      html: result.text,
      fetchedAt: now().toISOString(),
      mode: 'http',
    };
  }

  async function viaBrowser(request: FetchRequest): Promise<PageSnapshot> {
    session ??= launch();
    const browser = await session;
    const page = await browser.newPage();
    try {
      if (request.cookies !== undefined && request.cookies.length > 0) {
        await page.setCookies(request.cookies);
      }
      await page.goto(request.url, { timeoutMs: request.timeoutMs ?? 30_000 });
      const snapshot: PageSnapshot = {
        url: await page.url(),
        html: '',
        fetchedAt: now().toISOString(),
        mode: 'headless',
      };
      if (request.script !== undefined) snapshot.data = await page.evaluate(request.script);
      snapshot.html = await page.content();
      return snapshot;
    } finally {
      await page.close();
    }
  }

  return {
    async fetch(request) {
      if (request.mode === 'user-browser') throw new UserBrowserRequiredError(request.url);
      return request.mode === 'http' ? viaHttp(request) : viaBrowser(request);
    },
    async close() {
      const pending = session;
      session = null;
      if (pending === null) return;
      try {
        await (await pending).close();
      } catch {
        return;
      }
    },
  };
}
