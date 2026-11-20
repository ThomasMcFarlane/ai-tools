import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchMode, PageSnapshot, ParseCtx, SiteAdapter } from '../../src/core/types.js';

export const FIXTURE_NOW = '2026-11-21T00:00:00.000Z';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));

export interface FixtureOptions {
  url?: string;
  mode?: FetchMode;
  data?: unknown;
}

export function loadFixture(id: string, name: string, opts: FixtureOptions = {}): PageSnapshot {
  const base = join(FIXTURE_ROOT, id, name);
  const html = readFileSync(`${base}.html`, 'utf8');
  const dataFile = `${base}.data.json`;
  const data =
    opts.data !== undefined
      ? opts.data
      : existsSync(dataFile)
        ? (JSON.parse(readFileSync(dataFile, 'utf8')) as unknown)
        : undefined;
  const snapshot: PageSnapshot = {
    url: opts.url ?? `https://example.com/${id}/${name}`,
    html,
    fetchedAt: FIXTURE_NOW,
    mode: opts.mode ?? 'headless',
  };
  if (data !== undefined) snapshot.data = data;
  return snapshot;
}

export function fixtureCtx(adapter: SiteAdapter, selectors: Record<string, string> = {}): ParseCtx {
  return {
    selectors: { ...adapter.selectors, ...selectors },
    now: FIXTURE_NOW,
    currency: adapter.currency,
  };
}
