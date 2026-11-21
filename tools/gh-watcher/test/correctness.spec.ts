import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as cli } from '../src/cli/index.js';
import { normaliseRepo } from '../src/cli/repo.js';
import { aggregateState, snapshotToReport, waitForTerminal, type GhRunInfo, type WaitOptions } from '../src/index.js';
import { fakeClock, fakeRelay, REPO, run, SHA, snapshot } from './relay-fakes.js';

const target = { kind: 'commit', sha: SHA } as const;
const options: WaitOptions = { repo: REPO, target, timeoutMs: 120_000, eventsUrl: 'http://relay.invalid' };

function info(over: Partial<GhRunInfo>): GhRunInfo {
  return { databaseId: 1, workflowName: 'W', displayTitle: 't', status: 'completed', conclusion: 'success', url: '', headSha: SHA, ...over };
}

describe('aggregateState: success needs a non-empty, fully green set', () => {
  it('is none when empty', () => {
    expect(aggregateState([], [])).toBe('none');
  });
  it('is pending when a green run sits beside a queued one (defect A)', () => {
    const runs = [info({ databaseId: 1, workflowName: 'No GitHub-hosted runners' }), info({ databaseId: 2, workflowName: 'CI', status: 'queued', conclusion: null })];
    expect(aggregateState(runs)).toBe('pending');
  });
  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])('is pending for run status %s', (status) => {
    expect(aggregateState([info({ status, conclusion: null })])).toBe('pending');
  });
  it('is pending for a completed run without a conclusion', () => {
    expect(aggregateState([info({ conclusion: null })])).toBe('pending');
  });
  it('is failure for an unrecognised conclusion', () => {
    expect(aggregateState([info({ conclusion: 'weird' })])).toBe('failure');
  });
  it('is pending while a status is pending beside green runs', () => {
    expect(aggregateState([info({})], [{ kind: 'status', name: 'x', source: '', status: 'pending', conclusion: 'pending', url: '' }])).toBe('pending');
  });
});

/** A relay whose every long-poll takes 25 s on the fake clock. */
function slowRelay(replies: Parameters<typeof fakeRelay>[0]): { fake: ReturnType<typeof fakeRelay>; clock: ReturnType<typeof fakeClock> } {
  const clock = fakeClock();
  const fake = fakeRelay(replies, () => {
    void clock.sleep(25_000);
  });
  return { fake, clock };
}

describe('snapshots that are not final', () => {
  it.each([{ pending: true }, { stale: true }])('%j never reports success', async (extra) => {
    const { fake, clock } = slowRelay([snapshot(1, [run(1, 'completed', 'success')], extra)]);
    const result = await waitForTerminal({ ...options, timeoutMs: 60_000 }, { fetchFn: fake.fetchFn, now: clock.now, sleep: clock.sleep, log: () => undefined });
    expect(result.kind).toBe('timeout');
  });
  it('snapshotToReport downgrades success and failure when pending or stale', async () => {
    const { parseStatusResponse } = await import('../src/index.js');
    for (const extra of [{ pending: true }, { stale: true }]) {
      for (const conclusion of ['success', 'failure']) {
        const report = snapshotToReport(REPO, target, parseStatusResponse(snapshot(1, [run(1, 'completed', conclusion)], extra)));
        expect(report.state).toBe('pending');
      }
    }
  });
});

describe('wait keeps waiting', () => {
  it('does not return success while a second run is still running, then succeeds', async () => {
    const clk = fakeClock();
    const fake = fakeRelay([
      snapshot(1, [run(1, 'completed', 'success'), run(2, 'in_progress', null)]),
      snapshot(2, [run(1, 'completed', 'success'), run(2, 'completed', 'success')]),
    ]);
    const result = await waitForTerminal(options, { fetchFn: fake.fetchFn, now: clk.now, sleep: clk.sleep, log: () => undefined });
    expect(result.kind).toBe('terminal');
    expect(fake.urls.length).toBe(2);
  });
  it('waits for the other run before reporting a failure', async () => {
    const clk = fakeClock();
    const fake = fakeRelay([
      snapshot(1, [run(1, 'completed', 'failure'), run(2, 'in_progress', null)]),
      snapshot(2, [run(1, 'completed', 'failure'), run(2, 'completed', 'success')]),
    ]);
    const result = await waitForTerminal(options, { fetchFn: fake.fetchFn, now: clk.now, sleep: clk.sleep, log: () => undefined });
    expect(result.kind === 'terminal' && result.report.state).toBe('failure');
    expect(fake.urls.length).toBe(2);
  });
  it('no items at all is never success: keeps waiting, notices once, times out as none (defect B)', async () => {
    const logs: string[] = [];
    const { fake, clock } = slowRelay([snapshot(1, [])]);
    const result = await waitForTerminal({ ...options, timeoutMs: 90_000 }, { fetchFn: fake.fetchFn, now: clock.now, sleep: clock.sleep, log: (line) => logs.push(line) });
    expect(result).toMatchObject({ kind: 'timeout', state: 'none' });
    expect(logs.filter((line) => line.includes('no checks exist yet'))).toHaveLength(1);
  });
});

describe('cli exit paths always print JSON on stdout', () => {
  let previousExitCode: string | number | undefined;
  let previousRepo: string | undefined;
  let previousUrl: string | undefined;
  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    previousRepo = process.env['GH_REPO'];
    previousUrl = process.env['GH_WATCHER_EVENTS_URL'];
    delete process.env['GH_REPO'];
    delete process.env['GH_WATCHER_EVENTS_URL'];
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.exitCode = previousExitCode;
    if (previousRepo !== undefined) process.env['GH_REPO'] = previousRepo;
    if (previousUrl !== undefined) process.env['GH_WATCHER_EVENTS_URL'] = previousUrl;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function wait(args: string[], replies: Parameters<typeof fakeRelay>[0] | undefined): Promise<{ out: unknown; code: number | string | undefined; raw: string[] }> {
    if (replies !== undefined) {
      vi.stubGlobal('fetch', fakeRelay(replies).fetchFn);
    }
    const raw: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => raw.push(line));
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      raw.push(String(chunk));
      return true;
    });
    await cli(['node', 'gh-watcher', 'wait', '--json', ...args]);
    expect(raw.length).toBeGreaterThan(0);
    return { out: JSON.parse(raw.join('')), code: process.exitCode, raw };
  }
  const base = ['--repo', REPO, '--commit', SHA, '--events-url', 'http://relay.invalid'];

  it('success', async () => {
    const r = await wait(base, [snapshot(1, [run(1, 'completed', 'success')])]);
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ state: 'success', runsCount: 1 });
  });
  it('two runs, one still queued: no success', async () => {
    const r = await wait([...base, '--timeout', '1s'], [snapshot(1, [run(1, 'completed', 'success'), run(2, 'queued', null)])]);
    expect(r.code).toBe(124);
    expect(r.out).toMatchObject({ state: 'pending', timedOut: true });
  });
  it('empty runs: no success, times out as none', async () => {
    const r = await wait([...base, '--timeout', '1s'], [snapshot(1, [])]);
    expect(r.code).toBe(124);
    expect(r.out).toMatchObject({ state: 'none', timedOut: true });
  });
  it('failure', async () => {
    const r = await wait(base, [snapshot(1, [run(1, 'completed', 'failure')])]);
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ state: 'failure' });
  });
  it('timeout', async () => {
    const r = await wait([...base, '--timeout', '1s'], [snapshot(1, [run(1, 'in_progress', null)])]);
    expect(r.code).toBe(124);
    expect(r.out).toMatchObject({ timedOut: true });
  });
  it('relay unreachable', async () => {
    const r = await wait([...base, '--timeout', '1s'], [new Error('down')]);
    expect(r.code).toBe(2);
    expect(r.out).toMatchObject({ error: 'relay_unreachable' });
  });
  it('relay not configured', async () => {
    const r = await wait(['--repo', REPO, '--commit', SHA], undefined);
    expect(r.code).toBe(2);
    expect(r.out).toMatchObject({ error: 'relay_not_configured' });
  });
  it('bad arguments: no target, bad repo, bad commit, bad duration', async () => {
    for (const args of [['--repo', REPO], ['--repo', 'nonsense', '--commit', SHA], ['--repo', REPO, '--commit', 'zz'], [...base, '--timeout', 'soon']]) {
      process.exitCode = undefined;
      const r = await wait(args, undefined);
      expect(r.code).toBe(2);
      expect(r.out).toMatchObject({ error: 'bad_arguments' });
    }
  });
  it('accepts a github.com URL as --repo', async () => {
    const relay = fakeRelay([snapshot(1, [run(1, 'completed', 'success')])]);
    vi.stubGlobal('fetch', relay.fetchFn);
    const r = await wait(['--repo', `https://github.com/${REPO}.git`, '--commit', SHA, '--events-url', 'http://relay.invalid'], undefined);
    expect(r.code).toBe(0);
    expect(relay.urls[0]?.searchParams.get('repo')).toBe(REPO);
  });
});

describe('normaliseRepo', () => {
  it.each([
    [REPO, REPO],
    [`github.com/${REPO}`, REPO],
    [`https://github.com/${REPO}`, REPO],
    [`http://www.github.com/${REPO}/`, REPO],
    [`https://github.com/${REPO}.git`, REPO],
    [`${REPO}.git`, REPO],
    [`git@github.com:${REPO}.git`, REPO],
    [`  ${REPO}  `, REPO],
  ])('%s -> %s', (input, expected) => {
    expect(normaliseRepo(input)).toBe(expected);
  });
  it.each(['', 'a', 'a/b/c', '../x', 'https://example.com/a/b', 'a b/c'])('rejects %j', (input) => {
    expect(() => normaliseRepo(input)).toThrow(/invalid repository/);
  });
});

describe('every command normalises --repo', () => {
  const previous = { url: process.env['GH_WATCHER_EVENTS_URL'], repo: process.env['GH_REPO'] };
  beforeEach(() => {
    delete process.env['GH_WATCHER_EVENTS_URL'];
    delete process.env['GH_REPO'];
    process.exitCode = undefined;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.exitCode = undefined;
    if (previous.url !== undefined) process.env['GH_WATCHER_EVENTS_URL'] = previous.url;
    if (previous.repo !== undefined) process.env['GH_REPO'] = previous.repo;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const url = `https://github.com/${REPO}.git`;
  const events = ['--events-url', 'http://relay.invalid'];
  const cases: [string, string[]][] = [
    ['status', ['status', '--commit', SHA]],
    ['follow', ['follow', '--commit', SHA, '--timeout', '1s']],
    ['pr status', ['pr', 'status', '--pr', '7']],
    ['pr wait', ['pr', 'wait', '--pr', '7', '--timeout', '1s']],
  ];
  it.each(cases)('%s sends OWNER/NAME to the relay', async (_name, args) => {
    const relay = fakeRelay([snapshot(1, [run(1, 'completed', 'success')])]);
    vi.stubGlobal('fetch', relay.fetchFn);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await cli(['node', 'gh-watcher', ...args, '--repo', url, ...events]);
    expect(relay.urls.length).toBeGreaterThan(0);
    expect(relay.urls[0]?.searchParams.get('repo')).toBe(REPO);
  });
  it('watch add stores OWNER/NAME', async () => {
    const fs = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = await fs.mkdtemp(join(process.env['GH_WATCHER_TEST_DIR'] ?? '.', 'gw-repo-'));
    const prior = process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
    process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = dir;
    try {
      await cli(['node', 'gh-watcher', 'watch', 'add', 'w1', '--repo', `github.com/${REPO}`, '--commit', SHA, '--json']);
      const printed = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]).join('');
      expect(JSON.parse(printed)).toMatchObject({ repo: REPO });
    } finally {
      if (prior === undefined) delete process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
      else process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = prior;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
