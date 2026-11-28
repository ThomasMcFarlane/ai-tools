import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MAX_MS,
  followTarget,
  readStatus,
  RelayNotConfiguredError,
  RelayUnreachableError,
  waitForTerminal,
  type FollowLine,
  type WaitOptions,
} from '../src/index.js';
import { fakeClock, fakeRelay, REPO, run, SHA, snapshot } from './relay-fakes.js';

const options: WaitOptions = {
  repo: REPO,
  target: { kind: 'commit', sha: SHA },
  timeoutMs: 600_000,
  eventsUrl: 'http://relay.invalid',
};

function setup(): { clock: ReturnType<typeof fakeClock>; logs: string[] } {
  return { clock: fakeClock(), logs: [] };
}

describe('wait through the relay', () => {
  it('returns success when the relay reports every run green, without any gh call', async () => {
    const { clock, logs } = setup();
    const relay = fakeRelay([snapshot(1, [run(1, 'in_progress', null)]), snapshot(2, [run(1, 'completed', 'success')])]);
    const pending: string[] = [];
    const result = await waitForTerminal(options, {
      fetchFn: relay.fetchFn,
      now: clock.now,
      sleep: clock.sleep,
      log: (line) => logs.push(line),
      onPending: (report) => {
        pending.push(report.state);
      },
    });
    expect(result.kind).toBe('terminal');
    if (result.kind !== 'terminal') {
      return;
    }
    expect(result.source).toBe('relay');
    expect(result.report.state).toBe('success');
    expect(result.report.relaySource).toBe('webhook');
    expect(pending).toEqual(['pending']);
    const asked = relay.urls.map((url) => url.pathname);
    expect(asked).toEqual(['/api/status', '/api/status']);
    expect(relay.urls[1]?.searchParams.get('after')).toBe('1');
    expect(relay.urls[1]?.searchParams.get('sha')).toBe(SHA);
    expect(relay.urls[1]?.searchParams.get('wait')).toBe('25');
    expect(relay.urls[1]?.searchParams.get('jobs')).toBe('0');
    expect(logs).toEqual([]);
  });

  it('returns failure with the failed steps from the jobs of the failed run', async () => {
    const { clock } = setup();
    const failed = run(3, 'completed', 'failure', {
      jobs: [
        {
          id: 9,
          name: 'build',
          status: 'completed',
          conclusion: 'failure',
          steps: [
            { number: 1, name: 'Checkout', status: 'completed', conclusion: 'success' },
            { number: 2, name: 'Test', status: 'completed', conclusion: 'failure' },
          ],
        },
      ],
    });
    const relay = fakeRelay([snapshot(4, [failed])]);
    const result = await waitForTerminal(options, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep });
    expect(result.kind).toBe('terminal');
    if (result.kind === 'terminal') {
      expect(result.report.state).toBe('failure');
      expect(result.report.failedSteps).toEqual([
        { runId: 3, workflowName: 'W3', jobName: 'build', stepName: 'Test', stepNumber: 2 },
      ]);
    }
  });

  it('counts a pending non-Actions check and a failed commit status', async () => {
    const { clock } = setup();
    const green = run(1, 'completed', 'success');
    const relay = fakeRelay([
      snapshot(1, [green], { check_runs: [{ id: 5, name: 'scan', status: 'in_progress', conclusion: null, app_slug: 'sec', html_url: 'u' }] }),
      snapshot(2, [green], { statuses: [{ id: 6, context: 'tf', state: 'failure', target_url: 'https://tf.example/x', updated_at: 't' }] }),
    ]);
    const result = await waitForTerminal(options, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep });
    expect(result.kind === 'terminal' && result.report.state).toBe('failure');
    if (result.kind === 'terminal') {
      expect(result.report.failedChecks).toEqual([{ kind: 'status', name: 'tf', source: 'tf.example', url: 'https://tf.example/x' }]);
    }
  });

  it('times out when the relay keeps reporting pending runs', async () => {
    const { clock } = setup();
    const relay = fakeRelay([snapshot(1, [run(1, 'in_progress', null)], { source: 'relay-poll', warning: 'w' })], () => {
      void clock.sleep(25_000); // each long-poll takes 25 s
    });
    const result = await waitForTerminal({ ...options, timeoutMs: 60_000 }, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: () => undefined });
    expect(result).toMatchObject({ kind: 'timeout', source: 'relay', relaySource: 'relay-poll', warning: 'w' });
  });

  it('prints the relay warning once and the stale notice once, and keeps waiting on stale data', async () => {
    const { clock, logs } = setup();
    const done = run(1, 'completed', 'success');
    const stale = { stale: true, error: { kind: 'rate_limit', message: 'GitHub refused', retry_at: null }, warning: 'no webhooks installed for octo-org; the relay polls GitHub every 60 s' };
    const busy = run(1, 'in_progress', null);
    const relay = fakeRelay([snapshot(1, [busy], stale), snapshot(1, [busy], { ...stale, changed: false }), snapshot(2, [done])]);
    const result = await waitForTerminal(options, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: (line) => logs.push(line) });
    expect(result.kind).toBe('terminal');
    expect(relay.urls).toHaveLength(3);
    expect(logs.filter((line) => line.includes('no webhooks installed'))).toHaveLength(1);
    expect(logs.filter((line) => line.includes('stale'))).toHaveLength(1);
    expect(logs.join('\n')).toContain('rate_limit: GitHub refused');
  });

  it('resets after to 0 and treats the snapshot as fresh when boot changes', async () => {
    const { clock } = setup();
    const busy = run(1, 'in_progress', null);
    const relay = fakeRelay([
      snapshot(40, [busy]),
      snapshot(2, [busy], { boot: 'boot-2', changed: false }),
      snapshot(3, [busy], { boot: 'boot-2', changed: false }),
      snapshot(4, [run(1, 'completed', 'success')], { boot: 'boot-2' }),
    ]);
    const pending: number[] = [];
    const result = await waitForTerminal(options, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: () => undefined, onPending: (_r, snap) => void pending.push(snap.rev) });
    expect(result.kind).toBe('terminal');
    expect(relay.urls.map((url) => url.searchParams.get('after'))).toEqual(['0', '40', '0', '3']);
    expect(pending).toEqual([40, 2]);
  });

  it('retries an unreachable relay with 5 s doubling to 60 s, then recovers', async () => {
    const { clock, logs } = setup();
    const down = new Error('connect ECONNREFUSED');
    const relay = fakeRelay([down, down, down, down, down, down, down, snapshot(1, [run(1, 'completed', 'success')])]);
    const result = await waitForTerminal(options, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: (line) => logs.push(line) });
    expect(result.kind).toBe('terminal');
    expect(clock.delays).toEqual([5000, 10_000, 20_000, 40_000, BACKOFF_MAX_MS, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
    expect(logs).toHaveLength(7);
    expect(logs[0]).toBe('gh-watcher: ERROR relay connection failed at http://relay.invalid: connect ECONNREFUSED');
  });

  it('throws relay_unreachable when the relay stays down until the timeout', async () => {
    const { clock, logs } = setup();
    const relay = fakeRelay([new Error('down')]);
    const error = await waitForTerminal({ ...options, timeoutMs: 30_000 }, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: (line) => logs.push(line) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayUnreachableError);
    expect((error as RelayUnreachableError).url).toBe('http://relay.invalid');
    expect(logs.every((line) => line === 'gh-watcher: ERROR relay connection failed at http://relay.invalid: down')).toBe(true);
    expect((error as RelayUnreachableError).message).toBe('relay connection failed at http://relay.invalid: down');
  });

  it('retries an HTTP 503 from the relay and names the status', async () => {
    const { clock } = setup();
    const logs: string[] = [];
    const relay = fakeRelay([{ status: 503 }, snapshot(1, [run(1, 'completed', 'success')])]);
    const result = await waitForTerminal(options, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: (line) => logs.push(line) });
    expect(result.kind).toBe('terminal');
    expect(clock.delays).toEqual([5000]);
    expect(logs).toEqual(['gh-watcher: ERROR relay answered HTTP 503 at http://relay.invalid']);
  });

  it('stops at once on an HTTP 400 from the relay', async () => {
    const { clock } = setup();
    const relay = fakeRelay([{ status: 400, body: 'bad sha' }]);
    await expect(waitForTerminal(options, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: () => undefined })).rejects.toThrow(/bad sha/);
    expect(relay.urls).toHaveLength(1);
  });

  it('fails at once, with no retry and no request, when no relay is configured', async () => {
    const { clock, logs } = setup();
    const relay = fakeRelay([snapshot(1, [])]);
    const error = await waitForTerminal({ ...options, eventsUrl: undefined }, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: (line) => logs.push(line) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayNotConfiguredError);
    expect(logs).toEqual(['gh-watcher: ERROR no relay configured (set GH_WATCHER_EVENTS_URL)']);
    expect(clock.delays).toEqual([]);
    expect(relay.urls).toHaveLength(0);
  });

  it('sends the right query for each target kind', async () => {
    const { clock } = setup();
    const done = snapshot(1, [run(1, 'completed', 'success')]);
    const cases: [WaitOptions['target'], string, string][] = [
      [{ kind: 'pr', number: 12 }, 'pr', '12'],
      [{ kind: 'branch', branch: 'main' }, 'branch', 'main'],
      [{ kind: 'run', runId: 44 }, 'run', '44'],
    ];
    for (const [target, key, value] of cases) {
      const relay = fakeRelay([done]);
      await waitForTerminal({ ...options, target }, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep });
      expect(relay.urls[0]?.searchParams.get(key)).toBe(value);
      expect(relay.urls[0]?.searchParams.get('repo')).toBe(REPO);
    }
  });
});

describe('status through the relay', () => {
  it('reads one snapshot without waiting', async () => {
    const { clock } = setup();
    const relay = fakeRelay([snapshot(1, [run(1, 'in_progress', null)])]);
    const report = await readStatus(options, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep });
    expect(report.state).toBe('pending');
    expect(report.source).toBe('relay');
    expect(relay.urls[0]?.searchParams.get('wait')).toBe('0');
  });
});

describe('follow through the relay', () => {
  it('emits one line per change with jobs and a final line', async () => {
    const { clock } = setup();
    const job = (status: string, conclusion: string | null): unknown => ({
      name: 'build',
      status,
      conclusion,
      html_url: 'https://example.com/job/1',
      steps: [{ number: 1, name: 'Test', status, conclusion }],
    });
    const relay = fakeRelay([
      snapshot(1, [run(1, 'in_progress', null, { jobs: [job('in_progress', null)] })]),
      snapshot(2, [run(1, 'in_progress', null, { jobs: [job('in_progress', null)] })], { changed: false }),
      snapshot(3, [run(1, 'completed', 'success', { jobs: [job('completed', 'success')] })], { source: 'relay-poll', warning: 'w' }),
    ]);
    const lines: FollowLine[] = [];
    const result = await followTarget(options, { fetchFn: relay.fetchFn, now: clock.now, sleep: clock.sleep, log: () => undefined, emit: (line) => lines.push(line) });
    expect(result.exitCode).toBe(0);
    expect(lines.map((line) => [line.state, line.isFinal])).toEqual([
      ['pending', false],
      ['success', true],
    ]);
    expect(lines[0]?.runs[0]?.jobs[0]?.steps?.[0]?.name).toBe('Test');
    expect(lines[1]).toMatchObject({ source: 'relay', relaySource: 'relay-poll', warning: 'w' });
    expect(relay.urls[0]?.searchParams.get('jobs')).toBe('1');
  });

  it('exits 1 on failure and 124 on timeout', async () => {
    const { clock } = setup();
    const failing = fakeRelay([snapshot(1, [run(1, 'completed', 'failure')])]);
    const lines: FollowLine[] = [];
    expect((await followTarget(options, { fetchFn: failing.fetchFn, now: clock.now, sleep: clock.sleep, emit: (line) => lines.push(line) })).exitCode).toBe(1);
    const pending = fakeRelay([snapshot(1, [run(1, 'in_progress', null)])], () => {
      void clock.sleep(25_000);
    });
    const timed: FollowLine[] = [];
    const result = await followTarget({ ...options, timeoutMs: 40_000 }, { fetchFn: pending.fetchFn, now: clock.now, sleep: clock.sleep, emit: (line) => timed.push(line) });
    expect(result.exitCode).toBe(124);
    expect(timed.at(-1)).toMatchObject({ timedOut: true, isFinal: true });
  });
});
