import { beforeEach, describe, expect, it } from 'vitest';
import { buildModel } from '../src/core/model.js';
import { nextTargets, type NextResult } from '../src/core/next.js';
import type { Level, Model } from '../src/core/types.js';
import { holdLevel, LogBuilder, sampleMap } from './helpers.js';

let L: LogBuilder;
const sid = (): string => {
  const starts = L.events.filter((e) => e.type === 'session_start');
  return starts[starts.length - 1]?.sessionId ?? '';
};
const m = (): Model => buildModel(sampleMap(), L.events);
const hold = (areaId: string, level: Level): void => {
  L.endSession().session();
  holdLevel(L, areaId, level);
  L.endSession().session();
};
const next = (
  opts: { areas?: string[]; count?: number; sessionId?: string | null } = {},
): NextResult => nextTargets(sampleMap(), m(), { count: 1, sessionId: sid(), ...opts });
const ids = (r: NextResult): string[] => r.targets.map((t) => t.areaId);

describe('nextTargets', () => {
  beforeEach(() => {
    L = new LogBuilder().session();
  });

  it('puts a stale area first, at the level it held', () => {
    hold('a', 'maintain');
    hold('b', 'read');
    L.raise('a');
    expect(next().targets[0]).toMatchObject({ areaId: 'a', level: 'maintain', reason: 'stale' });
  });

  it('then key areas lowest first, then other areas', () => {
    hold('a', 'read');
    expect(ids(next({ count: 3 }))).toEqual(['b', 'a', 'c']);
    expect(next({ count: 3 }).targets.map((t) => t.level)).toEqual(['read', 'maintain', 'read']);
  });

  it('picks an untried type, then the weakest', () => {
    L.q('a', 'read', 4, { qtype: 'explain' });
    expect(next({ areas: ['a'] }).targets[0]?.qtype).toBe('trace');
    L.q('a', 'read', 1, { qtype: 'trace' });
    expect(next({ areas: ['a'] }).targets[0]?.qtype).toBe('trace');
  });

  it('picks the slower type when pass rates are equal', () => {
    L.q('c', 'read', 1, { qtype: 'explain', durationMs: 30_000 });
    L.q('c', 'read', 1, { qtype: 'trace', durationMs: 90_000 });
    expect(next({ areas: ['c'] }).targets[0]?.qtype).toBe('trace');
  });

  it('moves an area back after 3 questions in this session', () => {
    for (let i = 0; i < 3; i++) L.q('b', 'read', 1);
    expect(ids(next({ count: 3 }))).toEqual(['a', 'c', 'b']);
  });

  it('does not cap an area when there is no session', () => {
    for (let i = 0; i < 3; i++) L.q('b', 'read', 1);
    const r = next({ count: 3, sessionId: null });
    expect(ids(r)).toEqual(['a', 'b', 'c']);
    expect(r.session).toEqual({ id: null, asked: 0, limit: 8, done: false });
  });

  it('filters by area and rejects an unknown id', () => {
    expect(ids(next({ areas: ['c'], count: 3 }))).toEqual(['c']);
    expect(() => next({ areas: ['nope'] })).toThrow(/unknown area/);
  });

  it('reports untested, not_held and keep_fresh', () => {
    expect(next({ areas: ['a'] }).targets[0]).toMatchObject({ reason: 'untested', level: 'read' });
    L.q('a', 'read', 1);
    L.q('a', 'read', 1);
    expect(next({ areas: ['a'] }).targets[0]).toMatchObject({ reason: 'not_held', level: 'read' });
    hold('b', 'rebuild');
    expect(next({ areas: ['b'] }).targets[0]).toMatchObject({
      reason: 'keep_fresh',
      level: 'rebuild',
      qtype: 'rebuild',
    });
  });

  it('never targets a retired area', () => {
    L.q('gone', 'read', 4);
    expect(ids(next({ count: 10 }))).not.toContain('gone');
  });

  it('returns the last 5 prompts newest first', () => {
    for (let i = 1; i <= 7; i++) L.q('a', 'read', 4, { prompt: `p${i}` });
    expect(next({ areas: ['a'] }).targets[0]?.recentPrompts).toEqual([
      'p7',
      'p6',
      'p5',
      'p4',
      'p3',
    ]);
  });

  it('is done after 8 questions, follow-ups included', () => {
    for (let i = 0; i < 8; i++) L.q('a', 'read', 4);
    expect(next().session).toMatchObject({ asked: 8, limit: 8, done: true });
  });

  it('applies the session cap to a stale area too', () => {
    hold('a', 'maintain');
    hold('b', 'read');
    L.raise('a');
    for (let i = 0; i < 3; i++) L.q('a', 'read', 4);
    const r = next({ count: 3 });
    expect(ids(r)).toEqual(['b', 'c', 'a']);
    expect(r.targets[2]).toMatchObject({ areaId: 'a', reason: 'stale', level: 'maintain' });
  });

  it('puts a stale key area before a stale non-key area', () => {
    hold('c', 'read');
    hold('a', 'read');
    L.raise('c');
    L.raise('a');
    const cFirst = { areas: [...sampleMap().areas].reverse() };
    const r = nextTargets(cFirst, buildModel(cFirst, L.events), { count: 3, sessionId: sid() });
    expect(ids(r)).toEqual(['a', 'c', 'b']);
    expect(r.targets.map((t) => t.reason)).toEqual(['stale', 'stale', 'untested']);
  });

  it('breaks a tie by last test time, never tested first', () => {
    L.q('a', 'read', 1);
    expect(ids(next({ count: 2 }))).toEqual(['b', 'a']);
    L.q('b', 'read', 1);
    L.q('a', 'read', 1);
    expect(ids(next({ count: 2 }))).toEqual(['b', 'a']);
  });

  it('breaks a full tie by map order', () => {
    const reversed = { areas: [...sampleMap().areas].reverse() };
    const r = nextTargets(reversed, buildModel(reversed, L.events), {
      count: 3,
      sessionId: sid(),
    });
    expect(ids(r)).toEqual(['b', 'a', 'c']);
  });
});
