import { describe, expect, it } from 'vitest';
import { describeRule, evaluateRule, isMatchRule, type MatchRule } from '../src/index.js';

describe('evaluateRule', () => {
  it('any-change records baseline on first observation', () => {
    const outcome = evaluateRule({ kind: 'any-change' }, ['1.2.3.4']);
    expect(outcome.matched).toBe(false);
    expect(outcome.reason).toBe('baseline recorded');
  });

  it('any-change does not match identical values', () => {
    const outcome = evaluateRule({ kind: 'any-change' }, ['1.2.3.4', '1.0.0.1'], ['1.0.0.1', '1.2.3.4']);
    expect(outcome.matched).toBe(false);
  });

  it('any-change matches sorted set differences', () => {
    const outcome = evaluateRule({ kind: 'any-change' }, ['1.2.3.5'], ['1.2.3.4']);
    expect(outcome.matched).toBe(true);
    expect(outcome.reason).toContain('values changed');
  });

  it('equals compares as sorted sets', () => {
    expect(evaluateRule({ kind: 'equals', values: ['1.0.0.1', '1.2.3.4'] }, ['1.2.3.4', '1.0.0.1']).matched).toBe(
      true,
    );
    expect(evaluateRule({ kind: 'equals', values: ['1.2.3.4'] }, ['1.2.3.5']).matched).toBe(false);
    expect(evaluateRule({ kind: 'equals', values: ['1.2.3.4'] }, []).matched).toBe(false);
  });

  it('includes requires every listed value', () => {
    const rule: MatchRule = { kind: 'includes', values: ['1.2.3.4', '1.0.0.1'] };
    expect(evaluateRule(rule, ['1.0.0.1', '1.2.3.4', '8.8.8.8']).matched).toBe(true);
    expect(evaluateRule(rule, ['1.2.3.4']).matched).toBe(false);
  });

  it('excludes requires none of the listed values', () => {
    const rule: MatchRule = { kind: 'excludes', values: ['8.8.8.8'] };
    expect(evaluateRule(rule, ['1.2.3.4']).matched).toBe(true);
    expect(evaluateRule(rule, ['1.2.3.4', '8.8.8.8']).matched).toBe(false);
  });

  it('contains matches a substring of some value', () => {
    const rule: MatchRule = { kind: 'contains', value: 'spf' };
    expect(evaluateRule(rule, ['v=spf1 -all']).matched).toBe(true);
    expect(evaluateRule(rule, ['v=dmarc1']).matched).toBe(false);
  });

  it('regex matches some value with flags', () => {
    const rule: MatchRule = { kind: 'regex', pattern: '^v=spf1', flags: 'i' };
    expect(evaluateRule(rule, ['V=SPF1 -all']).matched).toBe(true);
    expect(evaluateRule(rule, ['v=dmarc1']).matched).toBe(false);
  });

  it('regex reports not matched for an invalid pattern', () => {
    const outcome = evaluateRule({ kind: 'regex', pattern: '[' }, ['abc']);
    expect(outcome.matched).toBe(false);
    expect(outcome.reason).toContain('invalid regex');
  });

  it('absent matches only empty answers', () => {
    expect(evaluateRule({ kind: 'absent' }, []).matched).toBe(true);
    expect(evaluateRule({ kind: 'absent' }, ['1.2.3.4']).matched).toBe(false);
  });
});

describe('describeRule', () => {
  it('summarises each rule kind', () => {
    expect(describeRule({ kind: 'any-change' })).toBe('any change');
    expect(describeRule({ kind: 'equals', values: ['1.2.3.4'] })).toBe('equals [1.2.3.4]');
    expect(describeRule({ kind: 'includes', values: ['1.2.3.4', '1.0.0.1'] })).toBe(
      'includes [1.2.3.4, 1.0.0.1]',
    );
    expect(describeRule({ kind: 'excludes', values: ['8.8.8.8'] })).toBe('excludes [8.8.8.8]');
    expect(describeRule({ kind: 'contains', value: 'spf' })).toBe('contains "spf"');
    expect(describeRule({ kind: 'regex', pattern: '^v=', flags: 'i' })).toBe('regex /^v=/i');
    expect(describeRule({ kind: 'absent' })).toBe('absent');
  });
});

describe('isMatchRule', () => {
  it('accepts valid rules of every kind', () => {
    expect(isMatchRule({ kind: 'any-change' })).toBe(true);
    expect(isMatchRule({ kind: 'absent' })).toBe(true);
    expect(isMatchRule({ kind: 'equals', values: ['1.2.3.4'] })).toBe(true);
    expect(isMatchRule({ kind: 'includes', values: [] })).toBe(true);
    expect(isMatchRule({ kind: 'excludes', values: ['a'] })).toBe(true);
    expect(isMatchRule({ kind: 'contains', value: 'x' })).toBe(true);
    expect(isMatchRule({ kind: 'regex', pattern: '^v=', flags: 'i' })).toBe(true);
    expect(isMatchRule({ kind: 'regex', pattern: '^v=' })).toBe(true);
  });

  it('rejects invalid rules', () => {
    expect(isMatchRule(null)).toBe(false);
    expect(isMatchRule(undefined)).toBe(false);
    expect(isMatchRule('any-change')).toBe(false);
    expect(isMatchRule({ kind: 'nope' })).toBe(false);
    expect(isMatchRule({ kind: 'equals' })).toBe(false);
    expect(isMatchRule({ kind: 'equals', values: [1, 2] })).toBe(false);
    expect(isMatchRule({ kind: 'contains' })).toBe(false);
    expect(isMatchRule({ kind: 'contains', value: 5 })).toBe(false);
    expect(isMatchRule({ kind: 'regex' })).toBe(false);
    expect(isMatchRule({ kind: 'regex', pattern: 'x', flags: 1 })).toBe(false);
  });
});
