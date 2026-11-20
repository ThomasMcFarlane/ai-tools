import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendHistory,
  consecutiveFailures,
  lastSuccessfulHits,
  parseHistory,
  pendingEvents,
  previousState,
  readHistory,
  type HistoryLine,
} from '../src/core/watch/history.js';
import type { SiteOutcome } from '../src/core/watch/diff.js';
import { hit } from './helpers/hits.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shopper-history-'));
  file = join(dir, 'nested', 'x.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function line(n: number, sites: Record<string, SiteOutcome>, titles: string[] = []): HistoryLine {
  return {
    v: 1,
    ts: `2026-11-21T0${n}:00:00.000Z`,
    watchId: 'x',
    hits: titles.map((title) => hit({ site: title.startsWith('b') ? 'b' : 'a', title })),
    sites,
    errors: [],
    events: [],
    notified: true,
  };
}

describe('history file', () => {
  it('appends one JSON line per run and reads the last N', () => {
    for (let n = 1; n <= 4; n += 1) appendHistory(file, line(n, { a: { status: 'ok' } }));
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(4);
    expect(readHistory(file)).toHaveLength(4);
    expect(readHistory(file, 2).map((entry) => entry.ts)).toEqual([
      '2026-11-21T03:00:00.000Z',
      '2026-11-21T04:00:00.000Z',
    ]);
    expect(readHistory(file, 0)).toEqual([]);
  });

  it('reads a missing file as empty', () => {
    expect(readHistory(file)).toEqual([]);
  });

  it('skips blank, corrupt and foreign lines', () => {
    const good = JSON.stringify(line(1, { a: { status: 'ok' } }));
    const parsed = parseHistory(`${good}\n\n{broken\n{"v":2}\n[1]\n${good}`);
    expect(parsed).toHaveLength(2);
  });

  it('trims the oldest half when the file grows past the cap', () => {
    for (let n = 1; n <= 6; n += 1) {
      appendHistory(file, line(n, { a: { status: 'ok' } }), 600);
    }
    const kept = readHistory(file);
    expect(kept.length).toBeLessThan(6);
    expect(kept.at(-1)?.ts).toBe('2026-11-21T06:00:00.000Z');
  });
});

describe('notified flag', () => {
  const ev = (key: string, price: number) => ({
    type: 'new' as const,
    key,
    site: 'a',
    title: key,
    url: '',
    price: { amount: price, currency: 'THB' },
    stock: 'in_stock' as const,
  });

  it('defaults to true for old lines that lack it', () => {
    const old = { ...line(1, { a: { status: 'ok' } }) } as Partial<HistoryLine>;
    delete old.notified;
    expect(parseHistory(JSON.stringify(old))[0]?.notified).toBe(true);
    expect(parseHistory(JSON.stringify({ ...old, notified: false }))[0]?.notified).toBe(false);
  });

  it('collects events from the trailing undelivered lines only, newest winning', () => {
    const lines = [
      { ...line(1, {}), notified: false, events: [ev('old', 1)] },
      { ...line(2, {}), notified: true, events: [ev('delivered', 1)] },
      { ...line(3, {}), notified: false, events: [ev('k', 1), ev('x', 1)] },
      { ...line(4, {}), notified: false, events: [ev('k', 2)] },
    ];
    const pending = pendingEvents(lines);
    expect(pending.map((event) => `${event.key}:${event.price?.amount}`)).toEqual(['k:2', 'x:1']);
    expect(pendingEvents([...lines, { ...line(5, {}), notified: true }])).toEqual([]);
    expect(pendingEvents([])).toEqual([]);
  });
});

describe('previous state', () => {
  it('returns the hits of the last successful run per site', () => {
    const lines = [
      line(1, { a: { status: 'ok' }, b: { status: 'ok' } }, ['a1', 'b1']),
      line(2, { a: { status: 'ok' }, b: { status: 'error' } }, ['a2']),
    ];
    const hits = lastSuccessfulHits(lines);
    expect(hits.a?.map((entry) => entry.title)).toEqual(['a2']);
    expect(hits.b?.map((entry) => entry.title)).toEqual(['b1']);
  });

  it('treats an empty result as a success with no hits', () => {
    const hits = lastSuccessfulHits([
      line(1, { a: { status: 'ok' } }, ['a1']),
      line(2, { a: { status: 'empty' } }),
    ]);
    expect(hits.a).toEqual([]);
  });

  it('leaves out a site that never succeeded', () => {
    expect(lastSuccessfulHits([line(1, { a: { status: 'error' } })])).toEqual({});
  });

  it('counts consecutive failures and resets them on success', () => {
    const lines = [
      line(1, { a: { status: 'error' }, b: { status: 'ok' } }),
      line(2, { a: { status: 'blocked' }, b: { status: 'error' } }),
      line(3, {
        a: { status: 'skipped' },
        b: { status: 'ok' },
        c: { status: 'needs-user-browser' },
      }),
    ];
    expect(consecutiveFailures(lines)).toEqual({ a: 3, b: 0 });
  });

  it('flags a missing history', () => {
    expect(previousState([]).hasHistory).toBe(false);
    expect(previousState([line(1, { a: { status: 'ok' } })]).hasHistory).toBe(true);
  });

  it('survives a file that is not written by us at the end', () => {
    appendHistory(file, line(1, { a: { status: 'ok' } }, ['a1']));
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"v":1,"ts":`);
    expect(readHistory(file)).toHaveLength(1);
  });
});
