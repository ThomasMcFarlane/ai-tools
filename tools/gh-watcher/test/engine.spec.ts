import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkWatch,
  checkWatchManual,
  collectReport,
  describeEvent,
  loadState,
  readEvents,
  runWatches,
  type EngineDeps,
  type FailedStep,
  type GhClient,
  type GhRunInfo,
  type GhWatchSpec,
  type HookConfig,
  type HookEvent,
  type HookResult,
} from '../src/index.js';

let stateRoot: string;
let previousEnv: string | undefined;
let currentRuns: GhRunInfo[];
let currentFailures: FailedStep[];
const fixedNow = new Date('2026-01-01T00:00:00.000Z');

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'gh-watcher-engine-'));
  previousEnv = process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
  process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = stateRoot;
  currentRuns = [];
  currentFailures = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousEnv === undefined) {
    delete process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
  } else {
    process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = previousEnv;
  }
  await rm(stateRoot, { recursive: true, force: true });
});

function runRun(databaseId: number, status: string, conclusion: string | null): GhRunInfo {
  return {
    databaseId,
    workflowName: 'CI',
    displayTitle: 'build',
    status,
    conclusion,
    url: 'https://example.invalid/runs',
    headSha: 'abc123',
  };
}

function fakeClient(): GhClient {
  return {
    listRuns: async () => currentRuns,
    runJobs: async () => [],
    collectFailures: async () => currentFailures,
  } as unknown as GhClient;
}

interface HookCall {
  hook: HookConfig;
  event: Record<string, unknown>;
}

function buildDeps(): { deps: EngineDeps; hookCalls: HookCall[] } {
  const hookCalls: HookCall[] = [];
  const fireHookFn = vi.fn(async (hook: HookConfig, event: HookEvent): Promise<HookResult> => {
    hookCalls.push({ hook, event: event as Record<string, unknown> });
    return { ok: true };
  });
  return { hookCalls, deps: { client: fakeClient(), fireHookFn, now: () => fixedNow } };
}

function failingHookDeps(detail: string): EngineDeps {
  const fireHookFn = vi.fn(async (): Promise<HookResult> => ({ ok: false, detail }));
  return { client: fakeClient(), fireHookFn, now: () => fixedNow };
}

function watchSpec(name: string, overrides?: Partial<GhWatchSpec>): GhWatchSpec {
  return {
    name,
    repo: 'octo-org/hello-world',
    target: { kind: 'branch', branch: 'main' },
    triggers: { failure: true, success: true },
    hook: { kind: 'none' },
    intervalSeconds: 60,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('collectReport', () => {
  it('collects failures only when the aggregate state is failure', async () => {
    currentRuns = [runRun(1, 'completed', 'failure')];
    currentFailures = [{ runId: 1, workflowName: 'CI', jobName: 'build', stepName: 'test', stepNumber: 3 }];
    const client = fakeClient();
    const collectSpy = vi.spyOn(client, 'collectFailures');
    const report = await collectReport(watchSpec('w1'), { client, now: () => fixedNow });
    expect(report.state).toBe('failure');
    expect(report.targetKey).toBe('branch:main');
    expect(report.failedSteps).toHaveLength(1);
    expect(collectSpy).toHaveBeenCalledTimes(1);
  });

  it('skips failure collection for pending runs', async () => {
    currentRuns = [runRun(1, 'in_progress', null)];
    const client = fakeClient();
    const collectSpy = vi.spyOn(client, 'collectFailures');
    const report = await collectReport(watchSpec('w1'), { client, now: () => fixedNow });
    expect(report.state).toBe('pending');
    expect(report.failedSteps).toEqual([]);
    expect(collectSpy).not.toHaveBeenCalled();
  });
});

describe('checkWatch', () => {
  it('does not fire while pending', async () => {
    currentRuns = [runRun(1, 'in_progress', null)];
    const { deps, hookCalls } = buildDeps();
    const event = await checkWatch(watchSpec('w1'), deps);
    expect(event.state).toBe('pending');
    expect(event.runsCount).toBe(1);
    expect(event.fired).toBe(false);
    expect(hookCalls).toHaveLength(0);
  });

  it('fires the failure trigger once on the rising edge', async () => {
    currentRuns = [runRun(1, 'completed', 'failure')];
    currentFailures = [
      { runId: 1, workflowName: 'CI', jobName: 'build', stepName: 'test', stepNumber: 3 },
      { runId: 1, workflowName: 'CI', jobName: 'build', stepName: 'lint', stepNumber: 4 },
    ];
    const { deps, hookCalls } = buildDeps();
    const first = await checkWatch(watchSpec('w1'), deps);
    expect(first.state).toBe('failure');
    expect(first.fired).toBe(true);
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]?.hook).toEqual({ kind: 'none' });
    expect(hookCalls[0]?.event['summary']).toBe(
      "gh-watcher: octo-org/hello-world branch:main is failure\nstep 3 'test' failed in job 'build' (run 1)\nstep 4 'lint' failed in job 'build' (run 1)",
    );
    expect(hookCalls[0]?.event['watch']).toBe('w1');
    expect(hookCalls[0]?.event['targetKey']).toBe('branch:main');
    expect(hookCalls[0]?.event['runsCount']).toBe(1);
    expect(hookCalls[0]?.event['checkedAt']).toBe('2026-01-01T00:00:00.000Z');
    const second = await checkWatch(watchSpec('w1'), deps);
    expect(second.fired).toBe(false);
    expect(hookCalls).toHaveLength(1);
    const state = await loadState();
    expect(state.watchers[0]?.lastState).toBe('failure');
    expect(state.watchers[0]?.lastFiredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.lastFired['w1']).toEqual({ state: 'failure', runsKey: '1' });
  });

  it('fires the success trigger once', async () => {
    currentRuns = [runRun(1, 'completed', 'success')];
    const { deps, hookCalls } = buildDeps();
    const first = await checkWatch(watchSpec('w1'), deps);
    expect(first.state).toBe('success');
    expect(first.fired).toBe(true);
    const second = await checkWatch(watchSpec('w1'), deps);
    expect(second.fired).toBe(false);
    expect(hookCalls).toHaveLength(1);
  });

  it('respects disabled triggers', async () => {
    currentRuns = [runRun(1, 'completed', 'failure')];
    const { deps, hookCalls } = buildDeps();
    const event = await checkWatch(
      watchSpec('w1', { triggers: { failure: false, success: false } }),
      deps,
    );
    expect(event.state).toBe('failure');
    expect(event.fired).toBe(false);
    expect(hookCalls).toHaveLength(0);
  });

  it('resets the edge when a new run attempt appears', async () => {
    currentRuns = [runRun(1, 'completed', 'failure')];
    const { deps, hookCalls } = buildDeps();
    await checkWatch(watchSpec('w1'), deps);
    expect(hookCalls).toHaveLength(1);
    currentRuns = [runRun(1, 'completed', 'failure'), runRun(2, 'completed', 'failure')];
    const again = await checkWatch(watchSpec('w1'), deps);
    expect(again.fired).toBe(true);
    expect(hookCalls).toHaveLength(2);
  });

  it('marks fired false and records the error when the hook fails', async () => {
    currentRuns = [runRun(1, 'completed', 'failure')];
    const event = await checkWatch(watchSpec('w1'), failingHookDeps('hook exploded'));
    expect(event.fired).toBe(false);
    expect(event.error).toBe('hook exploded');
    const state = await loadState();
    expect(state.watchers[0]?.lastFiredAt).toBeUndefined();
  });

  it('appends the event as a JSON line even without firing', async () => {
    currentRuns = [runRun(1, 'in_progress', null)];
    const { deps } = buildDeps();
    const event = await checkWatch(watchSpec('w1'), deps);
    const events = await readEvents();
    expect(events).toEqual([event]);
  });
});

describe('checkWatchManual', () => {
  it('fires repeatedly while the state matches an enabled trigger', async () => {
    currentRuns = [runRun(1, 'completed', 'failure')];
    const { deps, hookCalls } = buildDeps();
    const first = await checkWatchManual(watchSpec('w1'), deps);
    const second = await checkWatchManual(watchSpec('w1'), deps);
    expect(first.fired).toBe(true);
    expect(second.fired).toBe(true);
    expect(hookCalls).toHaveLength(2);
  });

  it('does not fire for a disabled trigger', async () => {
    currentRuns = [runRun(1, 'completed', 'success')];
    const { deps, hookCalls } = buildDeps();
    const event = await checkWatchManual(
      watchSpec('w1', { triggers: { failure: true, success: false } }),
      deps,
    );
    expect(event.state).toBe('success');
    expect(event.fired).toBe(false);
    expect(hookCalls).toHaveLength(0);
  });
});

describe('runWatches', () => {
  it('throws for an unknown name', async () => {
    currentRuns = [];
    const { deps } = buildDeps();
    await checkWatch(watchSpec('w1'), deps);
    await expect(runWatches(['missing'], deps)).rejects.toThrow(/unknown watch "missing"/);
  });

  it('checks every watcher when names is undefined', async () => {
    currentRuns = [runRun(1, 'in_progress', null)];
    const { deps } = buildDeps();
    await checkWatch(watchSpec('w1'), deps);
    await checkWatch(watchSpec('w2'), deps);
    const events = await runWatches(undefined, deps);
    expect(events.map((event) => event.watch)).toEqual(['w1', 'w2']);
  });

  it('checks only the named watchers', async () => {
    currentRuns = [runRun(1, 'in_progress', null)];
    const { deps } = buildDeps();
    await checkWatch(watchSpec('w1'), deps);
    await checkWatch(watchSpec('w2'), deps);
    const events = await runWatches(['w2'], deps);
    expect(events.map((event) => event.watch)).toEqual(['w2']);
  });
});

describe('describeEvent', () => {
  it('renders the base line and at most three failure steps', async () => {
    currentRuns = [runRun(1, 'completed', 'failure')];
    currentFailures = [
      { runId: 1, workflowName: 'CI', jobName: 'build', stepName: 'a', stepNumber: 1 },
      { runId: 1, workflowName: 'CI', jobName: 'build', stepName: 'b', stepNumber: 2 },
      { runId: 1, workflowName: 'CI', jobName: 'build', stepName: 'c', stepNumber: 3 },
      { runId: 1, workflowName: 'CI', jobName: 'build', stepName: 'd', stepNumber: 4 },
    ];
    const { deps } = buildDeps();
    const event = await checkWatch(watchSpec('w1'), deps);
    const lines = describeEvent(event).split('\n');
    expect(lines[0]).toBe('gh-watcher: octo-org/hello-world branch:main is failure');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("step 3 'c' failed in job 'build' (run 1)");
  });

  it('appends the error line when present', async () => {
    currentRuns = [runRun(1, 'completed', 'failure')];
    const event = await checkWatch(watchSpec('w1'), failingHookDeps('boom'));
    expect(describeEvent(event).endsWith('error: boom')).toBe(true);
  });
});
