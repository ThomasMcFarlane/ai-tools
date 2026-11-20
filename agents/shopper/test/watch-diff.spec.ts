import { describe, expect, it } from 'vitest';
import { WATCH_EVENTS } from '../src/core/defaults.js';
import {
  EMPTY_PREVIOUS,
  canonicalUrl,
  diffRun,
  hitKey,
  type DiffOptions,
  type PreviousState,
  type SiteOutcome,
} from '../src/core/watch/diff.js';
import type { SearchHit, Stock } from '../src/core/types.js';
import { hit } from './helpers/hits.js';

const OPTIONS: DiffOptions = {
  maxPrice: null,
  minDropPercent: 0,
  currency: 'THB',
  notifyOn: WATCH_EVENTS,
};

const OK: Record<string, SiteOutcome> = { a: { status: 'ok' } };

function priced(title: string, amount: number | null, extra: Partial<SearchHit> = {}): SearchHit {
  return hit({
    title,
    url: `https://a.example.com/p/${title}`,
    price: amount === null ? null : { amount, currency: 'THB' },
    ...extra,
  });
}

function previous(
  hits: SearchHit[],
  failures: Record<string, number> = {},
  sites: string[] = ['a'],
): PreviousState {
  const recent: Record<string, SearchHit[][]> = {};
  for (const site of sites) {
    const own = hits.filter((entry) => entry.site === site);
    recent[site] = own.length > 0 ? [own] : [];
  }
  return { hasHistory: true, recent, failures };
}

function runs(
  snapshots: SearchHit[][],
  failures: Record<string, number> = {},
  site = 'a',
): PreviousState {
  return { hasHistory: true, recent: { [site]: snapshots }, failures };
}

function run(
  hits: SearchHit[],
  before: PreviousState,
  options: Partial<DiffOptions> = {},
  sites: Record<string, SiteOutcome> = OK,
) {
  return diffRun({ hits, sites, previous: before, options: { ...OPTIONS, ...options } });
}

const types = (events: Array<{ type: string }>) => events.map((event) => event.type);

describe('canonical key', () => {
  it('drops the query string, fragment, trailing slash and host case', () => {
    expect(canonicalUrl('https://Shop.example.com/p/1/?utm=x#top')).toBe(
      'https://shop.example.com/p/1',
    );
    expect(canonicalUrl('https://shop.example.com/')).toBe('https://shop.example.com/');
  });

  it('keeps only the id parameters that the adapter names', () => {
    expect(canonicalUrl('https://s.example.com/view?b=2&id=7&utm=x', ['id'])).toBe(
      'https://s.example.com/view?id=7',
    );
    expect(
      hitKey({ site: 'jib', url: 'https://s.example.com/view?id=7&utm=1' }, { jib: ['id'] }),
    ).toBe('jib https://s.example.com/view?id=7');
  });

  it('falls back to a plain strip for text that is not a URL', () => {
    expect(canonicalUrl('/relative/path?x=1')).toBe('/relative/path');
  });

  it('treats the same page with another query string as the same hit', () => {
    const before = previous([priced('x', 100, { url: 'https://a.example.com/p/x?ref=1' })]);
    const now = [priced('x', 100, { url: 'https://a.example.com/p/x?ref=2#z' })];
    expect(run(now, before)).toEqual([]);
  });
});

describe('baseline run', () => {
  it('emits nothing without a threshold', () => {
    expect(run([priced('x', 100)], EMPTY_PREVIOUS)).toEqual([]);
  });

  it('emits only threshold events for hits at or below maxPrice', () => {
    const events = run([priced('cheap', 100), priced('dear', 900)], EMPTY_PREVIOUS, {
      maxPrice: 100,
    });
    expect(types(events)).toEqual(['threshold']);
    expect(events[0]?.title).toBe('cheap');
  });

  it('treats a site with no earlier success as a baseline of its own', () => {
    const before = previous([priced('x', 100)], {}, ['a']);
    const other = hit({ site: 'b', title: 'y', url: 'https://b.example.com/y' });
    const events = run([other], before, {}, { a: { status: 'ok' }, b: { status: 'ok' } });
    expect(events).toEqual([]);
  });
});

describe('new', () => {
  it('fires for a key that was absent before', () => {
    const events = run([priced('old', 100), priced('fresh', 50)], previous([priced('old', 100)]));
    expect(types(events)).toEqual(['new']);
    expect(events[0]).toMatchObject({ title: 'fresh', site: 'a', stock: 'in_stock' });
  });

  it('fires for a site that was reachable but empty before', () => {
    expect(types(run([priced('x', 10)], previous([])))).toEqual(['new']);
  });

  it('baselines a site that was never seen', () => {
    expect(run([priced('x', 10)], { hasHistory: true, recent: {}, failures: {} })).toEqual([]);
  });

  it('lists the same listing once when a site repeats it', () => {
    const events = run([priced('dup', 90), priced('dup', 80)], previous([priced('seed', 1000)]));
    expect(events).toHaveLength(1);
    expect(events[0]?.price?.amount).toBe(80);
  });
});

describe('failed sites', () => {
  const failed: Record<string, SiteOutcome> = { a: { status: 'error', reason: 'timeout' } };

  it('never cause new events while they fail', () => {
    expect(run([], previous([priced('x', 100)]), {}, failed)).toEqual([]);
  });

  it('do not cause false new events after recovery', () => {
    const lastGood = previous([priced('x', 100)], { a: 1 });
    expect(run([priced('x', 100)], lastGood)).toEqual([]);
  });

  it('still report a real new hit after recovery', () => {
    const lastGood = previous([priced('x', 100)], { a: 2 });
    expect(types(run([priced('x', 100), priced('y', 100)], lastGood))).toEqual(['new']);
  });

  it('give no events for hits that a failed site somehow carries', () => {
    expect(run([priced('z', 1)], previous([]), {}, failed)).toEqual([]);
  });

  it('count blocked and skipped as failures, and ignore needs-user-browser', () => {
    const base = previous([], { a: 2, b: 2, c: 2 }, []);
    const events = run(
      [],
      base,
      {},
      {
        a: { status: 'blocked' },
        b: { status: 'skipped' },
        c: { status: 'needs-user-browser' },
      },
    );
    expect(events.map((event) => event.site)).toEqual(['a', 'b']);
  });
});

describe('churn and empty results', () => {
  const x = (amount: number, extra: Partial<SearchHit> = {}) => priced('x', amount, extra);
  const y = priced('y', 50);

  it('does not call a listing new when it was absent for one run and is back', () => {
    const before = runs([[x(100), y], [y]]);
    expect(run([x(100), y], before)).toEqual([]);
  });

  it('still reports a price drop for a listing that came back cheaper', () => {
    const before = runs([[x(100), y], [y]]);
    const events = run([x(80), y], before);
    expect(types(events)).toEqual(['price_drop']);
    expect(events[0]?.previousPrice?.amount).toBe(100);
  });

  it('still reports back_in_stock and threshold against the last known listing', () => {
    const before = runs([[x(500, { stock: 'out_of_stock' }), y], [y]]);
    const events = run([x(90), y], before, { maxPrice: 100 });
    expect(types(events)).toEqual(['price_drop', 'back_in_stock', 'threshold']);
  });

  it('reports new only when the key is missing from the last 5 snapshots', () => {
    const before = runs([[y], [y], [y], [y], [y]]);
    expect(types(run([x(1), y], before))).toEqual(['new']);
    const older = runs([[x(1)], [y], [y], [y], [y]]);
    expect(types(run([x(1), y], older))).toEqual([]);
  });

  it('treats an empty result as a failure and not as a snapshot', () => {
    const empty: Record<string, SiteOutcome> = { a: { status: 'empty' } };
    expect(run([], runs([[x(100)]]), {}, empty)).toEqual([]);
    const third = run([], runs([[x(100)]], { a: 2 }), {}, empty);
    expect(types(third)).toEqual(['scanner_failing']);
    expect(third[0]?.note).toContain('no listings');
    expect(run([], runs([[x(100)]], { a: 3 }), {}, empty)).toEqual([]);
  });

  it('treats ok with no hits like an empty result', () => {
    const events = run([], runs([[x(100)]], { a: 2 }), {}, { a: { status: 'ok' } });
    expect(types(events)).toEqual(['scanner_failing']);
  });

  it('gives no false new after empty then normal', () => {
    const before = runs([[x(100), y]], { a: 1 });
    expect(run([x(100), y], before)).toEqual([]);
  });

  it('reports the recovery after three empty runs, without false new events', () => {
    const before = runs([[x(100), y]], { a: 3 });
    const events = run([x(100), y], before);
    expect(types(events)).toEqual(['scanner_failing']);
    expect(events[0]?.recovered).toBe(true);
  });
});

describe('price_drop', () => {
  it('fires when the price falls', () => {
    const events = run([priced('x', 90)], previous([priced('x', 100)]));
    expect(types(events)).toEqual(['price_drop']);
    expect(events[0]).toMatchObject({
      price: { amount: 90, currency: 'THB' },
      previousPrice: { amount: 100, currency: 'THB' },
    });
  });

  it('stays silent when the price is equal or higher', () => {
    expect(run([priced('x', 100)], previous([priced('x', 100)]))).toEqual([]);
    expect(run([priced('x', 120)], previous([priced('x', 100)]))).toEqual([]);
  });

  it('needs a drop of more than minDropPercent', () => {
    const before = previous([priced('x', 1000)]);
    expect(run([priced('x', 900)], before, { minDropPercent: 10 })).toEqual([]);
    expect(types(run([priced('x', 899)], before, { minDropPercent: 10 }))).toEqual(['price_drop']);
    expect(types(run([priced('x', 900)], before, { minDropPercent: 9.9 }))).toEqual(['price_drop']);
  });

  it('ignores missing prices and other currencies', () => {
    expect(run([priced('x', null)], previous([priced('x', 100)]))).toEqual([]);
    expect(run([priced('x', 50)], previous([priced('x', null)]))).toEqual([]);
    const usd = priced('x', 50, { price: { amount: 50, currency: 'USD' } });
    expect(run([usd], previous([priced('x', 100)]))).toEqual([]);
  });
});

describe('back_in_stock', () => {
  const stocked = (stock: Stock) => priced('x', 100, { stock });

  it('fires from out_of_stock to in_stock or low_stock', () => {
    const before = previous([stocked('out_of_stock')]);
    const events = run([stocked('in_stock')], before);
    expect(types(events)).toEqual(['back_in_stock']);
    expect(events[0]?.previousStock).toBe('out_of_stock');
    expect(types(run([stocked('low_stock')], before))).toEqual(['back_in_stock']);
  });

  it('stays silent for unknown, preorder and still out of stock', () => {
    expect(run([stocked('in_stock')], previous([stocked('unknown')]))).toEqual([]);
    expect(run([stocked('preorder')], previous([stocked('out_of_stock')]))).toEqual([]);
    expect(run([stocked('out_of_stock')], previous([stocked('out_of_stock')]))).toEqual([]);
  });

  it('stays silent when stock goes down', () => {
    expect(run([stocked('out_of_stock')], previous([stocked('in_stock')]))).toEqual([]);
  });
});

describe('threshold', () => {
  const options = { maxPrice: 100 };

  it('fires for a new hit at or below the threshold, next to new', () => {
    const events = run([priced('n', 100)], previous([priced('seed', 1000)]), options);
    expect(types(events)).toEqual(['new', 'threshold']);
  });

  it('does not fire for a new hit above the threshold', () => {
    expect(types(run([priced('n', 101)], previous([priced('seed', 1000)]), options))).toEqual([
      'new',
    ]);
  });

  it('fires when a known hit crosses the threshold', () => {
    const events = run([priced('x', 95)], previous([priced('x', 120)]), options);
    expect(types(events)).toEqual(['price_drop', 'threshold']);
  });

  it('fires once: not again while the price stays at or below', () => {
    const first = run([priced('x', 95)], previous([priced('x', 120)]), options);
    expect(types(first)).toContain('threshold');
    expect(run([priced('x', 95)], previous([priced('x', 95)]), options)).toEqual([]);
    expect(types(run([priced('x', 90)], previous([priced('x', 95)]), options))).toEqual([
      'price_drop',
    ]);
  });

  it('fires again after the price went above and came back', () => {
    expect(types(run([priced('x', 90)], previous([priced('x', 130)]), options))).toContain(
      'threshold',
    );
  });

  it('fires when the earlier price is missing', () => {
    expect(types(run([priced('x', 90)], previous([priced('x', null)]), options))).toEqual([
      'threshold',
    ]);
  });

  it('is off without maxPrice and for other currencies', () => {
    expect(run([priced('x', 1)], previous([priced('x', 1)]))).toEqual([]);
    const usd = priced('x', 1, { price: { amount: 1, currency: 'USD' } });
    expect(
      run([usd], previous([priced('seed', 1000)]), options).map((event) => event.type),
    ).toEqual(['new']);
  });
});

describe('scanner_failing', () => {
  const failed: Record<string, SiteOutcome> = { a: { status: 'error', reason: 'timeout' } };

  it('fires on the third failure in a row, once', () => {
    expect(run([], previous([], { a: 1 }), {}, failed)).toEqual([]);
    const third = run([], previous([], { a: 2 }), {}, failed);
    expect(types(third)).toEqual(['scanner_failing']);
    expect(third[0]).toMatchObject({ site: 'a', price: null, url: '' });
    expect(third[0]?.note).toContain('timeout');
    expect(run([], previous([], { a: 3 }), {}, failed)).toEqual([]);
    expect(run([], previous([], { a: 7 }), {}, failed)).toEqual([]);
  });

  it('reports the recovery as a note', () => {
    const events = run([priced('x', 1)], previous([priced('x', 1)], { a: 3 }));
    expect(types(events)).toEqual(['scanner_failing']);
    expect(events[0]).toMatchObject({ recovered: true });
    expect(events[0]?.note).toBe('recovered after 3 failed runs');
  });

  it('is quiet after a short failure streak', () => {
    expect(run([priced('x', 1)], previous([priced('x', 1)], { a: 2 }))).toEqual([]);
  });
});

describe('notifyOn filter', () => {
  it('keeps only the chosen event types', () => {
    const before = previous([priced('x', 100)]);
    const now = [priced('x', 50), priced('y', 50)];
    expect(types(run(now, before, { maxPrice: 60 }))).toEqual([
      'new',
      'price_drop',
      'threshold',
      'threshold',
    ]);
    expect(types(run(now, before, { maxPrice: 60, notifyOn: ['price_drop'] }))).toEqual([
      'price_drop',
    ]);
    expect(run(now, before, { notifyOn: [] })).toEqual([]);
  });

  it('drops scanner events that are not wanted', () => {
    const failed: Record<string, SiteOutcome> = { a: { status: 'error' } };
    expect(run([], previous([], { a: 2 }), { notifyOn: ['new'] }, failed)).toEqual([]);
  });
});

describe('ordering', () => {
  it('sorts by event type, then site and key', () => {
    const before = previous([priced('p', 100), priced('q', 100)]);
    const events = run([priced('q', 10), priced('p', 10), priced('z', 10)], before);
    expect(events.map((event) => `${event.type}:${event.title}`)).toEqual([
      'new:z',
      'price_drop:p',
      'price_drop:q',
    ]);
  });
});
