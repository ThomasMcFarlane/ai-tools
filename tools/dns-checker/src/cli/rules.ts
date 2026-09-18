import type { MatchRule } from '../core/types.js';

export interface RuleFlags {
  expect?: string[];
  expectAbsent?: string[];
  contains?: string;
  regex?: string;
  absent?: boolean;
  anyChange?: boolean;
}

const OPTION_NAMES =
  '--expect <values...>, --expect-absent <values...>, --contains <value>, --regex <pattern>, --absent, --any-change';

export function buildRule(flags: RuleFlags): MatchRule {
  const chosen: string[] = [];
  if (flags.expect !== undefined && flags.expect.length > 0) {
    chosen.push('--expect');
  }
  if (flags.expectAbsent !== undefined && flags.expectAbsent.length > 0) {
    chosen.push('--expect-absent');
  }
  if (flags.contains !== undefined && flags.contains.length > 0) {
    chosen.push('--contains');
  }
  if (flags.regex !== undefined && flags.regex.length > 0) {
    chosen.push('--regex');
  }
  if (flags.absent === true) {
    chosen.push('--absent');
  }
  if (flags.anyChange === true) {
    chosen.push('--any-change');
  }
  if (chosen.length !== 1) {
    const problem =
      chosen.length === 0 ? 'no rule option given' : `multiple rule options given (${chosen.join(', ')})`;
    throw new Error(`${problem}: give exactly one of ${OPTION_NAMES}`);
  }
  switch (chosen[0]) {
    case '--expect':
      return { kind: 'equals', values: flags.expect ?? [] };
    case '--expect-absent':
      return { kind: 'excludes', values: flags.expectAbsent ?? [] };
    case '--contains':
      return { kind: 'contains', value: flags.contains ?? '' };
    case '--regex':
      return { kind: 'regex', pattern: flags.regex ?? '' };
    case '--absent':
      return { kind: 'absent' };
    default:
      return { kind: 'any-change' };
  }
}
