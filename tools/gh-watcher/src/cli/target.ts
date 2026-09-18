import type { WatchTarget } from '../core/types.js';

export interface TargetFlags {
  pr?: number;
  branch?: string;
  commit?: string;
  run?: number;
}

const TARGET_FLAG_NAMES = '--pr, --branch, --commit and --run';

export function parseNumberOption(value: string): number {
  return Number(value);
}

export function parseTargetFlags(flags: TargetFlags): WatchTarget {
  const given: string[] = [];
  if (flags.pr !== undefined) {
    given.push('--pr');
  }
  if (flags.branch !== undefined) {
    given.push('--branch');
  }
  if (flags.commit !== undefined) {
    given.push('--commit');
  }
  if (flags.run !== undefined) {
    given.push('--run');
  }
  if (given.length === 0) {
    throw new Error(`no target option given: use exactly one of ${TARGET_FLAG_NAMES}`);
  }
  if (given.length > 1) {
    throw new Error(
      `multiple target options given (${given.join(', ')}): use exactly one of ${TARGET_FLAG_NAMES}`,
    );
  }
  if (flags.branch !== undefined) {
    const branch = flags.branch;
    if (branch.trim().length === 0) {
      throw new Error(`invalid branch "${branch}": use a non-empty branch name`);
    }
    return { kind: 'branch', branch };
  }
  if (flags.commit !== undefined) {
    const sha = flags.commit;
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) {
      throw new Error(`invalid commit "${sha}": use 4 to 40 hexadecimal characters`);
    }
    return { kind: 'commit', sha };
  }
  if (flags.pr !== undefined) {
    assertPositiveInteger(flags.pr, '--pr');
    return { kind: 'pr', number: flags.pr };
  }
  assertPositiveInteger(flags.run as number, '--run');
  return { kind: 'run', runId: flags.run as number };
}

export function parseTargetFlagsOrExit(flags: TargetFlags): WatchTarget {
  try {
    return parseTargetFlags(flags);
  } catch (error) {
    process.exitCode = 2;
    throw error;
  }
}

function assertPositiveInteger(value: number, flag: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid ${flag} "${String(value)}": use a positive integer`);
  }
}
