import { describe, expect, it } from 'vitest';
import {
  buildChromiumArgs,
  buildLaunchCommand,
  resolveChromiumBinary,
  resolveProfileDir,
  shouldUseScope,
} from '../src/index.js';

describe('buildChromiumArgs', () => {
  it('builds the headless argument list', () => {
    const args = buildChromiumArgs({ profileDir: '/p' });
    expect(args).toContain('--headless=new');
    expect(args).toContain('--remote-debugging-port=0');
    expect(args).toContain('--user-data-dir=/p');
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--no-default-browser-check');
    expect(args).not.toContain('--no-sandbox');
    expect(args.at(-1)).toBe('about:blank');
  });

  it('adds --no-sandbox only on request', () => {
    expect(buildChromiumArgs({ profileDir: '/p', noSandbox: true })).toContain('--no-sandbox');
  });
});

describe('buildLaunchCommand', () => {
  it('runs the binary directly without a scope', () => {
    expect(buildLaunchCommand({ binary: '/bin/c', args: ['--x'], scoped: false })).toEqual({
      command: '/bin/c',
      args: ['--x'],
      scoped: false,
    });
  });

  it('wraps the binary in a systemd scope with memory caps', () => {
    const out = buildLaunchCommand({ binary: '/bin/c', args: ['--x'], scoped: true });
    expect(out.command).toBe('systemd-run');
    expect(out.args.slice(0, 3)).toEqual(['--user', '--scope', '--quiet']);
    expect(out.args).toContain('MemoryHigh=2G');
    expect(out.args).toContain('MemoryMax=3G');
    expect(out.args).toContain('MemorySwapMax=512M');
    expect(out.args.slice(-2)).toEqual(['/bin/c', '--x']);
    expect(out.args[out.args.indexOf('--') + 1]).toBe('/bin/c');
  });
});

describe('resolution helpers', () => {
  it('prefers AGENTS_CHROMIUM then the first browser on PATH', () => {
    expect(resolveChromiumBinary({ AGENTS_CHROMIUM: '/x/c' }, () => false)).toBe('/x/c');
    const exists = (path: string) => path === '/b/google-chrome' || path === '/a/chromium-browser';
    expect(resolveChromiumBinary({ PATH: '/a:/b' }, exists)).toBe('/a/chromium-browser');
    expect(resolveChromiumBinary({ PATH: '/z' }, () => false)).toBeNull();
  });

  it('resolves the profile directory', () => {
    expect(resolveProfileDir({ env: { AGENTS_BROWSER_PROFILE_DIR: '/pp' }, home: '/h' })).toBe(
      '/pp',
    );
    expect(resolveProfileDir({ env: {}, home: '/h' })).toBe(
      '/h/.cache/ai-tools/agents/chromium-profile',
    );
  });

  it('uses a scope only on Linux with systemd-run and no opt-out', () => {
    const has = () => true;
    expect(shouldUseScope({ PATH: '/u' }, 'linux', has)).toBe(true);
    expect(shouldUseScope({ PATH: '/u', AGENTS_BROWSER_CGROUP: '0' }, 'linux', has)).toBe(false);
    expect(shouldUseScope({ PATH: '/u' }, 'darwin', has)).toBe(false);
    expect(shouldUseScope({ PATH: '/u' }, 'linux', () => false)).toBe(false);
  });
});
