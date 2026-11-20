import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ENABLE_COMMAND,
  checkEvery,
  execArgs,
  renderService,
  renderTimer,
  renderUnits,
  systemdQuote,
  unitDir,
  writeUnits,
} from '../src/core/watch/timer.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shopper-timer-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('service unit', () => {
  it('has the required settings and an absolute ExecStart', () => {
    const text = renderService({ every: '15m', exec: ['/opt/shopper/shopper'] });
    expect(text).toContain(
      '[Service]\nType=oneshot\nNice=19\nMemoryHigh=2G\nMemoryMax=3G\nTimeoutStartSec=20min\n',
    );
    expect(text).toContain('EnvironmentFile=-%h/.config/ai-tools/shopper-watch.env\n');
    expect(text).toContain('ExecStart=/opt/shopper/shopper watch run-due --notify\n');
  });

  it('runs node with the script when the CLI is not a packaged binary', () => {
    const exec = execArgs({
      execPath: '/usr/bin/node',
      scriptPath: '/srv/ai-tools/agents/shopper/dist/cli.js',
      packaged: false,
    });
    expect(renderService({ every: '15m', exec })).toContain(
      'ExecStart=/usr/bin/node /srv/ai-tools/agents/shopper/dist/cli.js watch run-due --notify',
    );
    expect(execArgs({ execPath: '/b/shopper', scriptPath: '/ignored', packaged: true })).toEqual([
      '/b/shopper',
    ]);
  });

  it('quotes paths with spaces and escapes systemd specials', () => {
    expect(systemdQuote('/plain/path-1.js')).toBe('/plain/path-1.js');
    expect(systemdQuote('/my dir/cli.js')).toBe('"/my dir/cli.js"');
    expect(systemdQuote('/50%/a$b')).toBe('"/50%%/a$$b"');
    expect(systemdQuote('say "hi"')).toBe('"say \\"hi\\""');
    expect(renderService({ every: '15m', exec: ['/my dir/shopper'] })).toContain(
      'ExecStart="/my dir/shopper" watch run-due --notify',
    );
  });

  it('refuses a relative ExecStart', () => {
    expect(() => renderService({ every: '15m', exec: ['shopper'] })).toThrow(/absolute/);
  });
});

describe('timer unit', () => {
  it('has the boot delay, the interval and Persistent', () => {
    const text = renderTimer({ every: '30m' });
    expect(text).toContain('OnBootSec=5min\n');
    expect(text).toContain('OnUnitActiveSec=30m\n');
    expect(text).toContain('Persistent=true\n');
    expect(text).toContain('Unit=shopper-watch.service\n');
    expect(text).toContain('[Install]\nWantedBy=timers.target\n');
  });

  it('checks the interval', () => {
    expect(checkEvery('15m')).toBe('15m');
    expect(checkEvery('1d')).toBe('1d');
    expect(() => checkEvery('10m')).toThrow(/15m/);
    expect(() => checkEvery('often')).toThrow(/not valid/);
  });
});

describe('unit files', () => {
  it('picks the directory from XDG_CONFIG_HOME or the home', () => {
    expect(unitDir({ XDG_CONFIG_HOME: '/cfg' }, '/home/u')).toBe('/cfg/systemd/user');
    expect(unitDir({}, '/home/u')).toBe('/home/u/.config/systemd/user');
    expect(unitDir({ XDG_CONFIG_HOME: '' }, '/home/u')).toBe('/home/u/.config/systemd/user');
  });

  it('writes both files into the given directory', () => {
    const files = renderUnits(
      { every: '1h', exec: ['/opt/shopper'] },
      join(dir, 'systemd', 'user'),
    );
    writeUnits(files);
    expect(readFileSync(join(dir, 'systemd', 'user', 'shopper-watch.service'), 'utf8')).toContain(
      'ExecStart=/opt/shopper watch run-due --notify',
    );
    expect(readFileSync(join(dir, 'systemd', 'user', 'shopper-watch.timer'), 'utf8')).toContain(
      'OnUnitActiveSec=1h',
    );
    expect(ENABLE_COMMAND).toBe(
      'systemctl --user daemon-reload && systemctl --user enable --now shopper-watch.timer',
    );
  });
});
