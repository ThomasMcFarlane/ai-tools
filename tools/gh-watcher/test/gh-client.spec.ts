import { describe, expect, it } from 'vitest';
import { aggregateState, GhClient, type GhExec, type GhExecResult } from '../src/core/gh.js';

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

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

const RUN_LIST_JSON = JSON.stringify([
  { databaseId: 2, workflowName: 'CI', displayTitle: 'b2', status: 'completed', conclusion: 'success', url: 'u2', headSha: SHA2, createdAt: '2026-01-02T00:00:00Z' },
  { databaseId: 1, workflowName: 'CI', displayTitle: 'b1', status: 'completed', conclusion: 'failure', url: 'u1', headSha: SHA1, createdAt: '2026-01-01T00:00:00Z' },
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
    const { exec, calls } = fakeExec([ok(`${SHA2}\n`), ok(RUN_LIST_JSON)]);
    const client = new GhClient({ exec });
    const runs = await client.listRuns(REPO, { kind: 'branch', branch: 'main' });
    expect(calls).toEqual([
      ['api', 'repos/octo-org/hello-world/branches/main', '--jq', '.commit.sha'],
      ['run', 'list', '--repo', REPO, '--commit', SHA2, '--limit', '25', '--json', RUN_FIELDS],
    ]);
    expect(runs.map((run) => run.databaseId)).toEqual([2]);
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

  it('resolves a pr target to runs for its head commit only', async () => {
    const { exec, calls } = fakeExec([
      ok(JSON.stringify({ headRefName: 'feature-1', headRefOid: SHA2 })),
      ok(RUN_LIST_JSON),
    ]);
    const client = new GhClient({ exec });
    const runs = await client.listRuns(REPO, { kind: 'pr', number: 17 });
    expect(calls).toEqual([
      ['pr', 'view', '17', '--repo', REPO, '--json', 'headRefName,headRefOid'],
      ['run', 'list', '--repo', REPO, '--commit', SHA2, '--limit', '25', '--json', RUN_FIELDS],
    ]);
    expect(runs.map((run) => run.databaseId)).toEqual([2]);
  });

  it('reports success for a pr whose older commit failed but newest is green', async () => {
    const { exec } = fakeExec([
      ok(JSON.stringify({ headRefName: 'feature-1', headRefOid: SHA2 })),
      ok(RUN_LIST_JSON),
    ]);
    const client = new GhClient({ exec });
    const runs = await client.listRuns(REPO, { kind: 'pr', number: 17 });
    expect(aggregateState(runs)).toBe('success');
  });

  it('lets a successful re-run supersede the failed attempt of the same workflow', async () => {
    const list = JSON.stringify([
      { databaseId: 9, workflowName: 'CI', status: 'completed', conclusion: 'success', headSha: SHA2, createdAt: '2026-01-02T02:00:00Z' },
      { databaseId: 8, workflowName: 'CI', status: 'completed', conclusion: 'failure', headSha: SHA2, createdAt: '2026-01-02T01:00:00Z' },
      { databaseId: 7, workflowName: 'Lint', status: 'completed', conclusion: 'success', headSha: SHA2, createdAt: '2026-01-02T01:00:00Z' },
    ]);
    const { exec } = fakeExec([ok(JSON.stringify({ headRefOid: SHA2 })), ok(list)]);
    const runs = await new GhClient({ exec }).listRuns(REPO, { kind: 'pr', number: 3 });
    expect(runs.map((run) => run.databaseId)).toEqual([9, 7]);
    expect(aggregateState(runs)).toBe('success');
  });

  it('reports pending while the head commit still has a running workflow', async () => {
    const list = JSON.stringify([
      { databaseId: 12, workflowName: 'CI', status: 'in_progress', conclusion: null, headSha: SHA2, createdAt: '2026-01-02T00:00:00Z' },
      { databaseId: 5, workflowName: 'CI', status: 'completed', conclusion: 'failure', headSha: SHA1, createdAt: '2026-01-01T00:00:00Z' },
    ]);
    const { exec } = fakeExec([ok(JSON.stringify({ headRefOid: SHA2 })), ok(list)]);
    const runs = await new GhClient({ exec }).listRuns(REPO, { kind: 'pr', number: 3 });
    expect(aggregateState(runs)).toBe('pending');
  });

  it('reports none for a head commit that has no runs yet', async () => {
    const { exec } = fakeExec([ok(`${SHA2}\n`), ok('[]')]);
    const runs = await new GhClient({ exec }).listRuns(REPO, { kind: 'branch', branch: 'feat/x' });
    expect(aggregateState(runs)).toBe('none');
  });

  it('url-encodes branch segments when resolving the branch head', async () => {
    const { exec, calls } = fakeExec([ok(`${SHA2}\n`), ok('[]')]);
    await new GhClient({ exec }).listRuns(REPO, { kind: 'branch', branch: 'feat/a b' });
    expect(calls[0]).toEqual(['api', 'repos/octo-org/hello-world/branches/feat/a%20b', '--jq', '.commit.sha']);
  });

  it('falls back to the newest commit in the run list when the branch head cannot be resolved', async () => {
    const { exec, calls } = fakeExec([
      { stdout: '', stderr: 'Not Found', code: 1 },
      ok(RUN_LIST_JSON),
    ]);
    const runs = await new GhClient({ exec }).listRuns(REPO, { kind: 'branch', branch: 'main' });
    expect(calls[1]).toEqual(['run', 'list', '--repo', REPO, '--branch', 'main', '--limit', '25', '--json', RUN_FIELDS]);
    expect(runs.map((run) => run.databaseId)).toEqual([2]);
    expect(aggregateState(runs)).toBe('success');
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
    expect(await client.listRuns(REPO, { kind: 'commit', sha: 'abc123' })).toEqual([]);
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
