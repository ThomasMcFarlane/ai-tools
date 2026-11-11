import { beforeEach, describe, expect, it } from 'vitest';
import { buildModel } from '../src/core/model.js';
import { median, sessionSummary } from '../src/core/stats.js';
import type { Model } from '../src/core/types.js';
import { LogBuilder, sampleMap } from './helpers.js';

let L: LogBuilder;
const sid = 's1';
const m = (): Model => buildModel(sampleMap(), L.events);

describe('sessionSummary', () => {
  beforeEach(() => {
    L = new LogBuilder().session();
  });

  it('summarises one session', () => {
    L.q('a', 'read', 4, { durationMs: 40_000 });
    L.q('a', 'read', 1, { durationMs: 60_000, hints: 1 });
    L.q('b', 'maintain', 'skip');
    expect(sessionSummary(m(), sid)).toMatchObject({
      sessionId: 's1',
      mode: 'learn',
      endedAt: null,
      asked: 3,
      graded: 2,
      passed: 1,
      passRate: 1 / 3,
      medianMs: 50_000,
      hints: 1,
      skips: 1,
      byArea: [
        { areaId: 'a', level: 'read', asked: 2, passed: 1 },
        { areaId: 'b', level: 'maintain', asked: 1, passed: 0 },
      ],
    });
  });

  it('pass rate is null for a session with no counted question', () => {
    L.q('a', 'read', 'open');
    expect(sessionSummary(m(), sid)).toMatchObject({
      asked: 1,
      graded: 0,
      passRate: null,
      medianMs: null,
    });
  });

  it('sums hints over questions and splits one area by level', () => {
    L.q('a', 'read', 4, { hints: 2 });
    L.q('a', 'read', 4, { hints: 1 });
    L.q('a', 'maintain', 4);
    expect(sessionSummary(m(), sid)).toMatchObject({
      hints: 3,
      passed: 1,
      byArea: [
        { areaId: 'a', level: 'read', asked: 2, passed: 0 },
        { areaId: 'a', level: 'maintain', asked: 1, passed: 1 },
      ],
    });
  });

  it('throws for an unknown session', () => {
    expect(() => sessionSummary(m(), 'zzz')).toThrow(/zzz/);
  });
});

describe('median', () => {
  it('handles empty, odd and even lists', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
