import type { MatchOutcome, MatchRule } from './types.js';

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

function bracketList(values: string[]): string {
  return `[${values.join(', ')}]`;
}

export function evaluateRule(rule: MatchRule, current: string[], baseline?: string[] | null): MatchOutcome {
  switch (rule.kind) {
    case 'any-change': {
      if (baseline === undefined || baseline === null) {
        return { matched: false, reason: 'baseline recorded' };
      }
      const before = sorted(baseline);
      const after = sorted(current);
      if (sameSet(before, after)) {
        return { matched: false, reason: 'no change' };
      }
      return { matched: true, reason: `values changed from ${bracketList(before)} to ${bracketList(after)}` };
    }
    case 'equals': {
      const expected = sorted(rule.values);
      const actual = sorted(current);
      if (sameSet(expected, actual)) {
        return { matched: true, reason: `values equal ${bracketList(expected)}` };
      }
      return { matched: false, reason: `expected ${bracketList(expected)} but found ${bracketList(actual)}` };
    }
    case 'includes': {
      const missing = rule.values.filter((value) => !current.includes(value));
      if (missing.length === 0) {
        return { matched: true, reason: `all of ${bracketList(rule.values)} present` };
      }
      return { matched: false, reason: `missing ${bracketList(missing)}` };
    }
    case 'excludes': {
      const present = rule.values.filter((value) => current.includes(value));
      if (present.length === 0) {
        return { matched: true, reason: `none of ${bracketList(rule.values)} present` };
      }
      return { matched: false, reason: `found excluded ${bracketList(present)}` };
    }
    case 'contains': {
      const hit = current.find((value) => value.includes(rule.value));
      if (hit !== undefined) {
        return { matched: true, reason: `"${hit}" contains "${rule.value}"` };
      }
      return { matched: false, reason: `no value contains "${rule.value}"` };
    }
    case 'regex': {
      const expression = `/${rule.pattern}/${rule.flags ?? ''}`;
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, rule.flags);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { matched: false, reason: `invalid regex ${expression}: ${message}` };
      }
      const hit = current.find((value) => re.test(value));
      if (hit !== undefined) {
        return { matched: true, reason: `"${hit}" matches ${expression}` };
      }
      return { matched: false, reason: `no value matches ${expression}` };
    }
    case 'absent': {
      if (current.length === 0) {
        return { matched: true, reason: 'no answers present' };
      }
      return { matched: false, reason: `found ${bracketList(current)}` };
    }
  }
}

export function describeRule(rule: MatchRule): string {
  switch (rule.kind) {
    case 'any-change':
      return 'any change';
    case 'equals':
      return `equals ${bracketList(rule.values)}`;
    case 'includes':
      return `includes ${bracketList(rule.values)}`;
    case 'excludes':
      return `excludes ${bracketList(rule.values)}`;
    case 'contains':
      return `contains "${rule.value}"`;
    case 'regex':
      return `regex /${rule.pattern}/${rule.flags ?? ''}`;
    case 'absent':
      return 'absent';
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function isMatchRule(value: unknown): value is MatchRule {
  if (!isRecordValue(value)) {
    return false;
  }
  switch (value.kind) {
    case 'any-change':
      return true;
    case 'absent':
      return true;
    case 'equals':
    case 'includes':
    case 'excludes':
      return isStringArray(value.values);
    case 'contains':
      return typeof value.value === 'string';
    case 'regex':
      return (
        typeof value.pattern === 'string' &&
        (value.flags === undefined || typeof value.flags === 'string')
      );
    default:
      return false;
  }
}
