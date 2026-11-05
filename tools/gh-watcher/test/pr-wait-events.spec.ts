import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/index.js';
import {
  followPrEvents,
  parsePrEventsResponse,
  waitForPrEvent,
  type PrSnapshot,
  type PrWaitOptions,
  type PrWatchClient,
} from '../src/index.js';

const BASE = 'https://events.invalid';

function snap(overrides?: Partial<PrSnapshot>): PrSnapshot {
  return {
    number: 5,
    url: 'https://example.com/pull/5',
    title: 'Add feature',
    state: 'OPEN',
    isDraft: false,
    headSha: 'a'.repeat(40),
    headRef: 'feature',
    reviewDecision: null,
    comments: [],
    reviews: [],
    reviewComments: [],
    checkedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

interface Reply {
  latest_seq: number;
  owner_mode?: string;
  pr_events_subscribed?: boolean;
  events?: { seq: number; pr?: number; head_ref?: string; event?: string }[];
  /** Advances the fake clock by this many ms, as a long-poll would. */
  advanceMs?: number;
}

interface Env {
  client: PrWatchClient;
  fetchFn: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  urls: URL[];
  logs: string[];
  snapshotCalls: () => number;
  sleeps: number[];
}

function env(
  snapshots: PrSnapshot[],
  replies: (Reply | Response | Error)[],
  branchPrs: (number | undefined)[] = [],
): Env {
  let clock = 0;
  let snapshotCount = 0;
  let findCount = 0;
  let fetchCount = 0;
  const urls: URL[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const client: PrWatchClient = {
    prSnapshot: async () => {
      const next = snapshots[Math.min(snapshotCount, snapshots.length - 1)] as PrSnapshot;
      snapshotCount += 1;
      return next;
    },
    findPrForBranch: async () => {
      const next = branchPrs[Math.min(findCount, branchPrs.length - 1)];
      findCount += 1;
      return next;
    },
  };
  const fetchFn = (async (input: URL | string) => {
    urls.push(new URL(String(input)));
    const reply = replies[Math.min(fetchCount, replies.length - 1)] as Reply | Response | Error;
    fetchCount += 1;
    if (reply instanceof Error) {
      throw reply;
    }
    if (reply instanceof Response) {
      return reply;
    }
    clock += reply.advanceMs ?? 1000;
    return new Response(
      JSON.stringify({
        repo: 'o/r',
        owner_mode: reply.owner_mode ?? 'app',
        pr_events_subscribed: reply.pr_events_subscribed ?? true,
        latest_seq: reply.latest_seq,
        events: reply.events ?? [],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return {
    client,
    fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    urls,
    logs,
    snapshotCalls: () => snapshotCount,
    sleeps,
  };
}

function options(overrides?: Partial<PrWaitOptions>): PrWaitOptions {
  return {
    repo: 'octo-org/hello-world',
    target: { kind: 'pr', number: 5 },
    kinds: ['merged'],
    intervalMs: 1000,
    timeoutMs: 600_000,
    source: 'auto',
    eventsUrl: BASE,
    fallbackMs: 300_000,
    ...overrides,
  };
}

function deps(e: Env): Parameters<typeof waitForPrEvent>[1] {
  return { client: e.client, fetchFn: e.fetchFn, sleep: e.sleep, now: e.now, log: (line) => e.logs.push(line) };
}

const MERGED = snap({ state: 'MERGED', mergedAt: '2026-01-03T00:00:00Z' });

describe('pr wait in event mode', () => {
  it('wakes on a relay event for the pull request and confirms through gh', async () => {
    const e = env([snap(), MERGED], [{ latest_seq: 3 }, { latest_seq: 4, events: [{ seq: 4, pr: 5, event: 'pull_request' }] }]);
    const result = await waitForPrEvent(options(), deps(e));
    expect(result.kind).toBe('matched');
    expect(result.source).toBe('events');
    expect(result.events.map((event) => event.kind)).toEqual(['merged']);
    expect(e.snapshotCalls()).toBe(2);
    expect(e.sleeps).toEqual([]);
    expect(e.urls[0]?.pathname).toBe('/api/prs');
    expect(Object.fromEntries(e.urls[0]?.searchParams ?? [])).toEqual({
      repo: 'octo-org/hello-world',
      pr: '5',
      after: '0',
      wait: '0',
    });
    expect(e.urls[1]?.searchParams.get('after')).toBe('3');
    expect(Number(e.urls[1]?.searchParams.get('wait'))).toBeGreaterThan(0);
  });

  it('ignores events for other pull requests', async () => {
    const e = env(
      [snap(), MERGED],
      [
        { latest_seq: 1 },
        { latest_seq: 2, events: [{ seq: 2, pr: 99 }] },
        { latest_seq: 3, events: [{ seq: 3, pr: 5 }] },
      ],
    );
    const result = await waitForPrEvent(options(), deps(e));
    expect(result.kind).toBe('matched');
    expect(e.snapshotCalls()).toBe(2);
    expect(e.urls[2]?.searchParams.get('after')).toBe('2');
  });

  it('re-checks through gh on the fallback interval without events', async () => {
    const e = env([snap(), MERGED], [{ latest_seq: 1 }, { latest_seq: 1, advanceMs: 300_000 }]);
    const result = await waitForPrEvent(options(), deps(e));
    expect(result.kind).toBe('matched');
    expect(result.source).toBe('events');
    expect(e.snapshotCalls()).toBe(2);
  });

  it('times out in event mode', async () => {
    const e = env([snap()], [{ latest_seq: 1 }, { latest_seq: 1, advanceMs: 10_000 }]);
    const result = await waitForPrEvent(options({ timeoutMs: 25_000, fallbackMs: 1_000_000 }), deps(e));
    expect(result.kind).toBe('timeout');
    expect(result.source).toBe('events');
  });

  it('falls back to polling when the owner is not in app mode', async () => {
    const e = env([snap(), MERGED], [{ latest_seq: 1, owner_mode: 'poll' }]);
    const result = await waitForPrEvent(options(), deps(e));
    expect(result.kind).toBe('matched');
    expect(result.source).toBe('poll');
    expect(e.urls).toHaveLength(1);
    expect(e.logs).toHaveLength(1);
    expect(e.logs[0]).toContain('owner_mode=poll');
  });

  it('falls back to polling when pull request events are not subscribed', async () => {
    const e = env([snap(), MERGED], [{ latest_seq: 1, pr_events_subscribed: false }]);
    const result = await waitForPrEvent(options(), deps(e));
    expect(result.source).toBe('poll');
    expect(e.logs[0]).toContain('pr_events_subscribed=false');
  });

  it('treats HTTP 404 from the relay as unusable and polls', async () => {
    const e = env([snap(), MERGED], [new Response('not found', { status: 404 })]);
    const result = await waitForPrEvent(options(), deps(e));
    expect(result.source).toBe('poll');
    expect(e.logs[0]).toContain('HTTP 404');
  });

  it('polls for the rest of the wait when the relay fails mid-wait', async () => {
    const e = env([snap(), snap(), MERGED], [{ latest_seq: 1 }, new Error('connection reset')]);
    const result = await waitForPrEvent(options({ intervalMs: 2000 }), deps(e));
    expect(result.kind).toBe('matched');
    expect(result.source).toBe('poll');
    expect(e.urls).toHaveLength(2);
    expect(e.sleeps).toEqual([2000, 2000]);
    expect(e.logs[0]).toContain('connection reset');
  });

  it('re-checks after a relay restart and continues from the new sequence', async () => {
    const e = env(
      [snap(), snap(), MERGED],
      [
        { latest_seq: 50 },
        { latest_seq: 2 },
        { latest_seq: 3, events: [{ seq: 3, pr: 5 }] },
      ],
    );
    const result = await waitForPrEvent(options(), deps(e));
    expect(result.kind).toBe('matched');
    expect(result.source).toBe('events');
    expect(e.snapshotCalls()).toBe(3);
    expect(e.urls[1]?.searchParams.get('after')).toBe('50');
    expect(e.urls[2]?.searchParams.get('after')).toBe('2');
  });

  it('asks for the head branch while a branch target has no pull request, then for the number', async () => {
    const e = env(
      [snap()],
      [
        { latest_seq: 1 },
        { latest_seq: 2, events: [{ seq: 2, pr: 5, head_ref: 'feature', event: 'pull_request' }] },
        { latest_seq: 2, advanceMs: 600_000 },
      ],
      [undefined, undefined, 5],
    );
    const result = await waitForPrEvent(
      options({ target: { kind: 'branch', branch: 'feature' }, kinds: ['opened'] }),
      deps(e),
    );
    expect(result.kind).toBe('matched');
    expect(result.source).toBe('events');
    expect(result.events.map((event) => event.kind)).toEqual(['opened']);
    expect(Object.fromEntries(e.urls[0]?.searchParams ?? [])).toMatchObject({ head_ref: 'feature', after: '0' });
    expect(e.urls[0]?.searchParams.has('pr')).toBe(false);
  });

  it('follow ends in event mode when the pull request is merged', async () => {
    const e = env(
      [snap(), snap({ isDraft: true }), MERGED],
      [
        { latest_seq: 1 },
        { latest_seq: 2, events: [{ seq: 2, pr: 5 }] },
        { latest_seq: 3, events: [{ seq: 3, pr: 5 }] },
      ],
    );
    const kinds: string[] = [];
    const result = await followPrEvents(options({ kinds: ['draft', 'merged'] }), {
      ...deps(e),
      onEvent: (event) => kinds.push(event.kind),
    });
    expect(result.kind).toBe('ended');
    expect(result.source).toBe('events');
    expect(kinds).toEqual(['draft', 'merged']);
  });

  it('never contacts the relay with source poll', async () => {
    const e = env([snap(), MERGED], [new Error('must not be called')]);
    const result = await waitForPrEvent(options({ source: 'poll' }), deps(e));
    expect(result.source).toBe('poll');
    expect(e.urls).toHaveLength(0);
  });

  it('rejects source events without a URL', async () => {
    const e = env([snap()], [{ latest_seq: 1 }]);
    await expect(waitForPrEvent(options({ source: 'events', eventsUrl: undefined }), deps(e))).rejects.toThrow(
      /--source events needs an events URL/,
    );
  });

  it('with source events, uses the relay even when it is not in app mode', async () => {
    const e = env([snap(), MERGED], [{ latest_seq: 1, owner_mode: 'poll' }, { latest_seq: 2, events: [{ seq: 2, pr: 5 }] }]);
    const result = await waitForPrEvent(options({ source: 'events' }), deps(e));
    expect(result.source).toBe('events');
    expect(e.logs[0]).toContain('warning');
  });
});

describe('parsePrEventsResponse', () => {
  it('defaults the flags and rejects malformed bodies', () => {
    expect(parsePrEventsResponse({ latest_seq: 1, events: [] })).toMatchObject({
      owner_mode: 'unknown',
      pr_events_subscribed: false,
    });
    expect(() => parsePrEventsResponse({ latest_seq: 'x', events: [] })).toThrow(/malformed/);
    expect(() => parsePrEventsResponse({ latest_seq: 1, events: [{}] })).toThrow(/malformed/);
  });
});

describe('pr wait flags', () => {
  let previousUrl: string | undefined;
  let previousExitCode: string | number | undefined;
  beforeEach(() => {
    previousUrl = process.env['GH_WATCHER_EVENTS_URL'];
    delete process.env['GH_WATCHER_EVENTS_URL'];
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    if (previousUrl !== undefined) {
      process.env['GH_WATCHER_EVENTS_URL'] = previousUrl;
    }
    process.exitCode = previousExitCode;
  });

  it('exits 2 for --source events without a URL, on wait and follow', async () => {
    for (const command of ['wait', 'follow']) {
      process.exitCode = undefined;
      await run(['node', 'gh-watcher', 'pr', command, '--repo', 'octo-org/hello-world', '--pr', '5', '--source', 'events']);
      expect(process.exitCode).toBe(2);
    }
  });

  it('exits 2 for an invalid --source', async () => {
    await expect(
      run(['node', 'gh-watcher', 'pr', 'wait', '--repo', 'octo-org/hello-world', '--pr', '5', '--source', 'carrier-pigeon']),
    ).rejects.toThrow(/invalid --source/);
    expect(process.exitCode).toBe(2);
  });
});
