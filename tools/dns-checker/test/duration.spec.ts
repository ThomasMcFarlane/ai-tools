import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration } from '../src/cli/duration.js';

describe('parseDuration', () => {
  it('parses milliseconds', () => {
    expect(parseDuration('250ms')).toBe(250);
  });

  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('treats a bare number as seconds', () => {
    expect(parseDuration('90')).toBe(90_000);
  });

  it('trims surrounding whitespace', () => {
    expect(parseDuration('  30s  ')).toBe(30_000);
  });

  it.each(['', 's', '-5s', '1.5h', 'abc', '30sec', 'm30'])('rejects %s', (input) => {
    expect(() => parseDuration(input)).toThrow(/invalid duration/);
  });

  it('includes a usage hint in the error message', () => {
    expect(() => parseDuration('nope')).toThrow(/250ms, 30s, 5m, 1h/);
  });
});

describe('formatDuration', () => {
  it('formats whole hours', () => {
    expect(formatDuration(7_200_000)).toBe('2h');
  });

  it('formats whole minutes', () => {
    expect(formatDuration(300_000)).toBe('5m');
  });

  it('formats whole seconds', () => {
    expect(formatDuration(90_000)).toBe('90s');
  });

  it('formats sub-second values as milliseconds', () => {
    expect(formatDuration(250)).toBe('250ms');
  });

  it('formats zero as 0s', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('round-trips parseDuration output', () => {
    for (const input of ['250ms', '30s', '5m', '1h', '90']) {
      expect(formatDuration(parseDuration(input))).toBe(input === '90' ? '90s' : input);
    }
  });
});
