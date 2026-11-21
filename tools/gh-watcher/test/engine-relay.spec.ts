import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkWatch,
  collectReport,
  runDaemon,
  upsertWatcher,
  type GhWatchSpec,
  type HookConfig,
  type HookEvent,
  type HookResult,
} from '../src/index.js';
import { fakeClock, fakeRelay, prStatus, REPO, run, snapshot } from './relay-fakes.js';

let root: string;
let previous: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gh-watcher-engine-relay-'));
  previous = process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
  process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = root;
});

afterEach(async () => {
  if (previous === undefined) {
    delete process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
  } else {
    process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = previous;
  }
  await rm(root, { recursive: true, force: true });
});

function spec(extra: Partial<GhWatchSpec> = {}): GhWatchSpec {
  return {
    name: 'w',
    repo: REPO,
    target: { kind: 'branch', branch: 'main' },
    triggers: { failure: true, success: true },
    hook: { kind: 'none' },
    intervalSeconds: 1,
    createdAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

describe('watch checks through the relay', () => {
  it('collects a report from /api/status', async () => {
    const relay = fakeRelay([snapshot(1, [run(1, 'completed', 'success')])]);
    const report = await collectReport(spec(), { eventsUrl: 'http://relay.invalid', fetchFn: relay.fetchFn });
    expect(report.state).toBe('success');
    expect(relay.urls[0]?.searchParams.get('branch')).toBe('main');
  });

  it('fires the hook once on failure', async () => {
    const relay = fakeRelay([snapshot(1, [run(1, 'completed', 'failure')])]);
    const hooks: HookEvent[] = [];
    const fireHookFn = vi.fn(async (_hook: HookConfig, event: HookEvent): Promise<HookResult> => {
      hooks.push(event);
      return { ok: true };
    });
    const event = await checkWatch(spec(), { eventsUrl: 'http://relay.invalid', fetchFn: relay.fetchFn, fireHookFn });
    expect(event.fired).toBe(true);
    expect(event.state).toBe('failure');
    expect(hooks).toHaveLength(1);
  });

  it('fires on a pull request event read from /api/pr-status', async () => {
    const relay = fakeRelay([prStatus(1), prStatus(2, { state: 'merged' })]);
    const fireHookFn = vi.fn(async (): Promise<HookResult> => ({ ok: true }));
    const prSpec = spec({ target: { kind: 'pr', number: 7 }, triggers: { failure: false, success: false }, prEvents: ['merged'] });
    const deps = { eventsUrl: 'http://relay.invalid', fetchFn: relay.fetchFn, fireHookFn };
    const first = await checkWatch(prSpec, deps);
    expect(first.fired).toBe(false);
    const second = await checkWatch(prSpec, deps);
    expect(second.prEvents?.map((event) => event.kind)).toEqual(['merged']);
    expect(relay.urls.every((url) => url.pathname === '/api/pr-status')).toBe(true);
  });
});

describe('runDaemon', () => {
  it('stops promptly on abort and survives an unreachable relay', async () => {
    await upsertWatcher(spec());
    const clock = fakeClock();
    const relay = fakeRelay([new Error('down')]);
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    await runDaemon(
      undefined,
      { pollSeconds: 3600, signal: controller.signal },
      { eventsUrl: 'http://relay.invalid', fetchFn: relay.fetchFn, sleep: clock.sleep, log: () => undefined, relayTimeoutMs: 10 },
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
