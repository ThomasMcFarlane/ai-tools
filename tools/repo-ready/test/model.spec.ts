import { beforeEach, describe, expect, it } from 'vitest';
import { buildModel } from '../src/core/model.js';
import type { AreaState, Level, Model } from '../src/core/types.js';
import { LogBuilder, sampleMap } from './helpers.js';

let L: LogBuilder;
const m = (): Model => buildModel(sampleMap(), L.events);
const area = (model: Model, id: string): AreaState => {
  const found = model.areas.find((a) => a.id === id);
  if (!found) throw new Error(`no area ${id}`);
  return found;
};
const hold = (areaId: string, level: Level): void => {
  for (const lv of ['read', 'maintain', 'rebuild'] as const) {
    L.q(areaId, lv, 4);
    L.q(areaId, lv, 4);
    if (lv === level) break;
  }
};

describe('buildModel', () => {
  beforeEach(() => {
    L = new LogBuilder().session();
  });

  it('holds read after 2 passes in the last 3', () => {
    L.q('a', 'read', 4);
    L.q('a', 'read', 1);
    L.q('a', 'read', 3);
    expect(area(m(), 'a')).toMatchObject({
      level: 'read',
      label: 'Ready to be interviewed on it',
      untested: false,
    });
  });

  it('one pass is not enough', () => {
    L.q('a', 'read', 4);
    L.q('a', 'read', 1);
    expect(area(m(), 'a').level).toBe('none');
  });

  it('only the last 3 count', () => {
    for (const s of [4, 4, 1, 1]) L.q('a', 'read', s);
    expect(area(m(), 'a').level).toBe('none');
  });

  it('a hinted answer does not pass', () => {
    L.q('a', 'read', 4, { hints: 1 });
    L.q('a', 'read', 4);
    expect(area(m(), 'a').perLevel.read).toEqual({ valid: 2, passedInWindow: 1, held: false });
  });

  it('a skip counts as a fail and an open question does not count', () => {
    L.q('a', 'read', 'skip');
    L.q('a', 'read', 'open');
    expect(area(m(), 'a').perLevel.read.valid).toBe(1);
  });

  it('maintain does not count without read', () => {
    L.q('a', 'maintain', 4);
    L.q('a', 'maintain', 4);
    expect(area(m(), 'a')).toMatchObject({ level: 'none', untested: true });
  });

  it('verdict is the lowest key level', () => {
    hold('a', 'read');
    hold('b', 'maintain');
    expect(m().verdict).toMatchObject({
      kind: 'level',
      level: 'read',
      label: 'Ready to be interviewed on it',
      holdingBack: ['a'],
    });
  });

  it('a non-key area never lowers the verdict', () => {
    hold('a', 'read');
    hold('b', 'read');
    expect(m().verdict.level).toBe('read');
  });

  it('says not enough evidence when a key area is untested', () => {
    hold('a', 'read');
    expect(m().verdict).toMatchObject({
      kind: 'not_enough_evidence',
      label: 'Not enough evidence yet',
      untestedKeyAreas: ['b'],
    });
  });

  it('says not yet ready when every key area was tested and one failed', () => {
    hold('a', 'read');
    L.q('b', 'read', 1);
    L.q('b', 'read', 0);
    expect(m().verdict).toMatchObject({
      kind: 'not_yet_ready',
      label: 'Not yet ready',
      level: 'none',
    });
  });

  it('a revision rise costs one level and marks the area stale', () => {
    hold('a', 'maintain');
    L.raise('a');
    expect(area(m(), 'a')).toMatchObject({ level: 'read', stale: true, staleFrom: 'maintain' });
    expect(
      m()
        .questions.filter((q) => q.voided)
        .every((q) => q.level === 'maintain'),
    ).toBe(true);
  });

  it('two passes at the old level bring it back', () => {
    hold('a', 'maintain');
    L.raise('a');
    L.q('a', 'maintain', 4);
    L.q('a', 'maintain', 4);
    expect(area(m(), 'a')).toMatchObject({ level: 'maintain', stale: false, staleFrom: null });
  });

  it('the mark clears after 3 graded questions without the level', () => {
    hold('a', 'maintain');
    L.raise('a');
    for (let i = 0; i < 3; i++) L.q('a', 'maintain', 1);
    expect(area(m(), 'a')).toMatchObject({ level: 'read', stale: false });
  });

  it('lower-level passes during a re-test change nothing', () => {
    hold('a', 'maintain');
    L.raise('a');
    L.q('a', 'read', 4);
    expect(area(m(), 'a')).toMatchObject({ level: 'read', stale: true });
  });

  it('a second rise while stale costs another level', () => {
    hold('a', 'maintain');
    L.raise('a');
    L.raise('a');
    expect(area(m(), 'a')).toMatchObject({ level: 'none', stale: true, staleFrom: 'read' });
  });

  it('a rise on an area with no level voids its questions without a stale mark', () => {
    L.q('a', 'read', 4);
    L.raise('a');
    expect(area(m(), 'a')).toMatchObject({ level: 'none', stale: false, untested: true });
  });

  it('an area missing from the map is retired and outside the verdict', () => {
    hold('a', 'read');
    hold('b', 'read');
    L.q('z', 'read', 0);
    expect(area(m(), 'z').retired).toBe(true);
    expect(m().verdict.level).toBe('read');
  });

  it('lists recurring gaps and weakest types', () => {
    L.q('a', 'read', 1, { gaps: ['locking'], qtype: 'trace' });
    L.q('a', 'read', 1, { gaps: ['locking'] });
    L.q('a', 'read', 4, { gaps: ['naming'] });
    expect(m().verdict.recurringGaps).toEqual(['locking']);
    expect(m().verdict.weakestTypes[0]).toBe('trace');
  });

  it('records sessions with their questions, and duration and hints on each question', () => {
    const q1 = L.q('a', 'read', 4, { hints: 2, durationMs: 90_000 });
    const q2 = L.q('a', 'read', 'open');
    L.endSession();
    const q3 = L.session('interview').q('b', 'read', 'skip');
    const model = m();
    expect(model.sessions).toHaveLength(2);
    expect(model.sessions[0]).toMatchObject({
      id: 's1',
      mode: 'learn',
      auto: false,
      questionIds: [q1, q2],
    });
    expect(model.sessions[0]?.endedAt).not.toBeNull();
    expect(model.sessions[1]).toMatchObject({
      id: 's2',
      mode: 'interview',
      endedAt: null,
      questionIds: [q3],
    });
    const first = model.questions.find((q) => q.id === q1);
    expect(first).toMatchObject({
      durationMs: 90_000,
      hints: 2,
      status: 'graded',
      passed: false,
      sessionId: 's1',
      mode: 'learn',
    });
    expect(model.questions.find((q) => q.id === q2)).toMatchObject({
      status: 'open',
      durationMs: null,
    });
    expect(model.questions.find((q) => q.id === q3)).toMatchObject({
      status: 'skipped',
      mode: 'interview',
      passed: false,
    });
  });
});
