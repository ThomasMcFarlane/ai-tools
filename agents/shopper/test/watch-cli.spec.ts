import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/index.js';
import type { Deps } from '../src/cli/context.js';
import type { SpawnRequest } from '../src/core/watch/notify.js';
import { fakeAdapter, fakeFetcher, fakeHit, setPage, START, type World } from './helpers/watch.js';

let dir: string;
let out: string[];
let err: string[];
let sent: SpawnRequest[];
let world: World;
let spawnCode: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shopper-watch-cli-'));
  out = [];
  err = [];
  sent = [];
  spawnCode = 0;
  world = { pages: {}, requests: [], clock: { now: START } };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function exec(args: string[], env: NodeJS.ProcessEnv = {}) {
  const deps: Partial<Deps> = {
    print: (text) => out.push(text),
    printErr: (text) => err.push(text),
    readStdin: async () => '',
    env: { AGENTS_MEMORY_DIR: join(dir, 'mem'), AGENTS_STATE_DIR: join(dir, 'state'), ...env },
    home: dir,
    now: () => world.clock.now,
    makeFetcher: () => fakeFetcher(world),
    adapters: [fakeAdapter('a'), fakeAdapter('b'), fakeAdapter('u', 'user-browser')],
    spawn: async (request) => {
      sent.push(request);
      return { code: spawnCode, stderr: spawnCode === 0 ? '' : 'alert failed' };
    },
    exec: { execPath: '/usr/bin/node', scriptPath: '/opt/shopper/dist/cli.js', packaged: false },
  };
  return run(['node', 'shopper', ...args], deps);
}

async function json(args: string[], env?: NodeJS.ProcessEnv) {
  out.length = 0;
  const code = await exec([...args, '--json'], env);
  return { code, value: JSON.parse(out.join('\n')) };
}

describe('watch add, list, show, edit, remove', () => {
  it('adds a watch with defaults and prints it as JSON', async () => {
    const { code, value } = await json(['watch', 'add', 'DDR5', '32GB', '6000']);
    expect(code).toBe(0);
    expect(value).toMatchObject({
      id: 'ddr5-32gb-6000',
      query: 'DDR5 32GB 6000',
      sites: null,
      condition: null,
      maxPrice: null,
      currency: null,
      interval: '6h',
      enabled: true,
      lastRunAt: null,
      spec: { include: [], exclude: [] },
      notify: { minDropPercent: 0 },
    });
    expect(value.notify.on).toContain('price_drop');
  });

  it('adds a watch with every flag', async () => {
    const { code, value } = await json([
      'watch',
      'add',
      'gpu',
      '--id',
      'my-gpu',
      '--include',
      'rtx',
      '--include',
      '40(7|8)0',
      '--exclude',
      'laptop',
      '--sites',
      'a,b',
      '--condition',
      'new,used',
      '--max-price',
      '25000',
      '--currency',
      'thb',
      '--interval',
      '30m',
      '--on',
      'new,threshold',
      '--min-drop',
      '5',
    ]);
    expect(code).toBe(0);
    expect(value).toMatchObject({
      id: 'my-gpu',
      spec: { include: ['rtx', '40(7|8)0'], exclude: ['laptop'] },
      sites: ['a', 'b'],
      condition: ['new', 'used'],
      maxPrice: 25000,
      currency: 'THB',
      interval: '30m',
      notify: { on: ['new', 'threshold'], minDropPercent: 5 },
    });
  });

  it('takes the interval and events from the defaults file', async () => {
    const memory = join(dir, 'mem', 'shopper');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(memory, { recursive: true });
    writeFileSync(
      join(memory, 'defaults.json'),
      JSON.stringify({ version: 1, watch: { interval: '12h', notifyOn: ['new'] } }),
    );
    const { value } = await json(['watch', 'add', 'x']);
    expect(value).toMatchObject({ interval: '12h', notify: { on: ['new'] } });
  });

  it('prints a short line without --json', async () => {
    expect(await exec(['watch', 'add', 'GPU'])).toBe(0);
    expect(out).toEqual(["added gpu: 'GPU' every 6h"]);
  });

  it('exits 2 for bad flags and clashing ids', async () => {
    expect(await exec(['watch', 'add', 'x', '--interval', '5m'])).toBe(2);
    expect(err.join('\n')).toContain('15m');
    expect(await exec(['watch', 'add', 'x', '--sites', 'nope'])).toBe(2);
    expect(await exec(['watch', 'add', 'x', '--include', '('])).toBe(2);
    expect(await exec(['watch', 'add', 'x', '--on', 'loud'])).toBe(2);
    expect(await exec(['watch', 'add', 'x', '--max-price', '-4'])).toBe(2);
    expect(await exec(['watch', 'add', 'x', '--min-drop', '101'])).toBe(2);
    expect(await exec(['watch', 'add', 'x', '--condition', 'shiny'])).toBe(2);
    expect(await exec(['watch', 'add', 'x', '--currency', 'baht'])).toBe(2);
    expect(await exec(['watch', 'add'])).toBe(2);
    expect(await exec(['watch', 'add', 'x', '--id', 'same'])).toBe(0);
    expect(await exec(['watch', 'add', 'y', '--id', 'same'])).toBe(2);
    expect(err.join('\n')).toContain('already exists');
  });

  it('lists watches as a table and as JSON', async () => {
    expect(await exec(['watch', 'list'])).toBe(0);
    expect(out).toEqual(['no watches']);
    await exec(['watch', 'add', 'one']);
    await exec(['watch', 'add', 'two', '--max-price', '100']);
    out.length = 0;
    expect(await exec(['watch', 'list'])).toBe(0);
    expect(out[0]).toContain('id');
    expect(out[0]).toContain('one');
    expect(out[0]).toContain('two');
    const { value } = await json(['watch', 'list']);
    expect(value.map((entry: { id: string }) => entry.id)).toEqual(['one', 'two']);
  });

  it('shows one watch and exits 2 for an unknown id', async () => {
    await exec(['watch', 'add', 'one']);
    const { value } = await json(['watch', 'show', 'one']);
    expect(value).toMatchObject({ id: 'one', nextRunAt: START.toISOString() });
    out.length = 0;
    expect(await exec(['watch', 'show', 'one'])).toBe(0);
    expect(out).toContain('id: one');
    expect(out).toContain('interval: 6h');
    expect(await exec(['watch', 'show', 'nope'])).toBe(2);
    expect(err.join('\n')).toContain("no watch with id 'nope'");
  });

  it('edits fields, replaces lists and clears values', async () => {
    await exec(['watch', 'add', 'one', '--include', 'a', '--max-price', '50', '--sites', 'a']);
    const edited = await json([
      'watch',
      'edit',
      'one',
      '--include',
      'b',
      '--include',
      'c',
      '--max-price',
      'none',
      '--sites',
      'all',
      '--interval',
      '2h',
      '--disable',
    ]);
    expect(edited.code).toBe(0);
    expect(edited.value).toMatchObject({
      spec: { include: ['b', 'c'] },
      maxPrice: null,
      sites: null,
      interval: '2h',
      enabled: false,
    });
    const enabled = await json(['watch', 'edit', 'one', '--enable']);
    expect(enabled.value.enabled).toBe(true);
    out.length = 0;
    expect(await exec(['watch', 'edit', 'one', '--currency', 'usd'])).toBe(0);
    expect(out).toEqual(['updated one']);
    expect(await exec(['watch', 'edit', 'one', '--enable', '--disable'])).toBe(2);
    expect(await exec(['watch', 'edit', 'nope', '--enable'])).toBe(2);
    expect(await exec(['watch', 'edit', 'one', '--interval', '1m'])).toBe(2);
  });

  it('rotates the history when an edit changes what the watch looks for', async () => {
    setPage(world, 'a', [fakeHit('a', 'RAM one', 100)]);
    await exec(['watch', 'add', 'ram', '--sites', 'a']);
    await exec(['watch', 'run', 'ram']);
    const history = join(dir, 'state', 'shopper', 'history');
    expect(readdirSync(history)).toEqual(['ram.jsonl']);

    out.length = 0;
    expect(await exec(['watch', 'edit', 'ram', '--interval', '1d', '--max-price', '50'])).toBe(0);
    expect(out).toEqual(['updated ram']);
    expect(readdirSync(history)).toEqual(['ram.jsonl']);

    for (const change of [
      ['--include', 'one'],
      ['--exclude', 'pro'],
      ['--sites', 'a,b'],
      ['--condition', 'used'],
      ['--currency', 'USD'],
    ]) {
      await exec(['watch', 'run', 'ram']);
      out.length = 0;
      expect(await exec(['watch', 'edit', 'ram', ...change])).toBe(0);
      expect(out[0]).toContain('history rotated');
      expect(readdirSync(history).filter((name) => name.endsWith('.jsonl.old'))).not.toHaveLength(
        0,
      );
      expect(existsSync(join(history, 'ram.jsonl'))).toBe(false);
      world.clock.now = new Date(world.clock.now.getTime() + 1000);
    }
    expect(readdirSync(history).filter((name) => name.endsWith('.jsonl.old'))).toHaveLength(5);
    const run = await json(['watch', 'run', 'ram']);
    expect(run.value).toMatchObject({ baseline: true, status: 'baseline' });
  });

  it('deletes the history on remove unless --keep-history is given', async () => {
    setPage(world, 'a', [fakeHit('a', 'RAM one', 100)]);
    await exec(['watch', 'add', 'one', '--sites', 'a']);
    await exec(['watch', 'add', 'two', '--sites', 'a']);
    await exec(['watch', 'run', 'one']);
    await exec(['watch', 'run', 'two']);
    const history = join(dir, 'state', 'shopper', 'history');
    expect(readdirSync(history).sort()).toEqual(['one.jsonl', 'two.jsonl']);
    expect(await exec(['watch', 'remove', 'one'])).toBe(0);
    expect(readdirSync(history)).toEqual(['two.jsonl']);
    expect(await exec(['watch', 'remove', 'two', '--keep-history'])).toBe(0);
    expect(readdirSync(history)).toEqual(['two.jsonl']);
    expect(await exec(['watch', 'add', 'two', '--id', 'two', '--sites', 'a'])).toBe(0);
  });

  it('removes a watch', async () => {
    await exec(['watch', 'add', 'one']);
    out.length = 0;
    expect(await exec(['watch', 'remove', 'one'])).toBe(0);
    expect(out).toEqual(['removed one']);
    expect(await exec(['watch', 'remove', 'one'])).toBe(2);
    const { value } = await json(['watch', 'list']);
    expect(value).toEqual([]);
  });
});

describe('watch run, run-due and history', () => {
  it('runs a watch, records a baseline and then reports the changes', async () => {
    setPage(world, 'a', [fakeHit('a', 'RAM one', 3000)]);
    await exec(['watch', 'add', 'ram', '--sites', 'a,u', '--max-price', '3000']);
    const first = await json(['watch', 'run', 'ram']);
    expect(first.code).toBe(0);
    expect(first.value).toMatchObject({ watchId: 'ram', status: 'baseline', baseline: true });
    expect(first.value.events.map((event: { type: string }) => event.type)).toEqual(['threshold']);
    expect(first.value.skipped).toMatchObject([{ site: 'u' }]);

    world.clock.now = new Date(START.getTime() + 3_600_000);
    setPage(world, 'a', [fakeHit('a', 'RAM one', 2500), fakeHit('a', 'RAM two', 9000)]);
    out.length = 0;
    expect(await exec(['watch', 'run', 'ram'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('ram: changes, 2 hits, 2 events');
    expect(text).toContain('u: skipped');
    expect(text).toContain('shopper: ram: 1 new, 1 price drop');
    expect(sent).toEqual([]);
  });

  it('sends the alert with --notify and --notify-cmd, and prints to stdout without a command', async () => {
    setPage(world, 'a', []);
    await exec(['watch', 'add', 'ram', '--sites', 'a']);
    await exec(['watch', 'run', 'ram']);
    setPage(world, 'a', [fakeHit('a', 'RAM one', 100)]);

    out.length = 0;
    expect(await exec(['watch', 'run', 'ram', '--notify'])).toBe(0);
    expect(out.filter((line) => line.startsWith('shopper: ram: 1 new'))).toHaveLength(1);
    expect(sent).toEqual([]);

    setPage(world, 'a', [fakeHit('a', 'RAM one', 100), fakeHit('a', 'RAM two', 100)]);
    expect(
      await exec(['watch', 'run', 'ram', '--notify'], { SHOPPER_NOTIFY_CMD: 'env-alert' }),
    ).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.command).toBe('env-alert');
    expect(sent[0]?.input.split('\n')[0]).toBe('shopper: ram: 1 new');

    setPage(world, 'a', [
      fakeHit('a', 'RAM one', 100),
      fakeHit('a', 'RAM two', 100),
      fakeHit('a', 'RAM three', 100),
    ]);
    expect(
      await exec(['watch', 'run', 'ram', '--notify-cmd', 'flag-alert'], {
        SHOPPER_NOTIFY_CMD: 'env-alert',
      }),
    ).toBe(0);
    expect(sent[1]?.command).toBe('flag-alert');
    expect(sent[1]?.env).toMatchObject({ SHOPPER_WATCH_ID: 'ram', SHOPPER_NOTIFY_STATE: 'fail' });
  });

  it('keeps stdout clean for --json even without a command', async () => {
    setPage(world, 'a', []);
    await exec(['watch', 'add', 'ram', '--sites', 'a']);
    await exec(['watch', 'run', 'ram']);
    setPage(world, 'a', [fakeHit('a', 'RAM one', 100)]);
    const { code, value } = await json(['watch', 'run', 'ram', '--notify']);
    expect(code).toBe(0);
    expect(value.notify).toMatchObject({ method: 'none' });
    expect(value.message).toContain('shopper: ram: 1 new');
  });

  it('exits 2 and prints the message to stderr when the alert command fails', async () => {
    setPage(world, 'a', []);
    await exec(['watch', 'add', 'ram', '--sites', 'a']);
    await exec(['watch', 'run', 'ram']);
    setPage(world, 'a', [fakeHit('a', 'RAM one', 100)]);
    spawnCode = 1;
    expect(await exec(['watch', 'run', 'ram', '--notify-cmd', 'x'])).toBe(2);
    expect(err.join('\n')).toContain('notify failed: alert failed');
    expect(err.join('\n')).toContain('shopper: ram: 1 new');
  });

  it('exits 1 when nothing is found and 2 when every site fails', async () => {
    setPage(world, 'a', []);
    await exec(['watch', 'add', 'ram', '--sites', 'a']);
    expect(await exec(['watch', 'run', 'ram'])).toBe(1);
    setPage(world, 'a', new Error('network down'));
    expect(await exec(['watch', 'run', 'ram'])).toBe(2);
    expect(out.join('\n')).toContain('error: ');
    expect(await exec(['watch', 'run', 'nope'])).toBe(2);
  });

  it('runs only due watches with run-due', async () => {
    setPage(world, 'a', [fakeHit('a', 'RAM one', 100)]);
    await exec(['watch', 'add', 'one', '--sites', 'a', '--interval', '1h']);
    await exec(['watch', 'add', 'two', '--sites', 'a', '--interval', '1d']);
    out.length = 0;
    expect(await exec(['watch', 'run-due'])).toBe(0);
    expect(out.filter((line) => /: baseline/.test(line))).toHaveLength(2);

    world.clock.now = new Date(START.getTime() + 2 * 3_600_000);
    const { code, value } = await json(['watch', 'run-due']);
    expect(code).toBe(0);
    expect(value.due).toEqual(['one']);
    expect(value.results).toHaveLength(1);

    world.clock.now = new Date(START.getTime() + 2 * 3_600_000 + 60_000);
    out.length = 0;
    expect(await exec(['watch', 'run-due'])).toBe(0);
    expect(out).toEqual(['no watches due']);
  });

  it('returns 2 from run-due when a watch fails', async () => {
    setPage(world, 'a', new Error('network down'));
    await exec(['watch', 'add', 'one', '--sites', 'a']);
    expect(await exec(['watch', 'run-due'])).toBe(2);
  });

  it('prints the history, newest last', async () => {
    setPage(world, 'a', [fakeHit('a', 'RAM one', 100)]);
    await exec(['watch', 'add', 'ram', '--sites', 'a']);
    out.length = 0;
    expect(await exec(['watch', 'history', 'ram'])).toBe(0);
    expect(out).toEqual(['no history yet']);
    await exec(['watch', 'run', 'ram']);
    world.clock.now = new Date(START.getTime() + 3_600_000);
    setPage(world, 'a', [fakeHit('a', 'RAM one', 90)]);
    await exec(['watch', 'run', 'ram']);
    const all = await json(['watch', 'history', 'ram']);
    expect(all.value).toHaveLength(2);
    const limited = await json(['watch', 'history', 'ram', '--limit', '1']);
    expect(limited.value).toHaveLength(1);
    expect(limited.value[0].events[0].type).toBe('price_drop');
    out.length = 0;
    expect(await exec(['watch', 'history', 'ram', '--limit', '5'])).toBe(0);
    expect(out[0]).toContain('events');
    expect(out[0]).toContain('1 price drop');
    expect(await exec(['watch', 'history', 'ram', '--limit', '0'])).toBe(2);
    expect(await exec(['watch', 'history', 'nope'])).toBe(2);
  });
});

describe('watch timer and schema', () => {
  it('prints the units and the enable command without writing', async () => {
    expect(await exec(['watch', 'timer', '--every', '30m'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('OnUnitActiveSec=30m');
    expect(text).toContain(
      'ExecStart=/usr/bin/node /opt/shopper/dist/cli.js watch run-due --notify',
    );
    expect(text).toContain(
      'systemctl --user daemon-reload && systemctl --user enable --now shopper-watch.timer',
    );
    expect(existsSync(join(dir, '.config'))).toBe(false);
  });

  it('writes the units under the injected config home with --write', async () => {
    const config = join(dir, 'cfg');
    expect(await exec(['watch', 'timer', '--write'], { XDG_CONFIG_HOME: config })).toBe(0);
    const service = join(config, 'systemd', 'user', 'shopper-watch.service');
    expect(readFileSync(service, 'utf8')).toContain('Nice=19');
    expect(existsSync(join(config, 'systemd', 'user', 'shopper-watch.timer'))).toBe(true);
    expect(out.some((line) => line.includes('shopper-watch.timer'))).toBe(true);
  });

  it('falls back to the injected home and prints JSON', async () => {
    const { code, value } = await json(['watch', 'timer', '--write']);
    expect(code).toBe(0);
    expect(value.written).toBe(true);
    expect(value.files[0].path).toBe(
      join(dir, '.config', 'systemd', 'user', 'shopper-watch.service'),
    );
    expect(existsSync(value.files[1].path)).toBe(true);
  });

  it('rejects a bad interval', async () => {
    expect(await exec(['watch', 'timer', '--every', '5m'])).toBe(2);
    expect(await exec(['watch', 'timer', '--every', 'soon'])).toBe(2);
  });

  it('prints the JSON Schema', async () => {
    expect(await exec(['watch', 'schema'])).toBe(0);
    expect(JSON.parse(out.join('\n')).title).toBe('ShopperWatches');
  });

  it('lists the subcommands in the help', async () => {
    await exec(['watch', '--help']);
    const text = out.join('\n');
    for (const name of [
      'add',
      'list',
      'show',
      'edit',
      'remove',
      'run',
      'run-due',
      'history',
      'timer',
    ]) {
      expect(text).toContain(name);
    }
  });
});
