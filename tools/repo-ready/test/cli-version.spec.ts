import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  LEVEL_LABELS,
  LEVEL_PASSES,
  LEVEL_WINDOW,
  MAX_AREAS,
  MIN_AREAS,
  NOT_ENOUGH_LABEL,
  PASS_SCORE,
  QTYPES,
  RECENT_PROMPTS,
  SESSION_AREA_CAP,
  SESSION_QUESTIONS,
  STALE_CLEAR_AFTER,
} from '../src/core/types.js';
import { VERSION } from '../src/version.js';

describe('version and constants', () => {
  it('VERSION matches package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
    expect(pkg.version).toBe('0.1.0');
  });

  it('exposes the constants the spec pins', () => {
    expect([PASS_SCORE, LEVEL_PASSES, LEVEL_WINDOW, STALE_CLEAR_AFTER]).toEqual([3, 2, 3, 3]);
    expect([SESSION_QUESTIONS, SESSION_AREA_CAP, MIN_AREAS, MAX_AREAS, RECENT_PROMPTS]).toEqual([
      8, 3, 1, 10, 5,
    ]);
    expect(LEVEL_LABELS).toEqual({
      none: 'Not yet ready',
      read: 'Ready to be interviewed on it',
      maintain: 'Ready to work on it',
      rebuild: 'Ready to own it',
    });
    expect(NOT_ENOUGH_LABEL).toBe('Not enough evidence yet');
    expect(QTYPES).toEqual({
      read: ['explain', 'trace'],
      maintain: ['predict', 'debug', 'change'],
      rebuild: ['rebuild'],
    });
  });
});
