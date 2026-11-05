import { describe, expect, it } from 'vitest';
import {
  describePrEvent,
  diffPr,
  latestReviewPerAuthor,
  lastStateToBase,
  parseEventKinds,
  sinceEvents,
  stateEvents,
  toLastState,
  PR_EVENT_KINDS,
  type PrSnapshot,
} from '../src/index.js';

function snapshot(overrides?: Partial<PrSnapshot>): PrSnapshot {
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

describe('diffPr', () => {
  it('yields opened when there was no previous pull request', () => {
    expect(diffPr(undefined, snapshot()).map((event) => event.kind)).toEqual(['opened']);
  });

  it('yields nothing when nothing changed', () => {
    expect(diffPr(snapshot(), snapshot())).toEqual([]);
  });

  it('detects merged with the merge time', () => {
    const events = diffPr(snapshot(), snapshot({ state: 'MERGED', mergedAt: '2026-01-03T00:00:00Z' }));
    expect(events).toEqual([{ kind: 'merged', at: '2026-01-03T00:00:00Z' }]);
  });

  it('detects closed without merge', () => {
    const events = diffPr(snapshot(), snapshot({ state: 'CLOSED', closedAt: '2026-01-03T00:00:00Z' }));
    expect(events).toEqual([{ kind: 'closed', at: '2026-01-03T00:00:00Z' }]);
  });

  it('falls back to the check time when the state time is missing', () => {
    const events = diffPr(snapshot(), snapshot({ state: 'CLOSED' }));
    expect(events[0]?.at).toBe('2026-01-02T00:00:00.000Z');
  });

  it('detects reopened', () => {
    const events = diffPr(snapshot({ state: 'CLOSED' }), snapshot());
    expect(events.map((event) => event.kind)).toEqual(['reopened']);
  });

  it('detects draft and ready', () => {
    expect(diffPr(snapshot(), snapshot({ isDraft: true })).map((event) => event.kind)).toEqual(['draft']);
    expect(diffPr(snapshot({ isDraft: true }), snapshot()).map((event) => event.kind)).toEqual(['ready']);
  });

  it('does not report draft changes on a merged pull request', () => {
    const events = diffPr(snapshot({ isDraft: true }), snapshot({ state: 'MERGED', isDraft: false }));
    expect(events.map((event) => event.kind)).toEqual(['merged']);
  });

  it('detects new comments by id', () => {
    const previous = snapshot({ comments: [{ id: 'c1', author: 'alice', createdAt: '2026-01-01T00:00:00Z', url: 'u1' }] });
    const next = snapshot({
      comments: [
        { id: 'c1', author: 'alice', createdAt: '2026-01-01T00:00:00Z', url: 'u1' },
        { id: 'c2', author: 'bob', createdAt: '2026-01-02T00:00:00Z', url: 'u2' },
      ],
    });
    expect(diffPr(previous, next)).toEqual([
      { kind: 'comment', at: '2026-01-02T00:00:00Z', author: 'bob', url: 'u2' },
    ]);
  });

  it('detects new reviews with their state', () => {
    const next = snapshot({
      reviews: [{ id: 'r1', author: 'carol', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-02T01:00:00Z' }],
    });
    expect(diffPr(snapshot(), next)).toEqual([
      { kind: 'review', at: '2026-01-02T01:00:00Z', author: 'carol', reviewState: 'CHANGES_REQUESTED' },
    ]);
  });

  it('detects new inline review comments with their path', () => {
    const next = snapshot({
      reviewComments: [{ id: '9', author: 'dave', createdAt: '2026-01-02T02:00:00Z', path: 'src/a.ts', url: 'u9' }],
    });
    expect(diffPr(snapshot(), next)).toEqual([
      { kind: 'review_comment', at: '2026-01-02T02:00:00Z', author: 'dave', url: 'u9', path: 'src/a.ts' },
    ]);
  });

  it('detects a push as a head sha change', () => {
    const events = diffPr(snapshot(), snapshot({ headSha: 'b'.repeat(40) }));
    expect(events).toEqual([
      { kind: 'push', at: '2026-01-02T00:00:00.000Z', from: 'a'.repeat(40), to: 'b'.repeat(40) },
    ]);
  });

  it('detects a review decision change', () => {
    const events = diffPr(snapshot(), snapshot({ reviewDecision: 'APPROVED' }));
    expect(events).toEqual([
      { kind: 'review_decision', at: '2026-01-02T00:00:00.000Z', from: null, to: 'APPROVED' },
    ]);
  });

  it('works from the stored last state', () => {
    const previous = snapshot({ comments: [{ id: 'c1', author: 'a', createdAt: 't', url: 'u' }] });
    const base = lastStateToBase(toLastState(previous));
    expect(diffPr(base, previous)).toEqual([]);
    expect(diffPr(base, snapshot({ isDraft: true, comments: previous.comments })).map((event) => event.kind)).toEqual([
      'draft',
    ]);
  });
});

describe('stateEvents', () => {
  it('describes the state the pull request is in', () => {
    expect(stateEvents(snapshot({ state: 'MERGED', mergedAt: 'T' }))).toEqual([{ kind: 'merged', at: 'T' }]);
    expect(stateEvents(snapshot({ state: 'CLOSED' })).map((event) => event.kind)).toEqual(['closed']);
    expect(stateEvents(snapshot()).map((event) => event.kind)).toEqual(['opened', 'ready']);
    expect(stateEvents(snapshot({ isDraft: true })).map((event) => event.kind)).toEqual(['opened', 'draft']);
  });
});

describe('sinceEvents', () => {
  it('counts items created after the given time even when already present', () => {
    const current = snapshot({
      comments: [
        { id: 'c1', author: 'a', createdAt: '2026-01-01T00:00:00Z', url: 'u1' },
        { id: 'c2', author: 'b', createdAt: '2026-01-02T00:00:00Z', url: 'u2' },
      ],
      reviews: [{ id: 'r1', author: 'c', state: 'APPROVED', submittedAt: '2026-01-02T00:30:00Z' }],
      reviewComments: [{ id: '1', author: 'd', createdAt: '2025-12-31T00:00:00Z', url: 'u' }],
    });
    const events = sinceEvents(current, '2026-01-01T12:00:00Z');
    expect(events.map((event) => event.kind)).toEqual(['comment', 'review']);
  });

  it('rejects an invalid time', () => {
    expect(() => sinceEvents(snapshot(), 'yesterday-ish')).toThrow(/invalid time/);
  });
});

describe('parseEventKinds', () => {
  it('parses a list and rejects unknown kinds', () => {
    expect(parseEventKinds('merged, closed')).toEqual({ kinds: ['merged', 'closed'], any: false });
    expect(() => parseEventKinds('merged,bogus')).toThrow(/invalid event kind "bogus"/);
  });

  it('expands any to every kind', () => {
    expect(parseEventKinds('any')).toEqual({ kinds: [...PR_EVENT_KINDS], any: true });
  });
});

describe('helpers', () => {
  it('keeps the latest review per author', () => {
    const latest = latestReviewPerAuthor([
      { id: '1', author: 'a', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z' },
      { id: '2', author: 'a', state: 'APPROVED', submittedAt: '2026-01-02T00:00:00Z' },
      { id: '3', author: 'b', state: 'COMMENTED', submittedAt: '2026-01-01T12:00:00Z' },
    ]);
    expect(latest.map((review) => `${review.author}:${review.state}`)).toEqual(['a:APPROVED', 'b:COMMENTED']);
  });

  it('describes events', () => {
    expect(describePrEvent({ kind: 'review', at: 't', author: 'a', reviewState: 'APPROVED' })).toBe('review APPROVED by a');
    expect(describePrEvent({ kind: 'merged', at: 't' })).toBe('merged');
  });
});
