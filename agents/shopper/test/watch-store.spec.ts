import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shopperDefaultsSchema } from '../src/core/defaults.js';
import {
  WatchStoreError,
  addWatch,
  editWatch,
  historyFile,
  readWatches,
  recordRun,
  removeWatch,
  slugify,
  uniqueId,
  watchPaths,
  watchSchema,
  watchesFileSchema,
  watchesJsonSchema,
} from '../src/core/watch/store.js';

const NOW = new Date('2026-11-21T00:00:00.000Z');
const LATER = new Date('2026-11-21T06:00:00.000Z');
const defaults = shopperDefaultsSchema.parse({ version: 1 });

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shopper-store-'));
  file = join(dir, 'state', 'watches.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('watch schema', () => {
  it('fills every default from a minimal watch', () => {
    const watch = watchSchema.parse({
      id: 'x',
      query: 'q',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(watch).toMatchObject({
      spec: { include: [], exclude: [] },
      sites: null,
      condition: null,
      maxPrice: null,
      currency: null,
      interval: '6h',
      enabled: true,
      lastRunAt: null,
      lastStatus: null,
    });
    expect(watch.notify.on).toEqual([
      'new',
      'price_drop',
      'back_in_stock',
      'threshold',
      'scanner_failing',
    ]);
  });

  it('rejects bad values', () => {
    const base = {
      id: 'x',
      query: 'q',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    expect(() => watchSchema.parse({ ...base, currency: 'baht' })).toThrow();
    expect(() => watchSchema.parse({ ...base, id: 'Bad Id' })).toThrow();
    expect(() => watchSchema.parse({ ...base, id: 'a'.repeat(41) })).toThrow();
    expect(() => watchSchema.parse({ ...base, interval: '5m' })).toThrow(/15m/);
    expect(() => watchSchema.parse({ ...base, interval: 'soon' })).toThrow();
    expect(() => watchSchema.parse({ ...base, spec: { include: ['('] } })).toThrow(/regular/);
    expect(() => watchSchema.parse({ ...base, condition: ['shiny'] })).toThrow();
    expect(() => watchSchema.parse({ ...base, maxPrice: -1 })).toThrow();
    expect(() => watchSchema.parse({ ...base, extra: 1 })).toThrow();
    expect(() => watchSchema.parse({ ...base, notify: { on: ['loud'] } })).toThrow();
  });

  it('rejects duplicate ids in a file', () => {
    const entry = {
      id: 'x',
      query: 'q',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    expect(() => watchesFileSchema.parse({ version: 1, watches: [entry, entry] })).toThrow(
      /duplicate/,
    );
  });

  it('keeps the committed watches.schema.json current', () => {
    const path = fileURLToPath(new URL('../watches.schema.json', import.meta.url));
    const committed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    expect(committed).toEqual(JSON.parse(JSON.stringify(watchesJsonSchema())));
  });
});

describe('paths', () => {
  it('uses the state dir and honours SHOPPER_WATCHES_FILE', () => {
    const base = watchPaths({ env: { AGENTS_STATE_DIR: '/s' } });
    expect(base.watchesFile).toBe('/s/shopper/watches.json');
    expect(historyFile(base, 'x')).toBe('/s/shopper/history/x.jsonl');
    expect(base.lockFile).toBe('/s/shopper/watch.lock');
    const custom = watchPaths({
      env: { AGENTS_STATE_DIR: '/s', SHOPPER_WATCHES_FILE: '/elsewhere/w.json' },
    });
    expect(custom.watchesFile).toBe('/elsewhere/w.json');
  });

  it('falls back to XDG_STATE_HOME and the injected home', () => {
    expect(watchPaths({ env: { XDG_STATE_HOME: '/x' }, home: '/h' }).stateDir).toBe(
      '/x/ai-tools/agents/shopper',
    );
    expect(watchPaths({ env: {}, home: '/h' }).stateDir).toBe(
      '/h/.local/state/ai-tools/agents/shopper',
    );
  });
});

describe('ids', () => {
  it('slugs a query', () => {
    expect(slugify('DDR5 32GB 6000')).toBe('ddr5-32gb-6000');
    expect(slugify('  Ünï  cödé!! ')).toBe('uni-code');
    expect(slugify('***')).toBe('watch');
    expect(slugify('a'.repeat(60))).toHaveLength(40);
    expect(slugify(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
  });

  it('adds a numeric suffix for a taken id and keeps the length', () => {
    expect(uniqueId('x', new Set())).toBe('x');
    expect(uniqueId('x', new Set(['x']))).toBe('x-2');
    expect(uniqueId('x', new Set(['x', 'x-2']))).toBe('x-3');
    const long = 'a'.repeat(40);
    expect(uniqueId(long, new Set([long]))).toHaveLength(40);
  });
});

describe('store', () => {
  it('reads a missing file as empty and writes atomically', () => {
    expect(readWatches(file)).toEqual({ version: 1, watches: [] });
    addWatch(file, { query: 'DDR5 32GB' }, defaults, NOW);
    expect(readdirSync(join(dir, 'state'))).toEqual(['watches.json']);
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
  });

  it('takes defaults for a new watch from the defaults', () => {
    const custom = shopperDefaultsSchema.parse({
      version: 1,
      watch: { interval: '1d', notifyOn: ['new'], minDropPercent: 5 },
    });
    const watch = addWatch(file, { query: 'GPU' }, custom, NOW);
    expect(watch).toMatchObject({
      id: 'gpu',
      interval: '1d',
      notify: { on: ['new'], minDropPercent: 5 },
      sites: null,
      condition: null,
      currency: null,
      createdAt: NOW.toISOString(),
      lastRunAt: null,
    });
  });

  it('lets flags override the defaults', () => {
    const watch = addWatch(
      file,
      {
        query: 'GPU',
        id: 'my-gpu',
        include: ['rtx'],
        exclude: ['laptop'],
        sites: ['jib'],
        condition: ['used'],
        maxPrice: 5000,
        currency: 'USD',
        interval: '30m',
        on: ['threshold'],
        minDropPercent: 2,
      },
      defaults,
      NOW,
    );
    expect(watch).toMatchObject({
      id: 'my-gpu',
      spec: { include: ['rtx'], exclude: ['laptop'] },
      sites: ['jib'],
      condition: ['used'],
      maxPrice: 5000,
      currency: 'USD',
      interval: '30m',
      notify: { on: ['threshold'], minDropPercent: 2 },
    });
  });

  it('makes unique slugs and rejects a clashing explicit id', () => {
    expect(addWatch(file, { query: 'GPU' }, defaults, NOW).id).toBe('gpu');
    expect(addWatch(file, { query: 'GPU' }, defaults, NOW).id).toBe('gpu-2');
    expect(() => addWatch(file, { query: 'x', id: 'gpu' }, defaults, NOW)).toThrow(/exists/);
    expect(readWatches(file).watches).toHaveLength(2);
  });

  it('rejects invalid input without writing', () => {
    expect(() => addWatch(file, { query: 'x', interval: '1m' }, defaults, NOW)).toThrow(
      WatchStoreError,
    );
    expect(() => addWatch(file, { query: 'x', currency: 'baht' }, defaults, NOW)).toThrow(
      /currency/,
    );
    expect(existsSync(file)).toBe(false);
  });

  it('edits fields, replaces lists, clears with null and bumps updatedAt', () => {
    addWatch(file, { query: 'GPU', include: ['a'], maxPrice: 10, sites: ['jib'] }, defaults, NOW);
    const edited = editWatch(
      file,
      'gpu',
      { include: ['b', 'c'], maxPrice: null, sites: null, enabled: false, interval: '2h' },
      LATER,
    );
    expect(edited).toMatchObject({
      spec: { include: ['b', 'c'], exclude: [] },
      maxPrice: null,
      sites: null,
      enabled: false,
      interval: '2h',
      createdAt: NOW.toISOString(),
      updatedAt: LATER.toISOString(),
    });
    expect(readWatches(file).watches[0]).toEqual(edited);
  });

  it('keeps an unrelated field when it is not in the patch', () => {
    addWatch(file, { query: 'GPU', maxPrice: 10 }, defaults, NOW);
    expect(editWatch(file, 'gpu', { interval: '1d' }, LATER).maxPrice).toBe(10);
  });

  it('refuses a bad edit and an unknown id', () => {
    addWatch(file, { query: 'GPU' }, defaults, NOW);
    expect(() => editWatch(file, 'gpu', { interval: '1m' }, LATER)).toThrow(WatchStoreError);
    expect(readWatches(file).watches[0]?.interval).toBe('6h');
    expect(() => editWatch(file, 'nope', {}, LATER)).toThrow(/no watch/);
    expect(() => removeWatch(file, 'nope')).toThrow(/no watch/);
  });

  it('removes a watch', () => {
    addWatch(file, { query: 'A' }, defaults, NOW);
    addWatch(file, { query: 'B' }, defaults, NOW);
    expect(removeWatch(file, 'a').id).toBe('a');
    expect(readWatches(file).watches.map((entry) => entry.id)).toEqual(['b']);
  });

  it('records a run', () => {
    addWatch(file, { query: 'A' }, defaults, NOW);
    recordRun(file, 'a', LATER, 'changes');
    expect(readWatches(file).watches[0]).toMatchObject({
      lastRunAt: LATER.toISOString(),
      lastStatus: 'changes',
    });
    recordRun(file, 'gone', LATER, 'ok');
  });

  it('reports a corrupt or invalid file with its path', () => {
    addWatch(file, { query: 'A' }, defaults, NOW);
    writeFileSync(file, '{ nope');
    expect(() => readWatches(file)).toThrow(/not valid JSON/);
    writeFileSync(file, JSON.stringify({ version: 1, watches: [{ id: 'A!' }] }));
    expect(() => readWatches(file)).toThrow(/watches\.0\.id/);
  });
});
