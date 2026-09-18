import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkWatch,
  checkWatchManual,
  loadState,
  runWatches,
  type EngineDeps,
  type LookupResult,
  type RecordType,
  type WatchSpec,
} from '../src/index.js';

let stateRoot: string;
let previousEnv: string | undefined;
let currentValues: string[];
let fixedNow: Date;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dns-checker-engine-'));
  previousEnv = process.env['AI_TOOLS_DNS_STATE_DIR'];
  process.env['AI_TOOLS_DNS_STATE_DIR'] = stateRoot;
  currentValues = ['192.0.2.1'];
  fixedNow = new Date('2026-01-01T00:00:00.000Z');
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousEnv === undefined) {
    delete process.env['AI_TOOLS_DNS_STATE_DIR'];
  } else {
    process.env['AI_TOOLS_DNS_STATE_DIR'] = previousEnv;
  }
  await rm(stateRoot, { recursive: true, force: true });
});

function fakeLookupFn() {
  return vi.fn(async (domain: string, type: RecordType): Promise<LookupResult> => {
    return {
      domain,
      type,
      resolver: 'fake',
      transport: 'udp',
      answers: currentValues.map((value) => ({ value, ttl: 300 })),
      checkedAt: fixedNow.toISOString(),
    };
  });
}

const fakeFireHookFn = vi.fn(async () => ({ ok: true }));

let fakeDeps: EngineDeps;

function buildDeps(): EngineDeps {
  fakeFireHookFn.mockClear();
  return {
    lookupFn: fakeLookupFn(),
    fireHookFn: fakeFireHookFn,
    now: () => fixedNow,
  };
}

function anyChangeSpec(name: string): WatchSpec {
  return {
    name,
    domain: 'example.com',
    type: 'A',
    rule: { kind: 'any-change' },
    intervalSeconds: 60,
    hook: { kind: 'none' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function equalsSpec(values: string[]): WatchSpec {
  return {
    name: 'equality',
    domain: 'example.com',
    type: 'A',
    rule: { kind: 'equals', values },
    intervalSeconds: 60,
    hook: { kind: 'exec', command: 'true' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('checkWatch', () => {
  it('records the baseline and does not fire on the first observation', async () => {
    fakeDeps = buildDeps();
    const event = await checkWatch(anyChangeSpec('w1'), fakeDeps);
    expect(event.matched).toBe(false);
    expect(event.reason).toBe('baseline recorded');
    expect(event.fired).toBe(false);
    expect(event.values).toEqual(['192.0.2.1']);
    expect(fakeFireHookFn).not.toHaveBeenCalled();
    const state = await loadState();
    expect(state.baselines['w1']).toEqual(['192.0.2.1']);
    expect(state.watchers[0]?.lastCheckedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.watchers[0]?.lastMatchAt).toBeUndefined();
  });

  it('fires only on the rising edge', async () => {
    fakeDeps = buildDeps();
    const spec = anyChangeSpec('w1');
    await checkWatch(spec, fakeDeps);
    const second = await checkWatch(spec, fakeDeps);
    expect(second.matched).toBe(false);
    expect(second.reason).toBe('no change');
    currentValues = ['192.0.2.2'];
    const third = await checkWatch(spec, fakeDeps);
    expect(third.matched).toBe(true);
    expect(third.fired).toBe(true);
    expect(fakeFireHookFn).toHaveBeenCalledTimes(1);
    currentValues = ['192.0.2.3'];
    const fourth = await checkWatch(spec, fakeDeps);
    expect(fourth.matched).toBe(true);
    expect(fourth.fired).toBe(false);
    expect(fakeFireHookFn).toHaveBeenCalledTimes(1);
    currentValues = ['192.0.2.3'];
    const fifth = await checkWatch(spec, fakeDeps);
    expect(fifth.matched).toBe(false);
    expect(fifth.fired).toBe(false);
    currentValues = ['192.0.2.4'];
    const sixth = await checkWatch(spec, fakeDeps);
    expect(sixth.matched).toBe(true);
    expect(sixth.fired).toBe(true);
    expect(fakeFireHookFn).toHaveBeenCalledTimes(2);
    const state = await loadState();
    expect(state.baselines['w1']).toEqual(['192.0.2.4']);
    expect(state.watchers[0]?.lastMatchAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('propagates lookup errors onto the event without matching', async () => {
    currentValues = [];
    fakeDeps = buildDeps();
    fakeDeps.lookupFn = async (domain, type) => ({
      domain,
      type,
      resolver: 'fake',
      transport: 'udp',
      answers: [],
      checkedAt: fixedNow.toISOString(),
      error: 'lookup timed out',
    });
    const event = await checkWatch(equalsSpec(['192.0.2.1']), fakeDeps);
    expect(event.matched).toBe(false);
    expect(event.error).toBe('lookup timed out');
    expect(event.fired).toBe(false);
  });
});

describe('checkWatchManual', () => {
  it('fires every time the rule matches', async () => {
    fakeDeps = buildDeps();
    const spec = equalsSpec(['192.0.2.1']);
    const first = await checkWatchManual(spec, fakeDeps);
    expect(first.matched).toBe(true);
    expect(first.fired).toBe(true);
    const second = await checkWatchManual(spec, fakeDeps);
    expect(second.matched).toBe(true);
    expect(second.fired).toBe(true);
    expect(fakeFireHookFn).toHaveBeenCalledTimes(2);
  });

  it('does not fire when the rule does not match', async () => {
    fakeDeps = buildDeps();
    const event = await checkWatchManual(equalsSpec(['198.51.100.1']), fakeDeps);
    expect(event.matched).toBe(false);
    expect(event.fired).toBe(false);
    expect(fakeFireHookFn).not.toHaveBeenCalled();
  });
});

describe('runWatches', () => {
  it('throws for an unknown name', async () => {
    fakeDeps = buildDeps();
    await checkWatch(anyChangeSpec('w1'), fakeDeps);
    await expect(runWatches(['missing'], fakeDeps)).rejects.toThrow(/unknown watch "missing"/);
  });

  it('checks every watcher when names is undefined', async () => {
    fakeDeps = buildDeps();
    await checkWatch(anyChangeSpec('w1'), fakeDeps);
    await checkWatch(anyChangeSpec('w2'), fakeDeps);
    const events = await runWatches(undefined, fakeDeps);
    expect(events.map((event) => event.watch)).toEqual(['w1', 'w2']);
    expect(events.every((event) => event.matched === false)).toBe(true);
  });

  it('checks only the named watchers', async () => {
    fakeDeps = buildDeps();
    await checkWatch(anyChangeSpec('w1'), fakeDeps);
    await checkWatch(anyChangeSpec('w2'), fakeDeps);
    const events = await runWatches(['w2'], fakeDeps);
    expect(events.map((event) => event.watch)).toEqual(['w2']);
  });
});
