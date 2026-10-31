import { describe, expect, it } from 'vitest';
import {
  followTarget,
  GhClient,
  type FollowLine,
  type GhExec,
  type WaitOptions,
} from '../src/index.js';

const SHA = 'a'.repeat(40);

function runJson(id: number, status: string, conclusion: string | null): Record<string, unknown> {
  return {
    databaseId: id,
    workflowName: `W${id}`,
    displayTitle: 't',
    status,
    conclusion,
    url: `https://example.com/run/${id}`,
    headSha: SHA,
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: '2026-01-01T00:00:05Z',
    attempt: 1,
  };
}

function job(status: string, conclusion: string | null): unknown {
  return {
    name: 'build',
    status,
    conclusion,
    url: 'https://example.com/job/1',
    steps: [{ name: 'Test', number: 1, status, conclusion }],
  };
}

function setup(rounds: { runs: Record<string, unknown>[]; jobs: unknown[] }[]) {
  const calls: string[][] = [];
  let index = 0;
  const exec: GhExec = async (args) => {
    calls.push(args);
    const round = rounds[
      Math.min(Math.max(index - (args[1] === 'view' ? 1 : 0), 0), rounds.length - 1)
    ] as (typeof rounds)[number];
    if (args[0] === 'run' && args[1] === 'list') {
      index += 1;
      return { stdout: JSON.stringify(round.runs), stderr: '', code: 0 };
    }
    if (args[0] === 'run' && args[1] === 'view') {
      return { stdout: JSON.stringify({ jobs: round.jobs }), stderr: '', code: 0 };
    }
    return { stdout: JSON.stringify({ headRefOid: SHA }), stderr: '', code: 0 };
  };
  return { client: new GhClient({ exec, detailedRuns: true }), calls };
}

const options: WaitOptions = {
  repo: 'octo-org/hello-world',
  target: { kind: 'pr', number: 1 },
  intervalMs: 1,
  timeoutMs: 60_000,
  fallbackMs: 1000,
  source: 'poll',
};

describe('followTarget', () => {
  it('emits a line per check, then a final line, and exits 0', async () => {
    const { client } = setup([
      { runs: [runJson(1, 'in_progress', null)], jobs: [job('in_progress', null)] },
      { runs: [runJson(1, 'completed', 'success')], jobs: [job('completed', 'success')] },
    ]);
    const lines: FollowLine[] = [];
    const result = await followTarget(options, {
      client,
      sleep: async () => {},
      emit: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(0);
    expect(lines.map((l) => l.isFinal)).toEqual([false, true]);
    expect(lines[0]?.source).toBe('poll');
    expect(lines[0]?.runs[0]?.startedAt).toBe('2026-01-01T00:00:05Z');
    expect(lines[0]?.runs[0]?.jobs[0]?.steps?.[0]).toEqual({
      name: 'Test',
      number: 1,
      status: 'in_progress',
      conclusion: null,
    });
    expect(lines[1]?.state).toBe('success');
  });

  it('fetches jobs of a finished run once', async () => {
    const { client, calls } = setup([
      {
        runs: [runJson(1, 'completed', 'success'), runJson(2, 'in_progress', null)],
        jobs: [job('completed', 'success')],
      },
      {
        runs: [runJson(1, 'completed', 'success'), runJson(2, 'in_progress', null)],
        jobs: [job('completed', 'success')],
      },
      {
        runs: [runJson(1, 'completed', 'success'), runJson(2, 'completed', 'success')],
        jobs: [job('completed', 'success')],
      },
    ]);
    await followTarget(options, { client, sleep: async () => {}, emit: () => {} });
    const viewed = calls.filter((c) => c[0] === 'run' && c[1] === 'view').map((c) => c[2]);
    expect(viewed.filter((id) => id === '1')).toHaveLength(1);
    expect(viewed.filter((id) => id === '2')).toHaveLength(3);
  });

  it('exits 1 on failure', async () => {
    const { client } = setup([
      { runs: [runJson(1, 'completed', 'failure')], jobs: [job('completed', 'failure')] },
    ]);
    const lines: FollowLine[] = [];
    const result = await followTarget(options, {
      client,
      sleep: async () => {},
      emit: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(1);
    expect(lines.at(-1)?.failedSteps[0]?.stepName).toBe('Test');
  });

  it('exits 124 with a final timedOut line', async () => {
    const { client } = setup([{ runs: [runJson(1, 'in_progress', null)], jobs: [] }]);
    const lines: FollowLine[] = [];
    const result = await followTarget(
      { ...options, timeoutMs: 0 },
      { client, sleep: async () => {}, emit: (l) => lines.push(l) },
    );
    expect(result.exitCode).toBe(124);
    expect(lines.at(-1)).toMatchObject({ isFinal: true, timedOut: true });
  });
});
