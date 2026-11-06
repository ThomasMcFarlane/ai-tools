import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aggregateState,
  saveState,
  checkWatch,
  collectReport,
  GhClient,
  runsKey,
  waitForTerminal,
  type ExternalCheck,
  type GhExec,
  type GhRunInfo,
  type GhWatchSpec,
  type WaitOptions,
} from '../src/index.js';

const SHA = 'c'.repeat(40);
const REPO = 'octo-org/hello-world';

interface Scenario {
  runs?: Record<string, unknown>[];
  checkRuns?: Record<string, unknown>[];
  statuses?: Record<string, unknown>[];
}

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
  };
}

function checkRunJson(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    name: 'lint',
    status: 'completed',
    conclusion: 'success',
    url: 'https://example.com/check/1',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
    app: 'third-party',
    ...over,
  };
}

function statusJson(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    context: 'Terraform Cloud/acme/workspace',
    state: 'success',
    url: 'https://app.terraform.io/run-1',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const lines = (items: Record<string, unknown>[] | undefined): string => (items ?? []).map((i) => JSON.stringify(i)).join('\n');

/** Scripted gh: each scenario is consumed per `run list` call, the last repeating. */
function fakeGh(scenarios: Scenario[]): { client: GhClient; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  const current = (): Scenario => scenarios[Math.min(Math.max(index - 1, 0), scenarios.length - 1)] as Scenario;
  const exec: GhExec = async (args) => {
    calls.push(args);
    const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
    if (args[0] === 'run' && args[1] === 'list') {
      index += 1;
      return ok(JSON.stringify(current().runs ?? []));
    }
    if (args[0] === 'run' && args[1] === 'view') {
      return ok(JSON.stringify({ jobs: [] }));
    }
    if (args[0] === 'pr') {
      return ok(JSON.stringify({ headRefOid: SHA, headRefName: 'x' }));
    }
    if (args[0] === 'api' && String(args[1]).includes('/check-runs')) {
      return ok(lines(current().checkRuns));
    }
    if (args[0] === 'api' && String(args[1]).includes('/status')) {
      return ok(lines(current().statuses));
    }
    return { stdout: '', stderr: 'unexpected', code: 1 };
  };
  return { client: new GhClient({ exec }), calls };
}

function spec(): GhWatchSpec {
  return {
    name: '',
    repo: REPO,
    target: { kind: 'commit', sha: SHA },
    triggers: { failure: false, success: false },
    hook: { kind: 'none' },
    intervalSeconds: 0,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('external checks: commit statuses', () => {
  it('reports a status-only commit as pending, then success', async () => {
    const gh = fakeGh([
      { statuses: [statusJson({ state: 'pending' })] },
      { statuses: [statusJson({ state: 'success' })] },
    ]);
    const first = await collectReport(spec(), { client: gh.client });
    expect(first.state).toBe('pending');
    expect(first.runs).toEqual([]);
    expect(first.checks).toEqual([
      {
        kind: 'status',
        name: 'Terraform Cloud/acme/workspace',
        source: 'app.terraform.io',
        status: 'pending',
        conclusion: 'pending',
        url: 'https://app.terraform.io/run-1',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    const second = await collectReport(spec(), { client: gh.client });
    expect(second.state).toBe('success');
    expect(second.failedChecks).toEqual([]);
  });

  it.each(['failure', 'error'])('maps status %s to failure and lists it in failedChecks', async (state) => {
    const gh = fakeGh([{ statuses: [statusJson({ context: 'ci/terraform', state })] }]);
    const report = await collectReport(spec(), { client: gh.client });
    expect(report.state).toBe('failure');
    expect(report.failedChecks).toEqual([
      { kind: 'status', name: 'ci/terraform', source: 'app.terraform.io', url: 'https://app.terraform.io/run-1' },
    ]);
  });

  it('keeps the newest entry when a context repeats across pages', async () => {
    const gh = fakeGh([
      {
        statuses: [
          statusJson({ id: 1, state: 'pending', updatedAt: '2026-01-01T00:00:00Z' }),
          statusJson({ id: 2, state: 'success', updatedAt: '2026-01-01T00:05:00Z' }),
        ],
      },
    ]);
    const report = await collectReport(spec(), { client: gh.client });
    expect(report.checks).toHaveLength(1);
    expect(report.state).toBe('success');
  });

  it('requests per_page=100 with pagination', async () => {
    const gh = fakeGh([{ statuses: [statusJson({})] }]);
    await collectReport(spec(), { client: gh.client });
    const statusCall = gh.calls.find((c) => String(c[1]).includes('/status'));
    expect(statusCall?.[1]).toBe(`repos/${REPO}/commits/${SHA}/status?per_page=100`);
    expect(statusCall).toContain('--paginate');
  });
});

describe('external checks: check runs', () => {
  it('reports a third-party check run and maps its conclusions', async () => {
    const gh = fakeGh([
      { checkRuns: [checkRunJson({ status: 'in_progress', conclusion: null })] },
      { checkRuns: [checkRunJson({ conclusion: 'timed_out' })] },
      { checkRuns: [checkRunJson({ conclusion: 'neutral' })] },
    ]);
    expect((await collectReport(spec(), { client: gh.client })).state).toBe('pending');
    const failed = await collectReport(spec(), { client: gh.client });
    expect(failed.state).toBe('failure');
    expect(failed.failedChecks).toEqual([
      { kind: 'check_run', name: 'lint', source: 'third-party', url: 'https://example.com/check/1' },
    ]);
    expect((await collectReport(spec(), { client: gh.client })).state).toBe('success');
  });

  it('skips github-actions check runs, which workflow runs already cover', async () => {
    const gh = fakeGh([
      {
        runs: [runJson(1, 'completed', 'success')],
        checkRuns: [checkRunJson({ app: 'github-actions', name: 'build', conclusion: 'failure' })],
      },
    ]);
    const report = await collectReport(spec(), { client: gh.client });
    expect(report.checks).toEqual([]);
    expect(report.state).toBe('success');
  });

  it('keeps the latest check run per app and name', async () => {
    const gh = fakeGh([
      {
        checkRuns: [
          checkRunJson({ id: 1, conclusion: 'failure', startedAt: '2026-01-01T00:00:00Z' }),
          checkRunJson({ id: 2, conclusion: 'success', startedAt: '2026-01-01T00:10:00Z' }),
          checkRunJson({ id: 3, name: 'lint', app: 'other-app', conclusion: 'success' }),
        ],
      },
    ]);
    const report = await collectReport(spec(), { client: gh.client });
    expect(report.checks.map((c) => `${c.source}/${c.name}/${c.status}`).sort()).toEqual([
      'other-app/lint/success',
      'third-party/lint/success',
    ]);
  });

  it('ignores a stale check run but still lets it supersede older runs', async () => {
    const gh = fakeGh([
      {
        checkRuns: [
          checkRunJson({ id: 1, conclusion: 'failure', startedAt: '2026-01-01T00:00:00Z' }),
          checkRunJson({ id: 2, conclusion: 'stale', startedAt: '2026-01-01T00:10:00Z' }),
        ],
      },
    ]);
    const report = await collectReport(spec(), { client: gh.client });
    expect(report.checks).toEqual([]);
    expect(report.state).toBe('none');
  });

  it('does not query checks for a run target', async () => {
    const calls: string[][] = [];
    const exec: GhExec = async (args) => {
      calls.push(args);
      return { stdout: JSON.stringify(runJson(9, 'completed', 'success')), stderr: '', code: 0 };
    };
    const report = await collectReport({ ...spec(), target: { kind: 'run', runId: 9 } }, { client: new GhClient({ exec }) });
    expect(report.checks).toEqual([]);
    expect(calls.every((c) => c[0] !== 'api')).toBe(true);
  });

  it('propagates a gh failure', async () => {
    const exec: GhExec = async (args) =>
      args[0] === 'api' ? { stdout: '', stderr: 'boom', code: 1 } : { stdout: '[]', stderr: '', code: 0 };
    await expect(new GhClient({ exec }).listChecks(REPO, { kind: 'commit', sha: SHA })).rejects.toThrow(/boom/);
  });
});

describe('permission errors', () => {
  it('degrades to Actions runs with checksUnavailable on a 403, warning once', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exec: GhExec = async (args) => {
      if (args[0] === 'api' && String(args[1]).includes('/check-runs')) {
        return { stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)', code: 1 };
      }
      if (args[0] === 'run' && args[1] === 'list') {
        return { stdout: JSON.stringify([runJson(1, 'completed', 'success')]), stderr: '', code: 0 };
      }
      return { stdout: '', stderr: 'unexpected', code: 1 };
    };
    const client = new GhClient({ exec });
    const report = await collectReport(spec(), { client });
    await collectReport(spec(), { client });
    const writes = write.mock.calls.length;
    write.mockRestore();
    expect(report.state).toBe('success');
    expect(report.checks).toEqual([]);
    expect(report.checksUnavailable).toMatch(/check-runs/);
    expect(writes).toBe(1);
  });

  it('still throws for a non-permission failure', async () => {
    const exec: GhExec = async (args) =>
      args[0] === 'api' ? { stdout: '', stderr: 'HTTP 500: server error', code: 1 } : { stdout: '[]', stderr: '', code: 0 };
    await expect(collectReport(spec(), { client: new GhClient({ exec }) })).rejects.toThrow(/500/);
  });
});

describe('aggregation with checks', () => {
  const run = (over: Partial<GhRunInfo>): GhRunInfo => ({
    databaseId: 1,
    workflowName: 'CI',
    displayTitle: 't',
    status: 'completed',
    conclusion: 'success',
    url: 'u',
    headSha: SHA,
    ...over,
  });
  const check = (over: Partial<ExternalCheck>): ExternalCheck => ({
    kind: 'status',
    name: 'ci/terraform',
    source: 'tfc',
    status: 'success',
    conclusion: 'success',
    url: 'u',
    ...over,
  });

  it('is none only when both are empty', () => {
    expect(aggregateState([], [])).toBe('none');
    expect(aggregateState([], [check({})])).toBe('success');
    expect(aggregateState([run({})], [])).toBe('success');
  });

  it('is pending if any run or check is pending, ahead of failure', () => {
    expect(aggregateState([run({})], [check({ status: 'pending' })])).toBe('pending');
    expect(aggregateState([run({ conclusion: 'failure' })], [check({ status: 'pending' })])).toBe('pending');
    expect(aggregateState([run({ status: 'queued', conclusion: null })], [check({ status: 'failure' })])).toBe('pending');
  });

  it('is failure if a run or a check failed', () => {
    expect(aggregateState([run({})], [check({ status: 'failure' })])).toBe('failure');
    expect(aggregateState([run({ conclusion: 'failure' })], [check({})])).toBe('failure');
  });

  it('changes the change key when an external check changes state', () => {
    const runs = [run({})];
    const pending = runsKey(runs, [check({ status: 'pending' })]);
    const success = runsKey(runs, [check({ status: 'success' })]);
    expect(pending).not.toBe(success);
    expect(runsKey(runs, [check({ status: 'success' })])).toBe(success);
    expect(runsKey(runs, [])).toBe('1');
  });

  it('collects mixed runs and checks into one report', async () => {
    const gh = fakeGh([
      {
        runs: [runJson(1, 'completed', 'success')],
        checkRuns: [checkRunJson({ status: 'queued', conclusion: null })],
        statuses: [statusJson({})],
      },
    ]);
    const report = await collectReport(spec(), { client: gh.client });
    expect(report.state).toBe('pending');
    expect(report.runs).toHaveLength(1);
    expect(report.checks).toHaveLength(2);
  });
});

describe('watch change detection', () => {
  let dir: string;
  let previous: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gh-watcher-ext-'));
    previous = process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
    process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = dir;
  });
  afterEach(async () => {
    if (previous === undefined) {
      delete process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
    } else {
      process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = previous;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('fires success once a status-only commit turns green and failure when it later fails', async () => {
    const gh = fakeGh([
      { statuses: [statusJson({ state: 'pending' })] },
      { statuses: [statusJson({ state: 'success' })] },
      { statuses: [statusJson({ state: 'success' })] },
      { statuses: [statusJson({ state: 'failure' })] },
    ]);
    const fireHookFn = vi.fn(async () => ({ ok: true }));
    const watch: GhWatchSpec = {
      ...spec(),
      name: 'tf',
      triggers: { failure: true, success: true },
      hook: { kind: 'exec', command: 'true' } as GhWatchSpec['hook'],
    };
    const deps = { client: gh.client, fireHookFn, now: () => new Date('2026-01-01T00:00:00Z') };
    const states = [];
    for (let i = 0; i < 4; i += 1) {
      const event = await checkWatch(watch, deps);
      states.push([event.state, event.fired, event.checksCount]);
    }
    expect(states).toEqual([
      ['pending', false, 1],
      ['success', true, 1],
      ['success', false, 1],
      ['failure', true, 1],
    ]);
    expect(fireHookFn).toHaveBeenCalledTimes(2);
    const last = fireHookFn.mock.calls[1] as unknown as [unknown, Record<string, unknown>];
    expect(last[1]['failedChecks']).toEqual([
      { kind: 'status', name: 'Terraform Cloud/acme/workspace', source: 'app.terraform.io', url: 'https://app.terraform.io/run-1' },
    ]);
  });
});

describe('change key edges', () => {
  let dir: string;
  let previous: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gh-watcher-edge-'));
    previous = process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
    process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = dir;
  });
  afterEach(async () => {
    if (previous === undefined) {
      delete process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
    } else {
      process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = previous;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const watch = (): GhWatchSpec => ({
    ...spec(),
    name: 'tf',
    triggers: { failure: true, success: true },
    hook: { kind: 'exec', command: 'true' } as GhWatchSpec['hook'],
  });
  const now = () => new Date('2026-01-01T00:00:00Z');

  it('does not refire after an upgrade when an old-format key matches the run ids', async () => {
    await saveState({ watchers: [], lastFired: { tf: { state: 'success', runsKey: '1' } } });
    const gh = fakeGh([{ runs: [runJson(1, 'completed', 'success')], statuses: [statusJson({})] }]);
    const fireHookFn = vi.fn(async () => ({ ok: true }));
    const event = await checkWatch(watch(), { client: gh.client, fireHookFn, now });
    expect(event.state).toBe('success');
    expect(event.fired).toBe(false);
    expect(fireHookFn).not.toHaveBeenCalled();
  });

  it('deliberately resets the edge on any check status change (A=failure, B=failure then B=success refires)', async () => {
    const a = statusJson({ id: 1, context: 'A', state: 'failure' });
    const gh = fakeGh([
      { statuses: [a, statusJson({ id: 2, context: 'B', state: 'failure' })] },
      { statuses: [a, statusJson({ id: 2, context: 'B', state: 'failure' })] },
      { statuses: [a, statusJson({ id: 2, context: 'B', state: 'success' })] },
    ]);
    const fireHookFn = vi.fn(async () => ({ ok: true }));
    const fired: boolean[] = [];
    for (let i = 0; i < 3; i += 1) {
      fired.push((await checkWatch(watch(), { client: gh.client, fireHookFn, now })).fired);
    }
    expect(fired).toEqual([true, false, true]);
  });
});

describe('head lookups', () => {
  it('costs one lookup, one run list, one check-runs and one status call per check in event mode', async () => {
    const gh = fakeGh([{}]);
    const fetchFn = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(
        JSON.stringify({ repo: REPO, owner_mode: 'app', workflow_run_subscribed: true, latest_seq: 0, events: [] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await waitForTerminal(
      {
        repo: REPO,
        target: { kind: 'pr', number: 4 },
        intervalMs: 20,
        timeoutMs: 400,
        fallbackMs: 600_000,
        source: 'auto',
        eventsUrl: 'https://events.invalid',
      },
      { client: gh.client, fetchFn, log: () => undefined, sleep: async () => undefined },
    );
    expect(result.kind).toBe('timeout');
    const count = (pred: (c: string[]) => boolean): number => gh.calls.filter(pred).length;
    const runLists = count((c) => c[0] === 'run' && c[1] === 'list');
    expect(runLists).toBeGreaterThanOrEqual(3);
    // One head lookup in total per check (the initial resolve plus one per re-check).
    expect(count((c) => c[0] === 'pr')).toBe(runLists);
    expect(count((c) => String(c[1]).includes('/check-runs'))).toBe(runLists);
    expect(count((c) => String(c[1]).includes('/status'))).toBe(runLists);
    expect(gh.calls).toHaveLength(runLists * 4);
  }, 15_000);
});

describe('event mode with external checks', () => {
  const BASE = 'https://events.invalid';
  const options = (over?: Partial<WaitOptions>): WaitOptions => ({
    repo: REPO,
    target: { kind: 'commit', sha: SHA },
    intervalMs: 20,
    timeoutMs: 10_000,
    fallbackMs: 600_000,
    source: 'auto',
    eventsUrl: BASE,
    ...over,
  });
  const fetchFn = (async () =>
    new Response(JSON.stringify({ repo: REPO, owner_mode: 'app', workflow_run_subscribed: true, latest_seq: 0, events: [] }), {
      status: 200,
    })) as unknown as typeof fetch;
  const quiet = { log: () => undefined, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))) };

  it('re-checks at the interval, not the fallback, and keeps source events, while a non-Actions check is pending', async () => {
    const gh = fakeGh([
      { statuses: [statusJson({ state: 'pending' })] },
      { statuses: [statusJson({ state: 'pending' })] },
      { statuses: [statusJson({ state: 'success' })] },
    ]);
    const seen: string[] = [];
    const result = await waitForTerminal(options(), {
      ...quiet,
      client: gh.client,
      fetchFn,
      onPending: (report, source) => {
        seen.push(`${report.state}/${source}`);
      },
    });
    expect(result).toMatchObject({ kind: 'terminal', source: 'events', report: { state: 'success' } });
    expect(seen[0]).toBe('pending/events');
    expect(seen.slice(1)).toEqual(['pending/events']);
  }, 15_000);

  it('keeps the event path for Actions-only pending state', async () => {
    const gh = fakeGh([{ runs: [runJson(1, 'in_progress', null)] }]);
    const result = await waitForTerminal(options({ timeoutMs: 1500, fallbackMs: 600_000 }), {
      ...quiet,
      client: gh.client,
      fetchFn,
    });
    expect(result).toEqual({ kind: 'timeout', source: 'events' });
    expect(gh.calls.filter((c) => c[0] === 'run' && c[1] === 'list')).toHaveLength(1);
  }, 15_000);
});
