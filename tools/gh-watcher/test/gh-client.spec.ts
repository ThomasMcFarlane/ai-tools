import { describe, expect, it } from 'vitest';
import { GhClient, type GhExec, type GhExecResult } from '../src/core/gh.js';

const RUN_FIELDS = 'databaseId,workflowName,displayTitle,status,conclusion,url,headSha,createdAt';
const REPO = 'octo-org/hello-world';

function ok(stdout: string): GhExecResult {
  return { stdout, stderr: '', code: 0 };
}

function fakeExec(responses: GhExecResult[]): { exec: GhExec; calls: string[][] } {
  const calls: string[][] = [];
  const queue = [...responses];
  const exec: GhExec = async (args) => {
    calls.push(args);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
    }
    return next;
  };
  return { exec, calls };
}

const RUN_JSON = JSON.stringify({
  databaseId: 1234567,
  workflowName: 'CI',
  displayTitle: 'build',
  status: 'completed',
  conclusion: 'success',
  url: 'https://example.invalid/runs/1234567',
  headSha: 'abc123',
  createdAt: '2026-01-01T00:00:00Z',
});

const RUN_LIST_JSON = JSON.stringify([
  { databaseId: 2, workflowName: 'CI', displayTitle: 'b2', status: 'completed', conclusion: 'success', url: 'u2', headSha: 'sha2' },
  { databaseId: 1, workflowName: 'CI', displayTitle: 'b1', status: 'completed', conclusion: 'failure', url: 'u1', headSha: 'sha1' },
]);

const JOBS_JSON = JSON.stringify({
  jobs: [
    {
      name: 'build',
      status: 'completed',
      conclusion: 'failure',
      url: 'https://example.invalid/jobs/1',
      steps: [
        { name: 'checkout', number: 1, conclusion: 'success' },
        { name: 'install', number: 2, conclusion: 'failure' },
        { name: 'test', number: 3, conclusion: 'skipped' },
      ],
    },
  ],
});

describe('GhClient.listRuns', () => {
  it('views a single run for a run target', async () => {
    const { exec, calls } = fakeExec([ok(RUN_JSON)]);
    const client = new GhClient({ exec });
    const runs = await client.listRuns(REPO, { kind: 'run', runId: 1234567 });
    expect(calls).toEqual([
      ['run', 'view', '1234567', '--repo', REPO, '--json', RUN_FIELDS],
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.databaseId).toBe(1234567);
    expect(runs[0]?.createdAt).toBe('2026-01-01T00:00:00Z');
  });

  it('lists branch runs', async () => {
    const { exec, calls } = fakeExec([ok(RUN_LIST_JSON)]);
    const client = new GhClient({ exec });
    const runs = await client.listRuns(REPO, { kind: 'branch', branch: 'main' });
    expect(calls).toEqual([
      ['run', 'list', '--repo', REPO, '--branch', 'main', '--limit', '25', '--json', RUN_FIELDS],
    ]);
    expect(runs.map((run) => run.databaseId)).toEqual([2, 1]);
  });

  it('lists commit runs', async () => {
    const { exec, calls } = fakeExec([ok('[]')]);
    const client = new GhClient({ exec });
    const runs = await client.listRuns(REPO, { kind: 'commit', sha: 'abc123' });
    expect(calls).toEqual([
      ['run', 'list', '--repo', REPO, '--commit', 'abc123', '--limit', '25', '--json', RUN_FIELDS],
    ]);
    expect(runs).toEqual([]);
  });

  it('resolves a pr target in two gh calls', async () => {
    const { exec, calls } = fakeExec([ok(JSON.stringify({ headRefName: 'feature-1' })), ok(RUN_LIST_JSON)]);
    const client = new GhClient({ exec });
    const runs = await client.listRuns(REPO, { kind: 'pr', number: 17 });
    expect(calls).toEqual([
      ['pr', 'view', '17', '--repo', REPO, '--json', 'headRefName'],
      ['run', 'list', '--repo', REPO, '--branch', 'feature-1', '--limit', '25', '--json', RUN_FIELDS],
    ]);
    expect(runs).toHaveLength(2);
  });

  it('throws with the trimmed stderr when a run view exits non-zero', async () => {
    const { exec } = fakeExec([{ stdout: '', stderr: '  run 1234567 not found\n', code: 1 }]);
    const client = new GhClient({ exec });
    await expect(client.listRuns(REPO, { kind: 'run', runId: 1234567 })).rejects.toThrow(
      /run 1234567 not found/,
    );
  });

  it('returns an empty list for empty run list output', async () => {
    const { exec } = fakeExec([ok('[]')]);
    const client = new GhClient({ exec });
    expect(await client.listRuns(REPO, { kind: 'branch', branch: 'main' })).toEqual([]);
  });
});

describe('GhClient.runJobs', () => {
  it('fetches and normalises jobs with steps', async () => {
    const { exec, calls } = fakeExec([ok(JOBS_JSON)]);
    const client = new GhClient({ exec });
    const jobs = await client.runJobs(REPO, 1234567);
    expect(calls).toEqual([['run', 'view', '1234567', '--repo', REPO, '--json', 'jobs']]);
    expect(jobs[0]?.name).toBe('build');
    expect(jobs[0]?.steps).toHaveLength(3);
    expect(jobs[0]?.steps?.[1]).toEqual({ name: 'install', number: 2, conclusion: 'failure' });
  });

  it('defaults missing steps to an empty array', async () => {
    const { exec } = fakeExec([
      ok(JSON.stringify({ jobs: [{ name: 'build', status: 'completed', conclusion: 'failure' }] })),
    ]);
    const client = new GhClient({ exec });
    const jobs = await client.runJobs(REPO, 1234567);
    expect(jobs[0]?.steps).toEqual([]);
  });
});

describe('GhClient.collectFailures', () => {
  it('maps failed steps of failure-ish runs only', async () => {
    const { exec, calls } = fakeExec([ok(JOBS_JSON)]);
    const client = new GhClient({ exec });
    const failures = await client.collectFailures(REPO, [
      { databaseId: 111, workflowName: 'CI', displayTitle: 'b', status: 'completed', conclusion: 'failure', url: 'u', headSha: 's' },
      { databaseId: 222, workflowName: 'CI', displayTitle: 'b', status: 'completed', conclusion: 'success', url: 'u', headSha: 's' },
    ]);
    expect(calls).toEqual([['run', 'view', '111', '--repo', REPO, '--json', 'jobs']]);
    expect(failures).toEqual([
      {
        runId: 111,
        workflowName: 'CI',
        jobName: 'build',
        stepName: 'install',
        stepNumber: 2,
      },
    ]);
  });

  it('falls back to a placeholder step when a failed job has no steps', async () => {
    const { exec } = fakeExec([
      ok(JSON.stringify({ jobs: [{ name: 'build', status: 'completed', conclusion: 'cancelled' }] })),
    ]);
    const client = new GhClient({ exec });
    const failures = await client.collectFailures(REPO, [
      { databaseId: 111, workflowName: 'CI', displayTitle: 'b', status: 'completed', conclusion: 'cancelled', url: 'u', headSha: 's' },
    ]);
    expect(failures).toEqual([
      {
        runId: 111,
        workflowName: 'CI',
        jobName: 'build',
        stepName: '',
        stepNumber: 0,
      },
    ]);
  });

  it('skips successful runs without spawning gh', async () => {
    const { exec, calls } = fakeExec([]);
    const client = new GhClient({ exec });
    const failures = await client.collectFailures(REPO, [
      { databaseId: 222, workflowName: 'CI', displayTitle: 'b', status: 'completed', conclusion: 'success', url: 'u', headSha: 's' },
    ]);
    expect(failures).toEqual([]);
    expect(calls).toEqual([]);
  });
});
