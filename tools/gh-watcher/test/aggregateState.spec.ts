import { describe, expect, it } from 'vitest';
import { aggregateState, runsKey } from '../src/core/gh.js';
import { targetKey, type GhRunInfo } from '../src/core/types.js';

function run(partial: Partial<GhRunInfo> & { databaseId: number }): GhRunInfo {
  return {
    workflowName: 'CI',
    displayTitle: 'build',
    status: 'completed',
    conclusion: 'success',
    url: 'https://example.invalid/runs/1',
    headSha: 'abc123',
    ...partial,
  };
}

describe('aggregateState', () => {
  it('returns none for an empty run list', () => {
    expect(aggregateState([])).toBe('none');
  });

  it('returns pending when any run is not completed', () => {
    const runs = [run({ databaseId: 1, status: 'in_progress', conclusion: null })];
    expect(aggregateState(runs)).toBe('pending');
  });

  it('returns pending even when another run failed', () => {
    const runs = [
      run({ databaseId: 1, conclusion: 'failure' }),
      run({ databaseId: 2, status: 'queued', conclusion: null }),
    ];
    expect(aggregateState(runs)).toBe('pending');
  });

  it('returns failure when any completed run failed', () => {
    const runs = [
      run({ databaseId: 1, conclusion: 'success' }),
      run({ databaseId: 2, conclusion: 'timed_out' }),
    ];
    expect(aggregateState(runs)).toBe('failure');
  });

  it('treats cancelled and startup_failure as failure', () => {
    expect(aggregateState([run({ databaseId: 1, conclusion: 'cancelled' })])).toBe('failure');
    expect(aggregateState([run({ databaseId: 1, conclusion: 'startup_failure' })])).toBe('failure');
    expect(aggregateState([run({ databaseId: 1, conclusion: 'action_required' })])).toBe('failure');
  });

  it('returns success when every completed run succeeded', () => {
    const runs = [
      run({ databaseId: 1, conclusion: 'success' }),
      run({ databaseId: 2, conclusion: 'neutral' }),
      run({ databaseId: 3, conclusion: 'skipped' }),
    ];
    expect(aggregateState(runs)).toBe('success');
  });
});

describe('runsKey', () => {
  it('is stable regardless of order', () => {
    const a = [run({ databaseId: 3 }), run({ databaseId: 1 }), run({ databaseId: 2 })];
    const b = [run({ databaseId: 1 }), run({ databaseId: 2 }), run({ databaseId: 3 })];
    expect(runsKey(a)).toBe('1,2,3');
    expect(runsKey(a)).toBe(runsKey(b));
  });

  it('changes when a new attempt appears', () => {
    const before = [run({ databaseId: 1 })];
    const after = [run({ databaseId: 1 }), run({ databaseId: 2 })];
    expect(runsKey(before)).not.toBe(runsKey(after));
  });

  it('is empty for no runs', () => {
    expect(runsKey([])).toBe('');
  });
});

describe('targetKey', () => {
  it('formats every target kind', () => {
    expect(targetKey({ kind: 'run', runId: 1234567 })).toBe('run:1234567');
    expect(targetKey({ kind: 'pr', number: 17 })).toBe('pr:17');
    expect(targetKey({ kind: 'branch', branch: 'main' })).toBe('branch:main');
    expect(targetKey({ kind: 'commit', sha: 'abc123' })).toBe('commit:abc123');
  });
});
