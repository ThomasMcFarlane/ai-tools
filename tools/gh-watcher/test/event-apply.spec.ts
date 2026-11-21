import { describe, expect, it } from 'vitest';
import { applyRunEvents } from '../src/core/apply-events.js';
import type { RunEvent } from '../src/core/events.js';
import { GhClient, waitForTerminal, type GhExec, type GhRunInfo, type WaitOptions } from '../src/index.js';

import { CHECK_RUNS, COMMIT_STATUS, restCheckRunsBody, restJobsBody, restRunsBody, restStatusBody, RUN_JOBS, RUNS_LIST } from './rest-fixtures.js';
const SHA = 'a'.repeat(40);
const BASE = 'https://events.invalid';

function ghRun(id: number, workflow: string, status: string, conclusion: string | null): GhRunInfo {
  return {
    databaseId: id,
    workflowName: workflow,
    displayTitle: 't',
    status,
    conclusion,
    url: `u${id}`,
    headSha: SHA,
    createdAt: '2026-01-01T00:00:00Z',
    attempt: 1,
  };
}

function noAttempt(run: GhRunInfo): GhRunInfo {
  const copy: GhRunInfo = { ...run };
  delete copy.attempt;
  return copy;
}

function event(seq: number, id: number, workflow: string, status: string, conclusion: string | null, extra?: Partial<RunEvent>): RunEvent {
  return { seq, head_sha: SHA, run_id: id, run_attempt: 1, workflow_name: workflow, status, conclusion, ...extra };
}

/** `lists` is consumed one entry per `run list` call, the last entry repeating. */
function fakeGh(lists: GhRunInfo[] | GhRunInfo[][], jobs: unknown[] = []): { client: GhClient; calls: string[][] } {
  const calls: string[][] = [];
  const sequence = (Array.isArray(lists[0]) || lists.length === 0 ? lists : [lists]) as GhRunInfo[][];
  let index = 0;
  const exec: GhExec = async (args) => {
    if (args[0] === 'api' && CHECK_RUNS.test(args[1] ?? '')) {
      return { stdout: restCheckRunsBody([]), stderr: '', code: 0 }; // no external checks; not counted
    }
    if (args[0] === 'api' && COMMIT_STATUS.test(args[1] ?? '')) {
      return { stdout: restStatusBody([]), stderr: '', code: 0 };
    }
    calls.push(args);
    if (args[0] === 'api' && RUNS_LIST.test(args[1] ?? '')) {
      const next = sequence[Math.min(index, sequence.length - 1)] as GhRunInfo[];
      index += 1;
      return { stdout: restRunsBody(next as unknown as Record<string, unknown>[]), stderr: '', code: 0 };
    }
    if (args[0] === 'api' && RUN_JOBS.test(args[1] ?? '')) {
      return { stdout: restJobsBody(jobs as unknown[]), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: 'unexpected', code: 1 };
  };
  return { client: new GhClient({ exec, detailedRuns: true }), calls };
}

function relay(batches: { latest_seq: number; events?: RunEvent[] }[]): typeof fetch {
  let call = 0;
  return (async () => {
    const batch = batches[Math.min(call, batches.length - 1)] as (typeof batches)[number];
    call += 1;
    await new Promise((resolve) => setTimeout(resolve, 2));
    return new Response(
      JSON.stringify({ owner_mode: 'app', workflow_run_subscribed: true, latest_seq: batch.latest_seq, events: batch.events ?? [] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

function options(overrides?: Partial<WaitOptions>): WaitOptions {
  return {
    repo: 'o/r',
    target: { kind: 'commit', sha: SHA },
    intervalMs: 5,
    timeoutMs: 2000,
    fallbackMs: 60_000,
    source: 'auto',
    eventsUrl: BASE,
    ...overrides,
  };
}

const quiet = { log: () => undefined, sleep: () => Promise.resolve() };

describe('applyRunEvents', () => {
  it('asks gh when the existing run has no attempt and the event completes it', () => {
    const queued = [noAttempt(ghRun(1, 'CI', 'queued', null))];
    const result = applyRunEvents(queued, [event(1, 1, 'CI', 'completed', 'failure', { run_attempt: 1 })], { kind: 'commit', sha: SHA });
    expect(result).toMatchObject({ changed: false, unmappable: true });
  });

  it('updates a run in place and ignores stale attempts and out-of-order updates', () => {
    const runs = [{ ...ghRun(1, 'CI', 'in_progress', null), attempt: 2, updatedAt: '2026-01-01T00:05:00Z' }];
    const stale = applyRunEvents(runs, [event(1, 1, 'CI', 'completed', 'failure', { run_attempt: 1 })], { kind: 'commit', sha: SHA });
    expect(stale.changed).toBe(false);
    const old = applyRunEvents(runs, [event(1, 1, 'CI', 'completed', 'success', { run_attempt: 2, updated_at: '2026-01-01T00:01:00Z' })], {
      kind: 'commit',
      sha: SHA,
    });
    expect(old.changed).toBe(false);
    const fresh = applyRunEvents(runs, [event(1, 1, 'CI', 'completed', 'success', { run_attempt: 2, updated_at: '2026-01-01T00:09:00Z' })], {
      kind: 'commit',
      sha: SHA,
    });
    expect(fresh.runs[0]).toMatchObject({ status: 'completed', conclusion: 'success', attempt: 2 });
  });

  it('lets a newer run supersede the older run of the same workflow only', () => {
    const runs = [ghRun(5, 'CI', 'completed', 'failure'), ghRun(6, 'Lint', 'completed', 'success')];
    const target = { kind: 'commit', sha: SHA } as const;
    const newer = applyRunEvents(runs, [event(1, 9, 'CI', 'queued', null)], target);
    expect(newer.runs.map((r) => r.databaseId).sort()).toEqual([6, 9]);
    const older = applyRunEvents(runs, [event(1, 3, 'CI', 'completed', 'success')], target);
    expect(older.changed).toBe(false);
  });

  it('flags events it cannot map and ignores other runs for a run target', () => {
    const runs = [ghRun(1, 'CI', 'in_progress', null)];
    expect(applyRunEvents(runs, [{ seq: 1, head_sha: SHA }], { kind: 'commit', sha: SHA }).unmappable).toBe(true);
    expect(applyRunEvents(runs, [event(1, 2, 'Other', 'completed', 'failure')], { kind: 'run', runId: 1 })).toMatchObject({
      changed: false,
      unmappable: false,
    });
  });
});

describe('event mode without per-event gh calls', () => {
  it('does not trust a terminal event alone: the confirming check decides', async () => {
    const a = ghRun(1, 'A', 'in_progress', null);
    const b = ghRun(2, 'B', 'in_progress', null);
    const gh = fakeGh([[a], [{ ...a, status: 'completed', conclusion: 'success' }, b]]);
    const fetchFn = relay([{ latest_seq: 0 }, { latest_seq: 1, events: [event(1, 1, 'A', 'completed', 'success')] }]);
    const result = await waitForTerminal(options({ timeoutMs: 100 }), { ...quiet, client: gh.client, fetchFn });
    expect(result).toEqual({ kind: 'timeout', source: 'events' });
    expect(gh.calls.filter((c) => RUNS_LIST.test(c[1] ?? ''))).toHaveLength(2);
  });

  it('confirms from an initial none state as well', async () => {
    const a = ghRun(1, 'A', 'completed', 'success');
    const gh = fakeGh([[], [a, ghRun(2, 'B', 'in_progress', null)]]);
    const fetchFn = relay([{ latest_seq: 0 }, { latest_seq: 1, events: [event(1, 1, 'A', 'completed', 'success')] }]);
    const result = await waitForTerminal(options({ timeoutMs: 100 }), { ...quiet, client: gh.client, fetchFn });
    expect(result).toEqual({ kind: 'timeout', source: 'events' });
    expect(gh.calls.filter((c) => RUNS_LIST.test(c[1] ?? ''))).toHaveLength(2);
  });

  it('does not turn a queued run without attempt into a failure from an event alone', async () => {
    const queued = noAttempt(ghRun(1, 'CI', 'queued', null));
    const gh = fakeGh([[queued], [queued]]);
    const fetchFn = relay([
      { latest_seq: 0 },
      { latest_seq: 1, events: [event(1, 1, 'CI', 'completed', 'failure', { run_attempt: 1 })] },
    ]);
    const result = await waitForTerminal(options({ timeoutMs: 100 }), { ...quiet, client: gh.client, fetchFn });
    expect(result).toEqual({ kind: 'timeout', source: 'events' });
    expect(gh.calls.filter((c) => RUNS_LIST.test(c[1] ?? '')).length).toBeGreaterThanOrEqual(2);
  });

  it('reaches success only after a confirming gh check, with no gh call for non-terminal events', async () => {
    const open = [ghRun(1, 'CI', 'in_progress', null), ghRun(2, 'Lint', 'in_progress', null)];
    const done = [ghRun(1, 'CI', 'completed', 'success'), ghRun(2, 'Lint', 'completed', 'success')];
    const gh = fakeGh([open, done]);
    const fetchFn = relay([
      { latest_seq: 0 },
      { latest_seq: 1, events: [event(1, 1, 'CI', 'completed', 'success')] },
      { latest_seq: 2, events: [event(2, 2, 'Lint', 'completed', 'success')] },
    ]);
    const pending: string[] = [];
    const result = await waitForTerminal(options(), {
      ...quiet,
      client: gh.client,
      fetchFn,
      onPending: (report) => void pending.push(report.state),
    });
    expect(result).toMatchObject({ kind: 'terminal', source: 'events', report: { state: 'success' } });
    expect(gh.calls.filter((c) => RUNS_LIST.test(c[1] ?? ''))).toHaveLength(2); // baseline + confirm
    expect(pending).toEqual(['pending', 'pending']);
  });

  it('inserts an unseen workflow from an event and keeps the state pending until it completes', async () => {
    const gh = fakeGh([
      [ghRun(1, 'CI', 'completed', 'success'), ghRun(2, 'Lint', 'in_progress', null)],
      [ghRun(1, 'CI', 'completed', 'success'), ghRun(2, 'Lint', 'completed', 'success'), ghRun(3, 'Deploy', 'completed', 'success')],
    ]);
    const fetchFn = relay([
      { latest_seq: 0 },
      { latest_seq: 1, events: [event(1, 3, 'Deploy', 'in_progress', null)] },
      { latest_seq: 2, events: [event(2, 2, 'Lint', 'completed', 'success')] },
      { latest_seq: 3, events: [event(3, 3, 'Deploy', 'completed', 'success')] },
    ]);
    const result = await waitForTerminal(options(), { ...quiet, client: gh.client, fetchFn });
    expect(result).toMatchObject({ kind: 'terminal', report: { state: 'success' } });
    expect(result.kind === 'terminal' && result.report.runs).toHaveLength(3);
    expect(gh.calls.filter((c) => RUNS_LIST.test(c[1] ?? ''))).toHaveLength(2);
  });

  it('fetches jobs only when a run reaches failure', async () => {
    const gh = fakeGh(
      [[ghRun(1, 'CI', 'in_progress', null)], [ghRun(1, 'CI', 'completed', 'failure')]],
      [{ name: 'build', status: 'completed', conclusion: 'failure', steps: [{ name: 'Test', number: 3, conclusion: 'failure' }] }],
    );
    const fetchFn = relay([{ latest_seq: 0 }, { latest_seq: 1, events: [event(1, 1, 'CI', 'completed', 'failure')] }]);
    const result = await waitForTerminal(options(), { ...quiet, client: gh.client, fetchFn });
    expect(result).toMatchObject({
      kind: 'terminal',
      report: { state: 'failure', failedSteps: [{ runId: 1, jobName: 'build', stepName: 'Test', stepNumber: 3 }] },
    });
    expect(gh.calls.map((c) => (RUNS_LIST.test(c[1] ?? '') ? 'runs' : RUN_JOBS.test(c[1] ?? '') ? 'jobs' : 'other'))).toEqual(['runs', 'runs', 'jobs']);
  });

  it('calls gh again for an event it cannot map to a run', async () => {
    const gh = fakeGh([ghRun(1, 'CI', 'in_progress', null)]);
    const fetchFn = relay([{ latest_seq: 0 }, { latest_seq: 1, events: [{ seq: 1, head_sha: SHA }] }]);
    await waitForTerminal(options({ timeoutMs: 100 }), { ...quiet, client: gh.client, fetchFn });
    expect(gh.calls.filter((c) => RUNS_LIST.test(c[1] ?? '')).length).toBeGreaterThanOrEqual(2);
  });

  it('makes no gh call for events of another sha or events that change nothing', async () => {
    const gh = fakeGh([ghRun(1, 'CI', 'in_progress', null)]);
    const fetchFn = relay([
      { latest_seq: 0 },
      { latest_seq: 1, events: [{ ...event(1, 7, 'CI', 'completed', 'failure'), head_sha: 'b'.repeat(40) }] },
      { latest_seq: 2, events: [event(2, 1, 'CI', 'in_progress', null)] },
    ]);
    const result = await waitForTerminal(options({ timeoutMs: 100 }), { ...quiet, client: gh.client, fetchFn });
    expect(result).toEqual({ kind: 'timeout', source: 'events' });
    expect(gh.calls).toHaveLength(1);
  });
});
