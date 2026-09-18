import { describe, expect, it } from 'vitest';
import { parseTargetFlags } from '../src/cli/target.js';

describe('parseTargetFlags', () => {
  it('parses each target kind', () => {
    expect(parseTargetFlags({ pr: 7 })).toEqual({ kind: 'pr', number: 7 });
    expect(parseTargetFlags({ branch: 'main' })).toEqual({ kind: 'branch', branch: 'main' });
    expect(parseTargetFlags({ commit: 'abc123' })).toEqual({ kind: 'commit', sha: 'abc123' });
    expect(parseTargetFlags({ run: 123456 })).toEqual({ kind: 'run', runId: 123456 });
  });

  it('accepts 4 to 40 hexadecimal characters for a commit', () => {
    expect(parseTargetFlags({ commit: 'abcd' })).toEqual({ kind: 'commit', sha: 'abcd' });
    expect(parseTargetFlags({ commit: 'aB0f'.repeat(10) })).toEqual({ kind: 'commit', sha: 'aB0f'.repeat(10) });
  });

  it('throws when zero target flags are set', () => {
    expect(() => parseTargetFlags({})).toThrow(/no target option given/);
    expect(() => parseTargetFlags({})).toThrow(/--pr, --branch, --commit and --run/);
  });

  it('throws when two or more target flags are set', () => {
    expect(() => parseTargetFlags({ pr: 1, branch: 'main' })).toThrow(/multiple target options given/);
    expect(() => parseTargetFlags({ branch: 'main', commit: 'abcd', run: 5 })).toThrow(
      /multiple target options given/,
    );
    expect(() => parseTargetFlags({ pr: 1, branch: 'main' })).toThrow(/--pr, --branch, --commit and --run/);
  });

  it('rejects an empty branch', () => {
    expect(() => parseTargetFlags({ branch: '' })).toThrow(/invalid branch/);
    expect(() => parseTargetFlags({ branch: '   ' })).toThrow(/invalid branch/);
  });

  it('rejects bad commit shas', () => {
    expect(() => parseTargetFlags({ commit: 'abc' })).toThrow(/invalid commit/);
    expect(() => parseTargetFlags({ commit: 'xyz123' })).toThrow(/invalid commit/);
    expect(() => parseTargetFlags({ commit: 'a'.repeat(41) })).toThrow(/invalid commit/);
  });

  it('rejects non-positive pr and run values', () => {
    expect(() => parseTargetFlags({ pr: 0 })).toThrow(/invalid --pr/);
    expect(() => parseTargetFlags({ pr: -3 })).toThrow(/invalid --pr/);
    expect(() => parseTargetFlags({ pr: Number.NaN })).toThrow(/invalid --pr/);
    expect(() => parseTargetFlags({ run: 0 })).toThrow(/invalid --run/);
    expect(() => parseTargetFlags({ run: 1.5 })).toThrow(/invalid --run/);
  });
});
