import { describe, expect, it } from 'vitest';
import { followPrEvents, prStatusToSnapshot, parsePrStatusResponse, RelayUnreachableError, waitForPrEvent, type PrWaitOptions } from '../src/index.js';
import { fakeClock, fakeRelay, prStatus, REPO } from './relay-fakes.js';

const options: PrWaitOptions = {
  repo: REPO,
  target: { kind: 'pr', number: 7 },
  kinds: ['comment', 'merged'],
  timeoutMs: 600_000,
  eventsUrl: 'http://relay.invalid',
};

describe('pr wait through the relay', () => {
  it('matches a new comment seen in a later pr-status answer', async () => {
    const clock = fakeClock();
    const relay = fakeRelay([
      prStatus(1),
      prStatus(2, { latest_comment: { id: 11, user: { login: 'alice' }, created_at: '2026-01-01T01:00:00Z', updated_at: '2026-01-01T01:00:00Z' } }),
    ]);
    const result = await waitForPrEvent({ ...options, any: true }, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: () => undefined });
    expect(result.kind).toBe('matched');
    expect(result.events.map((event) => event.kind)).toEqual(['comment']);
    expect(result.source).toBe('relay');
    expect(relay.urls.every((url) => url.pathname === '/api/pr-status')).toBe(true);
    expect(relay.urls[1]?.searchParams.get('after')).toBe('1');
    expect(relay.urls[1]?.searchParams.get('pr')).toBe('7');
  });

  it('matches a state that already holds, unless --changes-only', async () => {
    const clock = fakeClock();
    const merged = prStatus(1, { state: 'merged', merged_at: '2026-01-01T00:30:00Z' });
    const relay = fakeRelay([merged]);
    const result = await waitForPrEvent(options, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: () => undefined });
    expect(result.kind).toBe('matched');
    expect(result.events[0]).toMatchObject({ kind: 'merged', initial: true });
    expect(relay.urls).toHaveLength(1);
  });

  it('sends since and matches on the since arrays, so older matches are not missed', async () => {
    const clock = fakeClock();
    const item = (id: number, login: string, at: string): Record<string, unknown> => ({ id, user: { login }, created_at: at, updated_at: at });
    const relay = fakeRelay([
      prStatus(1, {
        comments: [item(2, 'b', '2026-01-01T02:00:00Z'), item(3, 'e', '2026-01-01T04:00:00Z')],
        review_comments: [item(4, 'd', '2026-01-01T03:00:00Z')],
        reviews: [{ id: 5, user: { login: 'c' }, state: 'approved', submitted_at: '2026-01-01T03:30:00Z' }],
        latest_comment: item(3, 'e', '2026-01-01T04:00:00Z'),
        truncated: false,
      }),
    ]);
    const result = await waitForPrEvent(
      { ...options, kinds: ['comment', 'review', 'review_comment'], since: '2026-01-01T01:00:00Z' },
      { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: () => undefined },
    );
    expect(relay.urls[0]?.searchParams.get('since')).toBe('2026-01-01T01:00:00Z');
    expect(result.events.map((event) => `${event.kind}:${event.author ?? ''}`).sort()).toEqual(['comment:b', 'comment:e', 'review:c', 'review_comment:d']);
  });

  it('falls back to latest_* when the since arrays are absent', async () => {
    const clock = fakeClock();
    const relay = fakeRelay([
      prStatus(1, { latest_comment: { id: 2, user: { login: 'b' }, created_at: '2026-01-01T02:00:00Z', updated_at: '2026-01-01T02:00:00Z' } }),
    ]);
    const result = await waitForPrEvent(
      { ...options, kinds: ['comment'], since: '2026-01-01T01:00:00Z' },
      { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: () => undefined },
    );
    expect(result.events.map((event) => event.author)).toEqual(['b']);
  });

  it('resets after to 0 when boot changes, never keeping the old revision', async () => {
    const clock = fakeClock();
    const relay = fakeRelay([prStatus(50), prStatus(3, { boot: 'boot-2' }), prStatus(4, { boot: 'boot-2' }), prStatus(5, { boot: 'boot-2', state: 'merged' })]);
    const result = await followPrEvents({ ...options, any: true }, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: () => undefined });
    expect(result.kind).toBe('ended');
    expect(relay.urls.map((url) => url.searchParams.get('after'))).toEqual(['0', '50', '0', '4']);
  });

  it('maps user to author and needs no title or closed_at', () => {
    const response = parsePrStatusResponse(
      prStatus(1, {
        latest_comment: { id: 5, user: { login: 'x' }, created_at: '2026-01-01T01:00:00Z', updated_at: '2026-01-01T01:00:00Z' },
        latest_review: { id: 6, user: 'y', state: 'approved', submitted_at: '2026-01-01T02:00:00Z' },
      }),
    );
    const snap = prStatusToSnapshot(response);
    expect(snap?.comments).toEqual([{ id: '5', author: 'x', createdAt: '2026-01-01T01:00:00Z', url: '' }]);
    expect(snap?.reviews[0]).toMatchObject({ id: '6', author: 'y', state: 'APPROVED' });
    expect(snap?.title).toBe('');
    expect(snap?.closedAt).toBeUndefined();
    expect(snap?.mergedAt).toBeUndefined();
    expect(snap?.url).toBe('https://example.com/pull/7');
  });

  it('treats a null pr as no pull request', () => {
    expect(prStatusToSnapshot(parsePrStatusResponse(prStatus(1, { pr: null, state: 'none' })))).toBeUndefined();
  });

  it('times out and prints the relay warning once', async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    const relay = fakeRelay([prStatus(1, { warning: 'relay polls' })], () => {
      void clock.sleep(25_000);
    });
    const result = await waitForPrEvent({ ...options, any: true, timeoutMs: 60_000 }, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: (line) => logs.push(line) });
    expect(result).toMatchObject({ kind: 'timeout', warning: 'relay polls' });
    expect(logs.filter((line) => line.includes('relay polls'))).toHaveLength(1);
  });

  it('follow ends when the pull request is merged', async () => {
    const clock = fakeClock();
    const relay = fakeRelay([prStatus(1), prStatus(2, { state: 'merged', merged_at: '2026-01-01T05:00:00Z' })]);
    const seen: string[] = [];
    const result = await followPrEvents({ ...options, any: true }, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: () => undefined, onEvent: (event) => seen.push(event.kind) });
    expect(result.kind).toBe('ended');
    expect(seen).toEqual(['merged']);
  });

  it('waits for a branch pull request that does not exist yet', async () => {
    const clock = fakeClock();
    const relay = fakeRelay([prStatus(1, { state: 'none', pr: null }), prStatus(2)]);
    const result = await waitForPrEvent({ ...options, target: { kind: 'branch', branch: 'feature' }, kinds: ['opened'] }, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: () => undefined });
    expect(result.kind).toBe('matched');
    expect(relay.urls[0]?.searchParams.get('branch')).toBe('feature');
  });

  it('throws relay_unreachable when the relay is down until the timeout', async () => {
    const clock = fakeClock();
    const relay = fakeRelay([new Error('down')]);
    await expect(
      waitForPrEvent({ ...options, timeoutMs: 20_000 }, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: () => undefined }),
    ).rejects.toBeInstanceOf(RelayUnreachableError);
  });
});
