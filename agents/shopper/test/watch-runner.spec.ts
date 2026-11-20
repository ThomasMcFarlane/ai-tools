import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readHistory } from '../src/core/watch/history.js';
import {
  LOCK_STALE_MS,
  acquireLock,
  isDue,
  matchesSpec,
  nextRunAt,
  runDue,
  runOne,
  runWatch,
} from '../src/core/watch/runner.js';
import { addWatch, historyFile, readWatches, type Watch } from '../src/core/watch/store.js';
import {
  START,
  advance,
  fakeAdapter,
  fakeHit,
  harness,
  setPage,
  type Harness,
} from './helpers/watch.js';

let h: Harness | null = null;

afterEach(() => {
  h?.cleanup();
  h = null;
});

function setup(
  sites = ['a'],
  overrides: Parameters<typeof harness>[1] = {},
  adapters?: ReturnType<typeof fakeAdapter>[],
): Harness {
  h = harness(sites, overrides, adapters);
  return h;
}

function add(env: Harness, input: Parameters<typeof addWatch>[1]): Watch {
  return addWatch(env.deps.paths.watchesFile, input, env.deps.defaults, env.deps.now());
}

describe('spec filters', () => {
  it('needs every include and no exclude', () => {
    const spec = { include: ['ddr5', '32 ?gb'], exclude: ['laptop'] };
    expect(matchesSpec('Kingston DDR5 32GB', spec)).toBe(true);
    expect(matchesSpec('Kingston DDR5 32 gb', spec)).toBe(true);
    expect(matchesSpec('Kingston DDR5 16GB', spec)).toBe(false);
    expect(matchesSpec('DDR5 32GB LAPTOP kit', spec)).toBe(false);
    expect(matchesSpec('anything', { include: [], exclude: [] })).toBe(true);
  });
});

describe('due logic', () => {
  const base = { interval: '6h', enabled: true, lastRunAt: null } as Watch;

  it('is due when never run, and when lastRunAt plus interval has passed', () => {
    expect(isDue(base, START)).toBe(true);
    const ran = { ...base, lastRunAt: START.toISOString() };
    expect(isDue(ran, new Date(START.getTime() + 6 * 3_600_000 - 1))).toBe(false);
    expect(isDue(ran, new Date(START.getTime() + 6 * 3_600_000))).toBe(true);
    expect(nextRunAt(ran, START)).toBe('2026-11-21T06:00:00.000Z');
  });

  it('is never due when disabled', () => {
    expect(isDue({ ...base, enabled: false }, START)).toBe(false);
    expect(nextRunAt({ ...base, enabled: false }, START)).toBeNull();
  });
});

describe('runWatch', () => {
  it('records a baseline run and then reports only changes', async () => {
    const env = setup();
    setPage(env.world, 'a', [fakeHit('a', 'RAM one', 3000), fakeHit('a', 'RAM two', 4000)]);
    const watch = add(env, { query: 'ram' });
    const first = await runWatch(watch, env.deps, { notify: true });
    expect(first).toMatchObject({ status: 'baseline', baseline: true, events: [] });
    expect(first.hits).toHaveLength(2);
    expect(env.sent).toEqual([]);

    advance(env.world, 6);
    setPage(env.world, 'a', [
      fakeHit('a', 'RAM one', 2500),
      fakeHit('a', 'RAM two', 4000),
      fakeHit('a', 'RAM three', 100),
    ]);
    const second = await runWatch(
      readWatches(env.deps.paths.watchesFile).watches[0] as Watch,
      env.deps,
      {
        notify: true,
      },
    );
    expect(second.status).toBe('changes');
    expect(second.events.map((event) => `${event.type}:${event.title}`)).toEqual([
      'new:RAM three',
      'price_drop:RAM one',
    ]);
    expect(second.message?.split('\n')[0]).toBe('shopper: ram: 1 new, 1 price drop');
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]?.env).toMatchObject({
      SHOPPER_WATCH_ID: 'ram',
      SHOPPER_NOTIFY_STATE: 'fail',
    });
    expect(env.sent[0]?.input).toBe(`${second.message}\n`);

    advance(env.world, 6);
    const third = await runWatch(watch, env.deps, { notify: true });
    expect(third).toMatchObject({ status: 'ok', events: [], message: null });
    expect(env.sent).toHaveLength(1);

    const lines = readHistory(historyFile(env.deps.paths, 'ram'));
    expect(lines).toHaveLength(3);
    expect(lines[1]?.events).toHaveLength(2);
    expect(lines[0]?.hits[0]).not.toHaveProperty('raw');
    expect(readWatches(env.deps.paths.watchesFile).watches[0]).toMatchObject({
      lastRunAt: '2026-11-21T12:00:00.000Z',
      lastStatus: 'ok',
    });
  });

  it('asks for the whole result list, out of stock included, and never applies the global max', async () => {
    const env = setup(['a'], { defaults: { budget: { max: 10 } } });
    setPage(env.world, 'a', [
      fakeHit('a', 'Dear', 9000),
      fakeHit('a', 'Gone', 50, { stock: 'out_of_stock' }),
    ]);
    const result = await runWatch(add(env, { query: 'ram' }), env.deps, { notify: false });
    expect(result.hits.map((hit) => hit.title).sort()).toEqual(['Dear', 'Gone']);
  });

  it('applies spec regexes and the condition', async () => {
    const env = setup();
    setPage(env.world, 'a', [
      fakeHit('a', 'DDR5 32GB kit', 100),
      fakeHit('a', 'DDR4 32GB kit', 100),
      fakeHit('a', 'DDR5 32GB laptop', 100),
      fakeHit('a', 'DDR5 32GB used', 100, { condition: 'used' }),
    ]);
    const result = await runWatch(
      add(env, { query: 'ram', include: ['ddr5'], exclude: ['laptop'] }),
      env.deps,
      { notify: false },
    );
    expect(result.hits.map((hit) => hit.title)).toEqual(['DDR5 32GB kit']);
    const used = await runWatch(
      add(env, { query: 'ram used', include: ['ddr5'], condition: ['used'] }),
      env.deps,
      { notify: false },
    );
    expect(used.hits.map((hit) => hit.title)).toEqual(['DDR5 32GB used']);
  });

  it('reports threshold crossings once, and keeps hits above maxPrice', async () => {
    const env = setup();
    const watch = add(env, { query: 'ram', maxPrice: 3500, on: ['threshold'] });
    setPage(env.world, 'a', [fakeHit('a', 'RAM', 4000)]);
    expect((await runWatch(watch, env.deps, { notify: false })).events).toEqual([]);
    advance(env.world, 6);
    setPage(env.world, 'a', [fakeHit('a', 'RAM', 3400)]);
    expect((await runWatch(watch, env.deps, { notify: false })).events.map((e) => e.type)).toEqual([
      'threshold',
    ]);
    advance(env.world, 6);
    expect((await runWatch(watch, env.deps, { notify: false })).events).toEqual([]);
  });

  it('uses the watch currency and sites', async () => {
    const env = setup(['a', 'b']);
    setPage(env.world, 'a', [fakeHit('a', 'RAM', 1)]);
    setPage(env.world, 'b', [fakeHit('b', 'RAM', 1)]);
    const result = await runWatch(add(env, { query: 'ram', sites: ['b'] }), env.deps, {
      notify: false,
    });
    expect(Object.keys(result.sites)).toEqual(['b']);
    expect(env.world.requests.every((url) => url.includes('b.example.com'))).toBe(true);
  });

  it('lists user-browser sites as skipped and never fetches them', async () => {
    const env = setup(['a', 'u'], {}, [fakeAdapter('a'), fakeAdapter('u', 'user-browser')]);
    setPage(env.world, 'a', [fakeHit('a', 'RAM', 1)]);
    const result = await runWatch(add(env, { query: 'ram' }), env.deps, { notify: false });
    expect(result.skipped.map((item) => item.site)).toEqual(['u']);
    expect(Object.keys(result.sites)).toEqual(['a']);
    expect(env.world.requests.some((url) => url.includes('u.example.com'))).toBe(false);
  });

  it('fails a watch whose sites are all user-browser', async () => {
    const env = setup(['u'], {}, [fakeAdapter('u', 'user-browser')]);
    const result = await runWatch(add(env, { query: 'ram' }), env.deps, { notify: false });
    expect(result.status).toBe('error');
    expect(result.errors[0]?.message).toContain('no site can run');
  });

  it('keeps old hits through a failing site: no false new after recovery, one scanner alert', async () => {
    const env = setup(['a', 'b']);
    const watch = add(env, { query: 'ram' });
    setPage(env.world, 'a', [fakeHit('a', 'A1', 10)]);
    setPage(env.world, 'b', [fakeHit('b', 'B1', 10)]);
    await runWatch(watch, env.deps, { notify: true });

    setPage(env.world, 'b', new Error('boom'));
    const kinds: string[][] = [];
    for (let n = 0; n < 4; n += 1) {
      advance(env.world, 6);
      const result = await runWatch(watch, env.deps, { notify: true });
      expect(result.status).toBe(result.events.length > 0 ? 'changes' : 'ok');
      expect(result.sites.b?.status).toBe('error');
      kinds.push(result.events.map((event) => event.type));
    }
    expect(kinds).toEqual([[], [], ['scanner_failing'], []]);
    expect(env.sent).toHaveLength(1);

    advance(env.world, 6);
    setPage(env.world, 'b', [fakeHit('b', 'B1', 10)]);
    const recovered = await runWatch(watch, env.deps, { notify: true });
    expect(recovered.events.map((event) => `${event.type}:${event.recovered}`)).toEqual([
      'scanner_failing:true',
    ]);
    expect(recovered.message).toContain('scanner recovered');
  });

  it('marks a run as error when every site fails and records blocks', async () => {
    const env = setup();
    setPage(env.world, 'a', '<html>CAPTCHA</html>');
    const result = await runWatch(add(env, { query: 'ram' }), env.deps, { notify: true });
    expect(result.status).toBe('error');
    expect(result.sites.a?.status).toBe('blocked');
    expect(env.sent).toEqual([]);
  });

  it('prints to stdout when no command is set, and stays quiet without events', async () => {
    const env = setup(['a'], { notifyCommand: null });
    const watch = add(env, { query: 'ram' });
    setPage(env.world, 'a', [fakeHit('a', 'A1', 10)]);
    await runWatch(watch, env.deps, { notify: true });
    expect(env.printed).toEqual([]);
    advance(env.world, 6);
    setPage(env.world, 'a', [fakeHit('a', 'A1', 10), fakeHit('a', 'A2', 10)]);
    const result = await runWatch(watch, env.deps, { notify: true });
    expect(result.notify?.method).toBe('stdout');
    expect(env.printed).toEqual([result.message]);
  });

  it('sends a no-change message when quietUnchanged is off', async () => {
    const env = setup(['a'], { defaults: { watch: { quietUnchanged: false } } });
    const watch = add(env, { query: 'ram' });
    setPage(env.world, 'a', [fakeHit('a', 'A1', 10)]);
    const result = await runWatch(watch, env.deps, { notify: true });
    expect(result.message?.split('\n')[0]).toBe('shopper: ram: no changes');
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]?.env.SHOPPER_NOTIFY_STATE).toBe('ok');
  });

  it('does not notify without the notify option, and reports a failed command', async () => {
    const env = setup(['a'], { spawn: async () => ({ code: 1, stderr: 'down' }) });
    const watch = add(env, { query: 'ram' });
    setPage(env.world, 'a', []);
    await runWatch(watch, env.deps, { notify: true });
    advance(env.world, 6);
    setPage(env.world, 'a', [fakeHit('a', 'A1', 10)]);
    const failed = await runWatch(watch, env.deps, { notify: true });
    expect(failed.notify).toMatchObject({ ok: false, error: 'down' });
    expect(readHistory(historyFile(env.deps.paths, 'ram'))).toHaveLength(2);
    advance(env.world, 6);
    setPage(env.world, 'a', [fakeHit('a', 'A1', 10), fakeHit('a', 'A2', 10)]);
    expect((await runWatch(watch, env.deps, { notify: false })).notify).toBeNull();
  });

  it('never calls a model: the run only touches the fetcher', async () => {
    const env = setup();
    setPage(env.world, 'a', [fakeHit('a', 'A1', 10)]);
    await runWatch(add(env, { query: 'ram' }), env.deps, { notify: false });
    expect(env.world.requests).toHaveLength(1);
  });
});

describe('undelivered alerts', () => {
  function flaky() {
    const state = { fail: true, calls: [] as string[] };
    const spawn = async (request: { input: string }) => {
      state.calls.push(request.input);
      return state.fail ? { code: 1, stderr: 'down' } : { code: 0, stderr: '' };
    };
    return { state, spawn };
  }

  it('marks a failed alert, re-sends it with the new events, and stops once delivered', async () => {
    const { state, spawn } = flaky();
    const env = setup(['a'], { spawn });
    const watch = add(env, { query: 'ram' });
    setPage(env.world, 'a', []);
    await runWatch(watch, env.deps, { notify: true });

    advance(env.world, 6);
    setPage(env.world, 'a', [fakeHit('a', 'RAM one', 100)]);
    const failed = await runWatch(watch, env.deps, { notify: true });
    expect(failed.notify?.ok).toBe(false);
    let lines = readHistory(historyFile(env.deps.paths, 'ram'));
    expect(lines.map((line) => line.notified)).toEqual([true, false]);
    expect(lines[1]?.events.map((event) => event.title)).toEqual(['RAM one']);

    advance(env.world, 6);
    setPage(env.world, 'a', [fakeHit('a', 'RAM one', 100), fakeHit('a', 'RAM two', 100)]);
    state.fail = false;
    const second = await runWatch(watch, env.deps, { notify: true });
    expect(second.events.map((event) => event.title)).toEqual(['RAM two']);
    expect(second.pendingEvents.map((event) => event.title)).toEqual(['RAM one']);
    expect(second.message?.split('\n')[0]).toBe('shopper: ram: 2 new');
    expect(second.message).toContain('RAM one');
    expect(second.message).toContain('RAM two');
    lines = readHistory(historyFile(env.deps.paths, 'ram'));
    expect(lines.map((line) => line.notified)).toEqual([true, false, true]);

    advance(env.world, 6);
    setPage(env.world, 'a', [
      fakeHit('a', 'RAM one', 100),
      fakeHit('a', 'RAM two', 100),
      fakeHit('a', 'RAM three', 100),
    ]);
    const third = await runWatch(watch, env.deps, { notify: true });
    expect(third.pendingEvents).toEqual([]);
    expect(third.message).not.toContain('RAM one');
    expect(third.message).not.toContain('RAM two');
    expect(third.message).toContain('RAM three');
    expect(state.calls).toHaveLength(3);

    advance(env.world, 6);
    const fourth = await runWatch(watch, env.deps, { notify: true });
    expect(fourth.message).toBeNull();
    expect(state.calls).toHaveLength(3);
  });

  it('sends pending events even when nothing changed and quietUnchanged is on', async () => {
    const { state, spawn } = flaky();
    const env = setup(['a'], { spawn });
    const watch = add(env, { query: 'ram' });
    setPage(env.world, 'a', []);
    await runWatch(watch, env.deps, { notify: true });
    advance(env.world, 6);
    setPage(env.world, 'a', [fakeHit('a', 'RAM one', 100)]);
    await runWatch(watch, env.deps, { notify: true });
    advance(env.world, 6);
    state.fail = false;
    const quiet = await runWatch(watch, env.deps, { notify: true });
    expect(quiet.events).toEqual([]);
    expect(quiet.status).toBe('ok');
    expect(quiet.message?.split('\n')[0]).toBe('shopper: ram: 1 new');
    expect(state.calls).toHaveLength(2);
    expect(readHistory(historyFile(env.deps.paths, 'ram')).at(-1)?.notified).toBe(true);
  });

  it('keeps every pending event through repeated failures and de-duplicates by type and key', async () => {
    const { state, spawn } = flaky();
    const env = setup(['a'], { spawn });
    const watch = add(env, { query: 'ram' });
    setPage(env.world, 'a', [fakeHit('a', 'RAM one', 300)]);
    await runWatch(watch, env.deps, { notify: true });
    advance(env.world, 6);
    setPage(env.world, 'a', [fakeHit('a', 'RAM one', 200)]);
    await runWatch(watch, env.deps, { notify: true });
    advance(env.world, 6);
    setPage(env.world, 'a', [fakeHit('a', 'RAM one', 100), fakeHit('a', 'RAM two', 100)]);
    const again = await runWatch(watch, env.deps, { notify: true });
    expect(again.notify?.ok).toBe(false);
    expect(readHistory(historyFile(env.deps.paths, 'ram')).map((line) => line.notified)).toEqual([
      true,
      false,
      false,
    ]);
    advance(env.world, 6);
    state.fail = false;
    const sent = await runWatch(watch, env.deps, { notify: true });
    const lines = sent.message?.split('\n') ?? [];
    expect(lines[0]).toBe('shopper: ram: 1 new, 1 price drop');
    expect(lines.filter((text) => text.startsWith('price drop'))).toHaveLength(1);
    expect(lines.find((text) => text.startsWith('price drop'))).toContain('฿100 | was ฿200');
  });

  it('does not clear pending alerts on a run without --notify', async () => {
    const { state, spawn } = flaky();
    const env = setup(['a'], { spawn });
    const watch = add(env, { query: 'ram' });
    setPage(env.world, 'a', []);
    await runWatch(watch, env.deps, { notify: true });
    advance(env.world, 6);
    setPage(env.world, 'a', [fakeHit('a', 'RAM one', 100)]);
    await runWatch(watch, env.deps, { notify: true });
    advance(env.world, 6);
    await runWatch(watch, env.deps, { notify: false });
    expect(readHistory(historyFile(env.deps.paths, 'ram')).at(-1)?.notified).toBe(false);
    advance(env.world, 6);
    state.fail = false;
    const sent = await runWatch(watch, env.deps, { notify: true });
    expect(sent.message).toContain('RAM one');
  });
});

describe('lock', () => {
  it('blocks a second holder and releases cleanly', () => {
    const env = setup();
    const file = env.deps.paths.lockFile;
    const first = acquireLock(file, START);
    expect(first).not.toBeNull();
    expect(acquireLock(file, new Date(START.getTime() + 60_000))).toBeNull();
    first?.release();
    expect(existsSync(file)).toBe(false);
    expect(acquireLock(file, START)).not.toBeNull();
  });

  it('takes over a lock older than two hours', () => {
    const env = setup();
    const file = env.deps.paths.lockFile;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: 1, startedAt: START.toISOString(), token: 'old' }));
    const fresh = new Date(START.getTime() + LOCK_STALE_MS);
    expect(acquireLock(file, fresh)).toBeNull();
    const taken = acquireLock(file, new Date(fresh.getTime() + 1));
    expect(taken).not.toBeNull();
    taken?.release();
    expect(existsSync(file)).toBe(false);
  });

  it('judges an unreadable lock by its file time', () => {
    const env = setup();
    const file = env.deps.paths.lockFile;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'garbage');
    utimesSync(file, START, START);
    expect(acquireLock(file, new Date(START.getTime() + 60_000))).toBeNull();
    expect(acquireLock(file, new Date(START.getTime() + LOCK_STALE_MS + 60_000))).not.toBeNull();
  });

  it('does not remove a lock that another run took over', () => {
    const env = setup();
    const file = env.deps.paths.lockFile;
    const old = acquireLock(file, START);
    const taken = acquireLock(file, new Date(START.getTime() + LOCK_STALE_MS + 1));
    old?.release();
    expect(existsSync(file)).toBe(true);
    taken?.release();
    expect(existsSync(file)).toBe(false);
  });
});

describe('runDue', () => {
  it('runs due enabled watches one at a time and skips the rest', async () => {
    const env = setup(['a']);
    setPage(env.world, 'a', [fakeHit('a', 'A1', 10)]);
    add(env, { query: 'one' });
    add(env, { query: 'two', interval: '1d' });
    add(env, { query: 'off' });
    const data = readWatches(env.deps.paths.watchesFile);
    data.watches[2]!.enabled = false;
    const { writeWatches } = await import('../src/core/watch/store.js');
    writeWatches(env.deps.paths.watchesFile, data);

    const first = await runDue(env.deps, { notify: true });
    expect(first.due).toEqual(['one', 'two']);
    expect(first.results.map((result) => result.watchId)).toEqual(['one', 'two']);
    expect(existsSync(env.deps.paths.lockFile)).toBe(false);

    advance(env.world, 7);
    const second = await runDue(env.deps, { notify: true });
    expect(second.due).toEqual(['one']);
    advance(env.world, 24);
    expect((await runDue(env.deps, { notify: true })).due).toEqual(['one', 'two']);
  });

  it('does nothing while another run holds the lock', async () => {
    const env = setup();
    add(env, { query: 'one' });
    const held = acquireLock(env.deps.paths.lockFile, env.deps.now());
    const result = await runDue(env.deps, { notify: true });
    expect(result).toMatchObject({ locked: true, results: [] });
    expect(env.world.requests).toEqual([]);
    held?.release();
    expect(
      await runOne(readWatches(env.deps.paths.watchesFile).watches[0] as Watch, env.deps, {
        notify: false,
      }),
    ).not.toBeNull();
  });

  it('refuses runOne while the lock is held', async () => {
    const env = setup();
    const watch = add(env, { query: 'one' });
    const held = acquireLock(env.deps.paths.lockFile, env.deps.now());
    expect(await runOne(watch, env.deps, { notify: false })).toBeNull();
    held?.release();
  });

  it('keeps going when one watch throws and records it as an error', async () => {
    const env = setup();
    add(env, { query: 'one' });
    add(env, { query: 'two' });
    let calls = 0;
    env.deps.search = async (opts, deps) => {
      calls += 1;
      if (calls === 1) throw new Error('search exploded');
      const { runSearch } = await import('../src/core/run.js');
      return runSearch(opts, deps);
    };
    setPage(env.world, 'a', [fakeHit('a', 'A1', 10)]);
    const result = await runDue(env.deps, { notify: false });
    expect(result.failures).toEqual([{ watchId: 'one', message: 'search exploded' }]);
    expect(result.results.map((entry) => entry.watchId)).toEqual(['two']);
    const stored = readWatches(env.deps.paths.watchesFile).watches;
    expect(stored[0]?.lastStatus).toBe('error');
    expect(existsSync(env.deps.paths.lockFile)).toBe(false);
  });
});
