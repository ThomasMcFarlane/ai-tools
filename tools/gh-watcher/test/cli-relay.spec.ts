import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli/index.js';
import { fakeRelay, REPO, run as runJson, snapshot, prStatus } from './relay-fakes.js';

let previousExitCode: string | number | undefined;
let previousUrl: string | undefined;
let previousRepo: string | undefined;

beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  previousUrl = process.env['GH_WATCHER_EVENTS_URL'];
  previousRepo = process.env['GH_REPO'];
  delete process.env['GH_WATCHER_EVENTS_URL'];
  delete process.env['GH_REPO'];
});

afterEach(() => {
  process.exitCode = previousExitCode;
  if (previousUrl !== undefined) {
    process.env['GH_WATCHER_EVENTS_URL'] = previousUrl;
  }
  if (previousRepo !== undefined) {
    process.env['GH_REPO'] = previousRepo;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MESSAGE = 'gh-watcher: polling was removed; gh-watcher always uses the relay (drop --source/--interval)';

describe('removed polling flags', () => {
  const base = ['--repo', REPO, '--branch', 'main'];
  const cases: [string, string[]][] = [
    ['wait --source', ['wait', ...base, '--source', 'poll']],
    ['wait --interval', ['wait', ...base, '--interval', '30s']],
    ['wait --interval=', ['wait', ...base, '--interval=30s']],
    ['wait --fallback-interval', ['wait', ...base, '--fallback-interval', '5m']],
    ['follow --source', ['follow', ...base, '--source', 'events']],
    ['status --interval', ['status', ...base, '--interval', '5s']],
    ['pr wait --source', ['pr', 'wait', ...base, '--source', 'auto']],
    ['pr follow --interval', ['pr', 'follow', ...base, '--interval', '60s']],
    ['pr status --fallback-interval', ['pr', 'status', ...base, '--fallback-interval', '5m']],
  ];
  it.each(cases)('%s exits 2 with the removal message and makes no request', async (_name, args) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await run(['node', 'gh-watcher', ...args]);
    expect(process.exitCode).toBe(2);
    expect(write).toHaveBeenCalledWith(`${MESSAGE}\n`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps watch add --interval, which only sets how often the daemon reads the relay', async () => {
    const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp(join(tmpdir(), 'gh-watcher-cli-relay-')));
    const previous = process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
    process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = dir;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(['node', 'gh-watcher', 'watch', 'add', 'w', '--repo', REPO, '--branch', 'main', '--interval', '30s']);
    log.mockRestore();
    expect(process.exitCode).toBeUndefined();
    if (previous === undefined) {
      delete process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
    } else {
      process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = previous;
    }
    await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }));
  });
});

describe('cli output through the relay', () => {
  it('wait --json reports source relay, relaySource and warning, exit 0', async () => {
    const relay = fakeRelay([snapshot(1, [runJson(1, 'completed', 'success')], { source: 'relay-poll', warning: 'relay polls' })]);
    vi.stubGlobal('fetch', relay.fetchFn);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => out.push(line));
    await run(['node', 'gh-watcher', 'wait', '--repo', REPO, '--commit', 'a'.repeat(40), '--events-url', 'http://relay.invalid', '--json']);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ state: 'success', source: 'relay', relaySource: 'relay-poll', warning: 'relay polls' });
  });

  it('wait exits 1 on failure', async () => {
    const relay = fakeRelay([snapshot(1, [runJson(1, 'completed', 'failure')])]);
    vi.stubGlobal('fetch', relay.fetchFn);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(['node', 'gh-watcher', 'wait', '--repo', REPO, '--commit', 'a'.repeat(40), '--events-url', 'http://relay.invalid']);
    expect(process.exitCode).toBe(1);
  });

  it('wait with no relay configured exits 2 at once with the not-configured error', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => out.push(line));
    await run(['node', 'gh-watcher', 'wait', '--repo', REPO, '--commit', 'a'.repeat(40), '--json']);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ error: 'relay_not_configured' });
    expect(String(err.mock.calls[0]?.[0])).toBe('gh-watcher: ERROR no relay configured (set GH_WATCHER_EVENTS_URL)\n');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pr status --json uses pr-status', async () => {
    const relay = fakeRelay([prStatus(1)]);
    vi.stubGlobal('fetch', relay.fetchFn);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => out.push(line));
    await run(['node', 'gh-watcher', 'pr', 'status', '--repo', REPO, '--pr', '7', '--events-url', 'http://relay.invalid', '--json']);
    expect(relay.urls[0]?.pathname).toBe('/api/pr-status');
    expect(JSON.parse(out.join('\n'))).toMatchObject({ number: 7, state: 'OPEN' });
  });
});
