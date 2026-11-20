import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WatchEvent } from '../src/core/watch/diff.js';
import {
  eventLine,
  formatMessage,
  notify,
  resolveNotifyCommand,
  shellSpawn,
  summaryLine,
  type SpawnRequest,
  type SpawnResult,
} from '../src/core/watch/notify.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shopper-notify-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function event(partial: Partial<WatchEvent> & Pick<WatchEvent, 'type'>): WatchEvent {
  return {
    key: 'a https://a.example.com/p/1',
    site: 'lazada-th',
    title: 'Kingston Fury DDR5 32GB',
    url: 'https://a.example.com/p/1',
    price: { amount: 3200, currency: 'THB' },
    stock: 'in_stock',
    ...partial,
  };
}

const NEW = event({ type: 'new' });
const DROP = event({
  type: 'price_drop',
  previousPrice: { amount: 3500, currency: 'THB' },
  previousStock: 'in_stock',
});
const BACK = event({ type: 'back_in_stock', previousStock: 'out_of_stock' });
const FAILING = event({
  type: 'scanner_failing',
  site: 'jib',
  price: null,
  url: '',
  title: 'jib failed 3 runs in a row',
  note: 'failed 3 runs in a row: timeout',
});

describe('message', () => {
  it('puts the summary on line 1', () => {
    expect(summaryLine('ddr5-32gb', [NEW, { ...NEW, key: 'k2' }, DROP])).toBe(
      'shopper: ddr5-32gb: 2 new, 1 price drop',
    );
    expect(summaryLine('x', [DROP, { ...DROP, key: 'k2' }])).toBe('shopper: x: 2 price drops');
    expect(summaryLine('x', [BACK, event({ type: 'threshold' }), FAILING])).toBe(
      'shopper: x: 1 back in stock, 1 at or under max price, 1 scanner failing',
    );
    expect(summaryLine('x', [{ ...FAILING, recovered: true }])).toBe(
      'shopper: x: 1 scanner recovered',
    );
    expect(summaryLine('x', [])).toBe('shopper: x: no changes');
  });

  it('prints one line per event with price, previous price, site, title and url', () => {
    expect(eventLine(DROP)).toBe(
      'price drop | ฿3,200 | was ฿3,500 | lazada-th | Kingston Fury DDR5 32GB | https://a.example.com/p/1',
    );
    expect(eventLine(NEW)).toContain('no earlier price');
    expect(eventLine(BACK)).toContain('was out_of_stock');
    expect(eventLine(FAILING)).toBe('scanner failing | jib | failed 3 runs in a row: timeout');
    expect(eventLine({ ...FAILING, recovered: true, note: 'recovered after 3 failed runs' })).toBe(
      'scanner recovered | jib | recovered after 3 failed runs',
    );
    expect(eventLine({ ...NEW, title: 'Two\n  lines' })).toContain('| Two lines |');
  });

  it('formats the whole message with the time in every configured zone', () => {
    const text = formatMessage({
      watchId: 'ddr5-32gb',
      events: [NEW, DROP],
      timeZones: ['Asia/Bangkok', 'Europe/London'],
      at: new Date('2026-11-21T00:30:00.000Z'),
    });
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('shopper: ddr5-32gb: 1 new, 1 price drop');
    expect(lines[3]).toBe('checked 2026-11-21 07:30 Asia/Bangkok | 2026-11-21 00:30 Europe/London');
  });
});

describe('command choice', () => {
  it('prefers the flag, then the env, then the defaults', () => {
    expect(resolveNotifyCommand('flag', { SHOPPER_NOTIFY_CMD: 'env' }, 'cfg')).toBe('flag');
    expect(resolveNotifyCommand(undefined, { SHOPPER_NOTIFY_CMD: 'env' }, 'cfg')).toBe('env');
    expect(resolveNotifyCommand(undefined, {}, 'cfg')).toBe('cfg');
    expect(resolveNotifyCommand('  ', { SHOPPER_NOTIFY_CMD: '' }, null)).toBeNull();
  });
});

describe('notifier with an injected spawn', () => {
  function setup(result: SpawnResult = { code: 0, stderr: '' }) {
    const calls: SpawnRequest[] = [];
    const printed: string[] = [];
    return {
      calls,
      printed,
      request: (events: WatchEvent[], command: string | null, quiet = true) => ({
        watchId: 'ddr5',
        events,
        message: 'MESSAGE',
        command,
        quietUnchanged: quiet,
        env: { KEEP: '1' } as NodeJS.ProcessEnv,
        spawn: async (req: SpawnRequest) => {
          calls.push(req);
          return result;
        },
        print: (text: string) => printed.push(text),
      }),
    };
  }

  it('runs the command with the message on stdin and the state env', async () => {
    const s = setup();
    const result = await notify(s.request([NEW], 'my-alert'));
    expect(result).toMatchObject({ method: 'command', sent: true, ok: true, state: 'fail' });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ command: 'my-alert', input: 'MESSAGE\n' });
    expect(s.calls[0]?.env).toMatchObject({
      KEEP: '1',
      SHOPPER_WATCH_ID: 'ddr5',
      SHOPPER_NOTIFY_STATE: 'fail',
    });
    expect(s.printed).toEqual([]);
  });

  it('prints to stdout when no command is set', async () => {
    const s = setup();
    const result = await notify(s.request([NEW], null));
    expect(result).toMatchObject({ method: 'stdout', sent: true });
    expect(s.printed).toEqual(['MESSAGE']);
    expect(s.calls).toEqual([]);
  });

  it('sends nothing without events when quietUnchanged is on', async () => {
    const s = setup();
    expect(await notify(s.request([], 'cmd'))).toMatchObject({
      method: 'none',
      sent: false,
      ok: true,
      state: 'ok',
    });
    expect(await notify(s.request([], null))).toMatchObject({ method: 'none' });
    expect(s.calls).toEqual([]);
    expect(s.printed).toEqual([]);
  });

  it('sends an ok message without events when quietUnchanged is off', async () => {
    const s = setup();
    const result = await notify(s.request([], 'cmd', false));
    expect(result).toMatchObject({ method: 'command', sent: true, state: 'ok' });
    expect(s.calls[0]?.env.SHOPPER_NOTIFY_STATE).toBe('ok');
  });

  it('reports a failing command', async () => {
    const s = setup({ code: 3, stderr: 'boom\n' });
    const result = await notify(s.request([NEW], 'cmd'));
    expect(result).toMatchObject({ ok: false, sent: false, exitCode: 3, error: 'boom' });
    const silent = setup({ code: null, stderr: '' });
    expect((await notify(silent.request([NEW], 'cmd'))).error).toContain('no code');
  });

  it('stays quiet without a command when no printer is given', async () => {
    const s = setup();
    const result = await notify({ ...s.request([NEW], null), print: null });
    expect(result).toMatchObject({ method: 'none', sent: false });
  });
});

describe('notifier with a real shell command', () => {
  it('pipes the message into the command and passes the env', async () => {
    const out = join(dir, 'out.txt');
    const result = await notify({
      watchId: 'ddr5-32gb',
      events: [NEW],
      message: 'line one\nline two',
      command: `cat > '${out}'; printf '%s %s' "$SHOPPER_WATCH_ID" "$SHOPPER_NOTIFY_STATE" > '${out}.env'`,
      quietUnchanged: true,
      env: process.env,
      spawn: shellSpawn,
      print: null,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(out, 'utf8')).toBe('line one\nline two\n');
    expect(readFileSync(`${out}.env`, 'utf8')).toBe('ddr5-32gb fail');
  });

  it('reports a non-zero exit with stderr', async () => {
    const result = await notify({
      watchId: 'x',
      events: [NEW],
      message: 'm',
      command: 'cat >/dev/null; echo nope >&2; exit 4',
      quietUnchanged: true,
      env: process.env,
      spawn: shellSpawn,
      print: null,
    });
    expect(result).toMatchObject({ ok: false, exitCode: 4, error: 'nope' });
  });

  it('kills a command that runs too long', async () => {
    const result = await notify({
      watchId: 'x',
      events: [NEW],
      message: 'm',
      command: 'sleep 5',
      quietUnchanged: true,
      env: process.env,
      spawn: shellSpawn,
      print: null,
      timeoutMs: 200,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
  });
});
