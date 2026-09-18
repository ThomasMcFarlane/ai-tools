import { describe, expect, it } from 'vitest';
import { buildRule } from '../src/cli/rules.js';

describe('buildRule', () => {
  it('maps expect to equals', () => {
    expect(buildRule({ expect: ['192.0.2.1', '192.0.2.2'] })).toEqual({
      kind: 'equals',
      values: ['192.0.2.1', '192.0.2.2'],
    });
  });

  it('maps expectAbsent to excludes', () => {
    expect(buildRule({ expectAbsent: ['10.0.0.1'] })).toEqual({
      kind: 'excludes',
      values: ['10.0.0.1'],
    });
  });

  it('maps contains', () => {
    expect(buildRule({ contains: 'example' })).toEqual({ kind: 'contains', value: 'example' });
  });

  it('maps regex', () => {
    expect(buildRule({ regex: '^192\\.' })).toEqual({ kind: 'regex', pattern: '^192\\.' });
  });

  it('maps absent', () => {
    expect(buildRule({ absent: true })).toEqual({ kind: 'absent' });
  });

  it('maps anyChange to any-change', () => {
    expect(buildRule({ anyChange: true })).toEqual({ kind: 'any-change' });
  });

  it('treats empty list flags as unset', () => {
    expect(buildRule({ expect: [], absent: true })).toEqual({ kind: 'absent' });
  });

  it('throws when no rule flag is given', () => {
    expect(() => buildRule({})).toThrow(/no rule option given.*exactly one of/);
  });

  it('lists all six options in the error message', () => {
    expect(() => buildRule({})).toThrow(
      /--expect.*--expect-absent.*--contains.*--regex.*--absent.*--any-change/,
    );
  });

  it('throws when two rule flags are given', () => {
    expect(() => buildRule({ expect: ['192.0.2.1'], absent: true })).toThrow(
      /multiple rule options given \(--expect, --absent\)/,
    );
  });

  it('throws when three rule flags are given', () => {
    expect(() => buildRule({ contains: 'a', regex: 'b', absent: true })).toThrow(
      /multiple rule options given/,
    );
  });
});
