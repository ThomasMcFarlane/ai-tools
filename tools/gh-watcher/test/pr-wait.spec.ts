import { describe, expect, it } from 'vitest';
import {
  followPrEvents,
  RateLimitTimeoutError,
  waitForPrEvent,
  type PrEvent,
  type PrSnapshot,
  type PrWaitOptions,
  type PrWatchClient,
} from '../src/index.js';

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

interface Harness {
  client: PrWatchClient;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  snapshotCalls: () => number;
  findCalls: () => number;
  deadlines: (number | undefined)[];
}

/** Each snapshot call returns the next scripted snapshot, repeating the last one. */
function harness(snapshots: (PrSnapshot | Error)[], branchPrs: (number | undefined)[] = []): Harness {
  let clock = 0;
  let snapshotCount = 0;
  let findCount = 0;
  const deadlines: (number | undefined)[] = [];
  const client: PrWatchClient = {
    async prSnapshot() {
      const next = snapshots[Math.min(snapshotCount, snapshots.length - 1)];
      snapshotCount += 1;
      if (next instanceof Error) {
        throw next;
      }
      return next as PrSnapshot;
    },
    async findPrForBranch() {
      const next = branchPrs[Math.min(findCount, branchPrs.length - 1)];
      findCount += 1;
      return next;
    },
    setDeadline: (deadline) => {
      deadlines.push(deadline);
    },
  };
  return {
    client,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    snapshotCalls: () => snapshotCount,
    findCalls: () => findCount,
    deadlines,
  };
}

function options(overrides?: Partial<PrWaitOptions>): PrWaitOptions {
  return {
    repo: 'octo-org/hello-world',
    target: { kind: 'pr', number: 5 },
    kinds: ['merged'],
    intervalMs: 1000,
    timeoutMs: 10_000,
    changesOnly: false,
    ...overrides,
  };
}

describe('waitForPrEvent', () => {
  it('matches a wanted event found by a later poll and reports every event seen', async () => {
    const h = harness([
      snap(),
      snap({ comments: [{ id: 'c1', author: 'alice', createdAt: '2026-01-02T01:00:00Z', url: 'u' }] }),
      snap({
        state: 'MERGED',
        mergedAt: '2026-01-02T02:00:00Z',
        comments: [{ id: 'c1', author: 'alice', createdAt: '2026-01-02T01:00:00Z', url: 'u' }],
      }),
    ]);
    const result = await waitForPrEvent(options(), { client: h.client, sleep: h.sleep, now: h.now });
    expect(result.kind).toBe('matched');
    expect(result.events.map((event) => event.kind)).toEqual(['comment', 'merged']);
    expect(result.pr).toMatchObject({ number: 5, state: 'MERGED' });
    expect(result.source).toBe('poll');
    expect(h.snapshotCalls()).toBe(3);
  });

  it('returns at once when the baseline is already in a wanted state, marked initial', async () => {
    const h = harness([snap({ state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' })]);
    const result = await waitForPrEvent(options(), { client: h.client, sleep: h.sleep, now: h.now });
    expect(result.kind).toBe('matched');
    expect(result.events).toEqual([{ kind: 'merged', at: '2026-01-01T00:00:00Z', initial: true }]);
    expect(h.snapshotCalls()).toBe(1);
  });

  it('ignores the initial state with changesOnly', async () => {
    const h = harness([snap({ state: 'MERGED' })]);
    const result = await waitForPrEvent(options({ changesOnly: true, timeoutMs: 3000 }), {
      client: h.client,
      sleep: h.sleep,
      now: h.now,
    });
    expect(result.kind).toBe('timeout');
  });

  it('does not match the initial state for any', async () => {
    const h = harness([snap()]);
    const result = await waitForPrEvent(options({ kinds: ['opened', 'ready', 'merged'], any: true, timeoutMs: 2000 }), {
      client: h.client,
      sleep: h.sleep,
      now: h.now,
    });
    expect(result.kind).toBe('timeout');
  });

  it('counts items after --since even when the baseline already has them', async () => {
    const h = harness([
      snap({
        comments: [
          { id: 'c1', author: 'alice', createdAt: '2026-01-01T00:00:00Z', url: 'u1' },
          { id: 'c2', author: 'bob', createdAt: '2026-01-02T00:00:00Z', url: 'u2' },
        ],
      }),
    ]);
    const result = await waitForPrEvent(options({ kinds: ['comment'], since: '2026-01-01T12:00:00Z' }), {
      client: h.client,
      sleep: h.sleep,
      now: h.now,
    });
    expect(result.kind).toBe('matched');
    expect(result.events).toEqual([{ kind: 'comment', at: '2026-01-02T00:00:00Z', author: 'bob', url: 'u2' }]);
  });

  it('waits for a pull request to appear on a branch, then reports opened', async () => {
    const h = harness([snap()], [undefined, undefined, 5]);
    const result = await waitForPrEvent(options({ target: { kind: 'branch', branch: 'feature' }, kinds: ['opened'] }), {
      client: h.client,
      sleep: h.sleep,
      now: h.now,
    });
    expect(result.kind).toBe('matched');
    expect(result.events.map((event) => event.kind)).toEqual(['opened']);
    expect(h.findCalls()).toBe(3);
    expect(h.snapshotCalls()).toBe(1);
  });

  it('continues as a pull request target after the branch pull request appears', async () => {
    const h = harness([snap(), snap({ state: 'MERGED', mergedAt: '2026-01-03T00:00:00Z' })], [undefined, 5]);
    const result = await waitForPrEvent(options({ target: { kind: 'branch', branch: 'feature' }, kinds: ['merged'] }), {
      client: h.client,
      sleep: h.sleep,
      now: h.now,
    });
    expect(result.events.map((event) => event.kind)).toEqual(['opened', 'merged']);
  });

  it('uses the existing branch pull request as the baseline', async () => {
    const h = harness([snap({ isDraft: true }), snap({ isDraft: false })], [5]);
    const result = await waitForPrEvent(options({ target: { kind: 'branch', branch: 'feature' }, kinds: ['ready'] }), {
      client: h.client,
      sleep: h.sleep,
      now: h.now,
    });
    expect(result.events.map((event) => event.kind)).toEqual(['ready']);
    expect(h.findCalls()).toBe(1);
  });

  it('times out when nothing happens', async () => {
    const h = harness([snap()]);
    const ticks: number[] = [];
    const result = await waitForPrEvent(options({ timeoutMs: 3500 }), {
      client: h.client,
      sleep: h.sleep,
      now: h.now,
      onPoll: () => ticks.push(h.now()),
    });
    expect(result).toEqual({ kind: 'timeout', events: [], pr: expect.objectContaining({ number: 5 }), source: 'poll' });
    expect(ticks).toEqual([1000, 2000, 3000, 3500]);
    expect(h.deadlines[0]).toBe(3500);
    expect(h.deadlines.at(-1)).toBeUndefined();
  });

  it('maps a rate-limit timeout to a timeout result', async () => {
    const h = harness([snap(), new RateLimitTimeoutError(Date.now() + 1000)]);
    const result = await waitForPrEvent(options(), { client: h.client, sleep: h.sleep, now: h.now });
    expect(result.kind).toBe('timeout');
  });

  it('rethrows gh errors', async () => {
    const h = harness([snap(), new Error('gh pr view failed')]);
    await expect(waitForPrEvent(options(), { client: h.client, sleep: h.sleep, now: h.now })).rejects.toThrow(
      /gh pr view failed/,
    );
  });
});

describe('branch targets across pull requests', () => {
  it('reports opened when a new pull request replaces a merged one', async () => {
    const h = harness(
      [snap({ number: 5, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' }), snap({ number: 6 })],
      [5, 6],
    );
    const result = await waitForPrEvent(
      options({ target: { kind: 'branch', branch: 'feature' }, kinds: ['opened', 'merged'], changesOnly: true }),
      { client: h.client, sleep: h.sleep, now: h.now },
    );
    expect(result.kind).toBe('matched');
    expect(result.events.map((event) => event.kind)).toEqual(['opened']);
    expect(result.pr).toMatchObject({ number: 6 });
  });
});

describe('followPrEvents', () => {
  it('emits each wanted event and ends when the pull request is merged', async () => {
    const h = harness([
      snap(),
      snap({ isDraft: true }),
      snap({ isDraft: false }),
      snap({ state: 'MERGED', mergedAt: '2026-01-03T00:00:00Z' }),
    ]);
    const emitted: PrEvent[] = [];
    const result = await followPrEvents(options({ kinds: ['draft', 'ready', 'merged'], changesOnly: true }), {
      client: h.client,
      sleep: h.sleep,
      now: h.now,
      onEvent: (event) => emitted.push(event),
    });
    expect(result.kind).toBe('ended');
    expect(emitted.map((event) => event.kind)).toEqual(['draft', 'ready', 'merged']);
  });

  it('does not emit unwanted events', async () => {
    const h = harness([snap(), snap({ headSha: 'b'.repeat(40) }), snap({ headSha: 'b'.repeat(40), state: 'CLOSED' })]);
    const emitted: PrEvent[] = [];
    const result = await followPrEvents(options({ kinds: ['closed'] }), {
      client: h.client,
      sleep: h.sleep,
      now: h.now,
      onEvent: (event) => emitted.push(event),
    });
    expect(result.kind).toBe('ended');
    expect(emitted.map((event) => event.kind)).toEqual(['closed']);
    expect(result.events.map((event) => event.kind)).toEqual(['push', 'closed']);
  });

  it('times out while the pull request stays open', async () => {
    const h = harness([snap()]);
    const result = await followPrEvents(options({ timeoutMs: 2000 }), { client: h.client, sleep: h.sleep, now: h.now });
    expect(result.kind).toBe('timeout');
  });
});
