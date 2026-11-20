import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  utimesSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cleanStaleRunDirs,
  runProfileDir,
  staleRunDirs,
  buildChromiumArgs,
  buildLaunchCommand,
  normaliseUserAgent,
  BrowserSession,
  type CdpClient,
  resolveChromiumBinary,
  resolveProfileDir,
  shouldUseScope,
} from '../src/index.js';
import { tempDir } from './helpers.js';

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
    expect(shouldUseScope({ PATH: '/u', INVOCATION_ID: 'abc' }, 'linux', has)).toBe(false);
    expect(shouldUseScope({ PATH: '/u' }, 'linux', () => false)).toBe(false);
  });
});

describe('per-run profile directories', () => {
  it('builds a run directory under the base profile directory', () => {
    expect(runProfileDir('/base', 42, 'ab12')).toBe('/base/run-42-ab12');
  });

  const DAY = 86_400_000;
  const now = 100 * DAY;
  const entries = [
    { name: 'run-1-aa', mtimeMs: now - 2 * DAY },
    { name: 'run-2-bb', mtimeMs: now - 2 * DAY },
    { name: 'run-3-cc', mtimeMs: now - 1000 },
    { name: 'Default', mtimeMs: now - 5 * DAY },
    { name: 'run-x-dd', mtimeMs: now - 5 * DAY },
  ];

  it('selects only old run directories whose pid is gone', () => {
    expect(staleRunDirs(entries, now, (pid) => pid === 2)).toEqual(['run-1-aa']);
    expect(staleRunDirs(entries, now, () => false)).toEqual(['run-1-aa', 'run-2-bb']);
  });

  it('removes stale directories from disk and keeps the rest', () => {
    const base = tempDir();
    for (const name of ['run-1-aa', 'run-3-cc', 'keep']) mkdirSync(join(base, name));
    const old = new Date(Date.now() - 3 * DAY);
    utimesSync(join(base, 'run-1-aa'), old, old);
    utimesSync(join(base, 'keep'), old, old);
    expect(cleanStaleRunDirs(base, Date.now(), () => false)).toEqual(['run-1-aa']);
    expect(existsSync(join(base, 'run-1-aa'))).toBe(false);
    expect(existsSync(join(base, 'run-3-cc'))).toBe(true);
    expect(existsSync(join(base, 'keep'))).toBe(true);
    expect(cleanStaleRunDirs(join(base, 'missing'))).toEqual([]);
  });
});

describe('normaliseUserAgent', () => {
  it('replaces HeadlessChrome with Chrome', () => {
    expect(
      normaliseUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36',
      ),
    ).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    );
  });

  it('leaves a normal user agent unchanged', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Safari/537.36';
    expect(normaliseUserAgent(ua)).toBe(ua);
  });
});

describe('BrowserSession user agent', () => {
  function fakeClient() {
    const calls: Array<{ method: string; params: unknown; sessionId: string | undefined }> = [];
    const client = {
      async send(method: string, params: unknown, sessionId?: string) {
        calls.push({ method, params, sessionId });
        if (method === 'Browser.getVersion') return { userAgent: 'X HeadlessChrome/130 Y' };
        if (method === 'Target.createTarget') return { targetId: 't1' };
        if (method === 'Target.attachToTarget') return { sessionId: 's1' };
        return {};
      },
      close() {},
    };
    return { calls, client: client as unknown as CdpClient };
  }

  it('sets a rewritten user agent and language on every new page', async () => {
    const { calls, client } = fakeClient();
    const session = new BrowserSession(client, null, null, null, { lang: 'th-TH' });
    await (await session.newPage()).close();
    await (await session.newPage()).close();
    const overrides = calls.filter((call) => call.method.endsWith('.setUserAgentOverride'));
    expect(overrides.map((call) => call.method)).toEqual([
      'Network.setUserAgentOverride',
      'Emulation.setUserAgentOverride',
      'Network.setUserAgentOverride',
      'Emulation.setUserAgentOverride',
    ]);
    expect(overrides[0]?.params).toEqual({ userAgent: 'X Chrome/130 Y', acceptLanguage: 'th-TH' });
    expect(overrides[0]?.sessionId).toBe('s1');
    expect(calls.filter((call) => call.method === 'Browser.getVersion')).toHaveLength(1);
  });

  it('keeps the original user agent when asked', async () => {
    const { calls, client } = fakeClient();
    const session = new BrowserSession(client, null, null, null, { keepUserAgent: true });
    await (await session.newPage()).close();
    expect(calls.some((call) => call.method.includes('UserAgent'))).toBe(false);
    expect(calls.some((call) => call.method === 'Browser.getVersion')).toBe(false);
  });
});

const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const CAN_LAUNCH = resolveChromiumBinary() !== null && existsSync(DIST);

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

describe.skipIf(!CAN_LAUNCH || process.platform !== 'linux')('termination', () => {
  it('kills Chromium and removes the run profile when the CLI gets SIGTERM', async () => {
    const dir = tempDir();
    const profile = join(dir, 'profile');
    const script = join(dir, 'launch.mjs');
    writeFileSync(
      script,
      `import { launchBrowser } from ${JSON.stringify(pathToFileURL(DIST).href)};
const session = await launchBrowser({ profileDir: process.argv[2], scoped: false });
console.log('pid ' + session.pid);
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(process.execPath, [script, profile], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, AGENTS_BROWSER_NO_SANDBOX: process.getuid?.() === 0 ? '1' : '0' },
    });
    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', (code) => resolve(code)),
    );
    const browserPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no pid line')), 20_000);
      let text = '';
      child.stdout.on('data', (chunk: Buffer) => {
        text += chunk.toString();
        const match = /pid (\d+)/.exec(text);
        if (match !== null) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
    });
    expect(processGone(browserPid)).toBe(false);
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
    const deadline = Date.now() + 3000;
    while (!processGone(browserPid) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    expect(processGone(browserPid)).toBe(true);
    expect(existsSync(profile) ? readdirSync(profile) : []).toEqual([]);
  }, 40_000);
});
