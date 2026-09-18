import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENTS_FILE,
  STATE_FILE,
  appendEvent,
  loadState,
  readEvents,
  saveState,
  stateDir,
  type WatchEvent,
  type WatcherState,
} from '../src/index.js';

let stateRoot: string;
let previousEnv: string | undefined;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dns-checker-store-'));
  previousEnv = process.env['AI_TOOLS_DNS_STATE_DIR'];
  process.env['AI_TOOLS_DNS_STATE_DIR'] = stateRoot;
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

function sampleState(): WatcherState {
  return {
    watchers: [
      {
        name: 'example-a',
        domain: 'example.com',
        type: 'A',
        rule: { kind: 'any-change' },
        intervalSeconds: 60,
        hook: { kind: 'none' },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    baselines: { 'example-a': ['192.0.2.1'] },
    matched: { 'example-a': false },
  };
}

function sampleEvent(seq: number): WatchEvent {
  return {
    watch: 'example-a',
    domain: 'example.com',
    type: 'A',
    matched: false,
    reason: `no change ${seq}`,
    values: ['192.0.2.1'],
    checkedAt: `2026-01-01T00:00:0${seq}.000Z`,
    fired: false,
  };
}

describe('stateDir', () => {
  it('honours AI_TOOLS_DNS_STATE_DIR', () => {
    expect(stateDir()).toBe(stateRoot);
  });
});

describe('loadState', () => {
  it('returns empty state when the file is missing', async () => {
    expect(await loadState()).toEqual({ watchers: [], baselines: {}, matched: {} });
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
    expect(await loadState()).toEqual({ watchers: [], baselines: {}, matched: {} });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('repairs partial state objects', async () => {
    await writeFile(join(stateRoot, STATE_FILE), JSON.stringify({ watchers: [{ name: 'x' }] }), 'utf8');
    const state = await loadState();
    expect(state.watchers).toEqual([{ name: 'x' }]);
    expect(state.baselines).toEqual({});
    expect(state.matched).toEqual({});
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
    expect(events.map((event) => event.reason)).toEqual([
      'no change 0',
      'no change 1',
      'no change 2',
    ]);
  });

  it('returns the last N events for a tail', async () => {
    for (const seq of [0, 1, 2]) {
      await appendEvent(sampleEvent(seq));
    }
    const tail = await readEvents(2);
    expect(tail.map((event) => event.reason)).toEqual(['no change 1', 'no change 2']);
  });

  it('returns an empty list when no events exist', async () => {
    expect(await readEvents()).toEqual([]);
  });

  it('skips corrupt lines', async () => {
    await appendEvent(sampleEvent(0));
    await appendFileBroken();
    await appendEvent(sampleEvent(1));
    const events = await readEvents();
    expect(events.map((event) => event.reason)).toEqual(['no change 0', 'no change 1']);
  });
});

async function appendFileBroken(): Promise<void> {
  const { appendFile: append } = await import('node:fs/promises');
  await append(join(stateRoot, EVENTS_FILE), 'not json\n', 'utf8');
}
