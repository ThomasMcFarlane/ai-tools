import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENTS_FILE,
  STATE_FILE,
  appendEvent,
  getWatcher,
  listWatchers,
  loadState,
  readEvents,
  removeWatcher,
  saveState,
  stateDir,
  upsertWatcher,
  type GhEvent,
  type GhWatchSpec,
  type GhWatcherState,
} from '../src/index.js';

let stateRoot: string;
let previousEnv: string | undefined;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'gh-watcher-store-'));
  previousEnv = process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
  process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = stateRoot;
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

function sampleSpec(name: string): GhWatchSpec {
  return {
    name,
    repo: 'octo-org/hello-world',
    target: { kind: 'branch', branch: 'main' },
    triggers: { failure: true, success: true },
    hook: { kind: 'none' },
    intervalSeconds: 60,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function sampleState(): GhWatcherState {
  return {
    watchers: [sampleSpec('example-a')],
    lastFired: { 'example-a': { state: 'failure', runsKey: '1,2' } },
  };
}

function sampleEvent(seq: number): GhEvent {
  return {
    watch: 'example-a',
    repo: 'octo-org/hello-world',
    targetKey: 'branch:main',
    state: 'failure',
    failedSteps: [],
    runsCount: 2,
    checkedAt: `2026-01-01T00:00:0${seq}.000Z`,
    fired: false,
  };
}

describe('stateDir', () => {
  it('honours AI_TOOLS_GH_WATCHER_STATE_DIR', () => {
    expect(stateDir()).toBe(stateRoot);
  });
});

describe('loadState', () => {
  it('returns empty state when the file is missing', async () => {
    expect(await loadState()).toEqual({ watchers: [], lastFired: {} });
  });

  it('roundtrips through saveState', async () => {
    const state = sampleState();
    await saveState(state);
    expect(await loadState()).toEqual(state);
    const raw = await readFile(join(stateRoot, STATE_FILE), 'utf8');
    expect(raw.trim().startsWith('{')).toBe(true);
  });

  it('returns empty state and warns on corrupt JSON', async () => {
    await writeFile(join(stateRoot, STATE_FILE), '{ not valid json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await loadState()).toEqual({ watchers: [], lastFired: {} });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('repairs partial state objects', async () => {
    await writeFile(join(stateRoot, STATE_FILE), JSON.stringify({ watchers: [{ name: 'x' }] }), 'utf8');
    const state = await loadState();
    expect(state.watchers).toEqual([{ name: 'x' }]);
    expect(state.lastFired).toEqual({});
  });
});

describe('watcher helpers', () => {
  it('upserts, gets and lists watchers', async () => {
    expect(await getWatcher('example-a')).toBeUndefined();
    await upsertWatcher(sampleSpec('example-a'));
    expect(await getWatcher('example-a')).toEqual(sampleSpec('example-a'));
    await upsertWatcher(sampleSpec('example-b'));
    expect((await listWatchers()).map((watcher) => watcher.name)).toEqual(['example-a', 'example-b']);
    const updated = { ...sampleSpec('example-a'), intervalSeconds: 120 };
    await upsertWatcher(updated);
    expect(await getWatcher('example-a')).toEqual(updated);
    expect(await listWatchers()).toHaveLength(2);
  });

  it('removes a watcher and reports misses', async () => {
    await upsertWatcher(sampleSpec('example-a'));
    expect(await removeWatcher('example-a')).toBe(true);
    expect(await removeWatcher('example-a')).toBe(false);
    expect(await listWatchers()).toEqual([]);
  });
});

describe('events', () => {
  it('appends JSON lines and reads them newest last', async () => {
    await appendEvent(sampleEvent(0));
    await appendEvent(sampleEvent(1));
    await appendEvent(sampleEvent(2));
    const raw = await readFile(join(stateRoot, EVENTS_FILE), 'utf8');
    expect(raw.split('\n').filter((line) => line.length > 0)).toHaveLength(3);
    const events = await readEvents();
    expect(events.map((event) => event.checkedAt)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
    ]);
  });

  it('returns the last N events for a tail', async () => {
    for (const seq of [0, 1, 2]) {
      await appendEvent(sampleEvent(seq));
    }
    const tail = await readEvents(2);
    expect(tail.map((event) => event.checkedAt)).toEqual([
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
    ]);
  });

  it('returns an empty list when no events exist', async () => {
    expect(await readEvents()).toEqual([]);
  });

  it('skips corrupt lines', async () => {
    await appendEvent(sampleEvent(0));
    await appendFileBroken();
    await appendEvent(sampleEvent(1));
    const events = await readEvents();
    expect(events).toHaveLength(2);
  });
});

async function appendFileBroken(): Promise<void> {
  const { appendFile: append } = await import('node:fs/promises');
  await append(join(stateRoot, EVENTS_FILE), 'not json\n', 'utf8');
}
