import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkWatch,
  checkWatchManual,
  describeEvent,
  loadState,
  type EngineDeps,
  type GhClient,
  type GhRunInfo,
  type GhWatchSpec,
  type HookConfig,
  type HookEvent,
  type HookResult,
  type PrSnapshot,
} from '../src/index.js';

let stateRoot: string;
let previousEnv: string | undefined;
let snapshots: Map<number, PrSnapshot>;
let branchPr: number | undefined;
let runs: GhRunInfo[];
const fixedNow = new Date('2026-01-01T00:00:00.000Z');

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'gh-watcher-engine-pr-'));
  previousEnv = process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
  process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = stateRoot;
  snapshots = new Map();
  branchPr = undefined;
  runs = [];
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

function snap(overrides?: Partial<PrSnapshot>): PrSnapshot {
  return {
    number: 5,
    url: 'https://example.com/pull/5',
    title: 'Add feature',
    state: 'OPEN',
    isDraft: false,
    headSha: 'a'.repeat(40),
    headRef: 'feature',
    reviewDecision: null,
    comments: [],
    reviews: [],
    reviewComments: [],
    checkedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function build(): { deps: EngineDeps; hookCalls: Record<string, unknown>[]; listRuns: ReturnType<typeof vi.fn> } {
  const hookCalls: Record<string, unknown>[] = [];
  const listRuns = vi.fn(async () => runs);
  const client = {
    listRuns,
    collectFailures: async () => [],
    prSnapshot: async (_repo: string, number: number) => snapshots.get(number) as PrSnapshot,
    findPrForBranch: async () => branchPr,
  } as unknown as GhClient;
  const fireHookFn = vi.fn(async (_hook: HookConfig, event: HookEvent): Promise<HookResult> => {
    hookCalls.push(event as Record<string, unknown>);
    return { ok: true };
  });
  return { deps: { client, fireHookFn, now: () => fixedNow }, hookCalls, listRuns };
}

function prSpec(overrides?: Partial<GhWatchSpec>): GhWatchSpec {
  return {
    name: 'p1',
    repo: 'octo-org/hello-world',
    target: { kind: 'pr', number: 5 },
    triggers: { failure: false, success: false },
    prEvents: ['merged', 'comment', 'draft', 'ready', 'opened'],
    hook: { kind: 'none' },
    intervalSeconds: 60,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('checkWatch with pull request events', () => {
  it('records the baseline on the first check and fires nothing', async () => {
    snapshots.set(5, snap({ state: 'MERGED' }));
    const { deps, hookCalls, listRuns } = build();
    const event = await checkWatch(prSpec(), deps);
    expect(event.fired).toBe(false);
    expect(hookCalls).toHaveLength(0);
    expect(listRuns).not.toHaveBeenCalled();
    const state = await loadState();
    expect(state.watchers[0]?.lastPr).toMatchObject({ number: 5, state: 'MERGED', headSha: 'a'.repeat(40) });
  });

  it('fires once with the matched events and the pr summary', async () => {
    snapshots.set(5, snap());
    const { deps, hookCalls } = build();
    await checkWatch(prSpec(), deps);
    snapshots.set(
      5,
      snap({
        state: 'MERGED',
        mergedAt: '2026-01-02T00:00:00Z',
        headSha: 'b'.repeat(40),
        comments: [{ id: 'c1', author: 'alice', createdAt: '2026-01-01T12:00:00Z', url: 'https://example.com/c1' }],
      }),
    );
    const event = await checkWatch(prSpec(), deps);
    expect(event.fired).toBe(true);
    expect(event.prEvents?.map((item) => item.kind)).toEqual(['merged', 'comment']);
    expect(hookCalls).toHaveLength(1);
    const payload = hookCalls[0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['pr', 'prEvents', 'repo', 'summary', 'targetKey', 'watch']);
    expect(payload['watch']).toBe('p1');
    expect(payload['targetKey']).toBe('pr:5');
    expect(payload['pr']).toEqual({
      number: 5,
      url: 'https://example.com/pull/5',
      state: 'MERGED',
      isDraft: false,
      headSha: 'b'.repeat(40),
      reviewDecision: null,
    });
    expect((payload['prEvents'] as { kind: string }[]).map((item) => item.kind)).toEqual(['merged', 'comment']);
    expect(String(payload['summary'])).toContain('- merged');
    expect(describeEvent(event)).toContain('pr event: comment by alice');
    const again = await checkWatch(prSpec(), deps);
    expect(again.fired).toBe(false);
    expect(hookCalls).toHaveLength(1);
  });

  it('only fires for the wanted kinds', async () => {
    snapshots.set(5, snap());
    const { deps, hookCalls } = build();
    const spec = prSpec({ prEvents: ['merged'] });
    await checkWatch(spec, deps);
    snapshots.set(5, snap({ headSha: 'b'.repeat(40), isDraft: true }));
    const event = await checkWatch(spec, deps);
    expect(event.fired).toBe(false);
    expect(hookCalls).toHaveLength(0);
  });

  it('keeps the baseline for a branch without a pull request and reports opened later', async () => {
    const { deps, hookCalls } = build();
    const spec = prSpec({ target: { kind: 'branch', branch: 'feature' } });
    await checkWatch(spec, deps);
    expect((await loadState()).watchers[0]?.lastPr).toBeNull();
    branchPr = 5;
    snapshots.set(5, snap());
    const event = await checkWatch(spec, deps);
    expect(event.fired).toBe(true);
    expect(event.prEvents?.map((item) => item.kind)).toEqual(['opened']);
    expect(hookCalls).toHaveLength(1);
  });

  it('manual checks fire on events since the last stored state', async () => {
    snapshots.set(5, snap());
    const { deps, hookCalls } = build();
    await checkWatch(prSpec(), deps);
    snapshots.set(5, snap({ isDraft: true }));
    const event = await checkWatchManual(prSpec(), deps);
    expect(event.fired).toBe(true);
    expect(hookCalls).toHaveLength(1);
  });

  it('runs the CI check as well when CI triggers are set and fires one hook', async () => {
    runs = [
      {
        databaseId: 1,
        workflowName: 'CI',
        displayTitle: 'build',
        status: 'completed',
        conclusion: 'success',
        url: 'u',
        headSha: 'abc',
      },
    ];
    snapshots.set(5, snap());
    const { deps, hookCalls, listRuns } = build();
    const spec = prSpec({ triggers: { failure: true, success: true } });
    const first = await checkWatch(spec, deps);
    expect(first.fired).toBe(true);
    expect(listRuns).toHaveBeenCalledTimes(1);
    snapshots.set(5, snap({ isDraft: true }));
    const second = await checkWatch(spec, deps);
    expect(second.fired).toBe(true);
    expect(hookCalls).toHaveLength(2);
    expect(hookCalls[1]?.['state']).toBeUndefined();
    expect(hookCalls[1]?.['prEvents']).toBeDefined();
  });
});

describe('back-compat without prEvents', () => {
  it('never touches the pull request methods', async () => {
    runs = [
      {
        databaseId: 1,
        workflowName: 'CI',
        displayTitle: 'build',
        status: 'completed',
        conclusion: 'success',
        url: 'u',
        headSha: 'abc',
      },
    ];
    const { deps, hookCalls, listRuns } = build();
    const client = deps.client as unknown as { prSnapshot: ReturnType<typeof vi.fn> };
    client.prSnapshot = vi.fn();
    const spec = prSpec({ prEvents: undefined, triggers: { failure: true, success: true } });
    delete spec.prEvents;
    const event = await checkWatch(spec, deps);
    expect(event.fired).toBe(true);
    expect(event.prEvents).toBeUndefined();
    expect(client.prSnapshot).not.toHaveBeenCalled();
    expect(listRuns).toHaveBeenCalledTimes(1);
    expect(Object.keys(hookCalls[0] ?? {})).toEqual([
      'summary',
      'watch',
      'repo',
      'targetKey',
      'state',
      'failedSteps',
      'runsCount',
      'checkedAt',
    ]);
    expect((await loadState()).watchers[0]?.lastPr).toBeUndefined();
  });
});
