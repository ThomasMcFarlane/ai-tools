import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { resolveCacheDir, type PathOptions } from '../memory/paths.js';
import { CdpClient, browserWebSocketUrl, type WebSocketFactory } from './cdp.js';

export const MAX_TABS = 4;

export interface ChromiumArgsOptions {
  profileDir: string;
  noSandbox?: boolean;
  windowSize?: string;
  lang?: string;
}

export function buildChromiumArgs(opts: ChromiumArgsOptions): string[] {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${opts.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--window-size=${opts.windowSize ?? '1366,900'}`,
    `--lang=${opts.lang ?? 'en-US'}`,
  ];
  if (opts.noSandbox === true) args.push('--no-sandbox');
  args.push('about:blank');
  return args;
}

export interface LaunchCommandOptions {
  binary: string;
  args: string[];
  scoped: boolean;
}

export interface LaunchCommand {
  command: string;
  args: string[];
  scoped: boolean;
}

export const SCOPE_LIMITS = ['MemoryHigh=2G', 'MemoryMax=3G', 'MemorySwapMax=512M'] as const;

export function buildLaunchCommand(opts: LaunchCommandOptions): LaunchCommand {
  if (!opts.scoped) return { command: opts.binary, args: opts.args, scoped: false };
  const limits = SCOPE_LIMITS.flatMap((limit) => ['-p', limit]);
  return {
    command: 'systemd-run',
    args: ['--user', '--scope', '--quiet', ...limits, '--', opts.binary, ...opts.args],
    scoped: true,
  };
}

export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function resolveChromiumBinary(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const fromEnv = env.AGENTS_CHROMIUM;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
    const found = findOnPath(name, env, exists);
    if (found !== null) return found;
  }
  return null;
}

export function resolveProfileDir(opts: PathOptions = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = env.AGENTS_BROWSER_PROFILE_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return join(resolveCacheDir(opts), 'chromium-profile');
}

export function shouldUseScope(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): boolean {
  if (platform !== 'linux') return false;
  if (env.AGENTS_BROWSER_CGROUP === '0') return false;
  return findOnPath('systemd-run', env, exists) !== null;
}

export class BrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

export interface GotoOptions {
  timeoutMs?: number;
  settleMs?: number;
}

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

export class Page {
  constructor(
    private readonly browser: CdpClient,
    private readonly targetId: string,
    private readonly sessionId: string,
    private readonly release: () => void,
  ) {}

  private call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId);
  }

  async setCookies(cookies: Cookie[]): Promise<void> {
    await this.call('Network.enable');
    for (const cookie of cookies) {
      await this.call('Network.setCookie', { path: '/', ...cookie });
    }
  }

  async goto(url: string, opts: GotoOptions = {}): Promise<void> {
    await this.call('Page.enable');
    const loaded = this.browser
      .waitFor('Page.loadEventFired', {
        sessionId: this.sessionId,
        timeoutMs: opts.timeoutMs ?? 30_000,
      })
      .catch(() => undefined);
    const nav = await this.call<{ errorText?: string }>('Page.navigate', { url });
    if (nav.errorText !== undefined) throw new BrowserError(`navigation failed: ${nav.errorText}`);
    await loaded;
    const settle = opts.settleMs ?? 1500;
    if (settle > 0) await new Promise<void>((resolve) => setTimeout(resolve, settle));
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.call<{
      result: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new BrowserError(`script failed: ${detail ?? 'unknown error'}`);
    }
    return result.result.value as T;
  }

  content(): Promise<string> {
    return this.evaluate<string>('document.documentElement.outerHTML');
  }

  url(): Promise<string> {
    return this.evaluate<string>('location.href');
  }

  async close(): Promise<void> {
    try {
      await this.browser.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      return;
    } finally {
      this.release();
    }
  }
}

class Semaphore {
  private waiting: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.active -= 1;
  }
}

export class BrowserSession {
  private readonly tabs = new Semaphore(MAX_TABS);

  constructor(
    readonly client: CdpClient,
    readonly pid: number | null,
    private readonly child: ChildProcess | null,
  ) {}

  async newPage(): Promise<Page> {
    await this.tabs.acquire();
    try {
      const { targetId } = await this.client.send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
      });
      const { sessionId } = await this.client.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      return new Page(this.client, targetId, sessionId, () => this.tabs.release());
    } catch (error) {
      this.tabs.release();
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.send('Browser.close');
    } catch {
      this.client.close();
    }
    this.client.close();
    const child = this.child;
    if (child === null || child.pid === undefined) return;
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      return;
    }
  }
}

export interface LaunchOptions extends PathOptions {
  profileDir?: string;
  binary?: string;
  scoped?: boolean;
  startTimeoutMs?: number;
  factory?: WebSocketFactory;
}

function readPort(profileDir: string): number | null {
  const file = join(profileDir, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  const first = readFileSync(file, 'utf8').split('\n')[0] ?? '';
  const port = Number(first.trim());
  return Number.isInteger(port) && port > 0 ? port : null;
}

async function startChild(
  command: LaunchCommand,
  profileDir: string,
  timeoutMs: number,
): Promise<{ child: ChildProcess; port: number }> {
  rmSync(join(profileDir, 'DevToolsActivePort'), { force: true });
  const child = spawn(command.command, command.args, { stdio: 'ignore', detached: true });
  let exited = false;
  let spawnError: Error | null = null;
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', (error) => {
    spawnError = error;
    exited = true;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = readPort(profileDir);
    if (port !== null) return { child, port };
    if (exited) {
      const reason = spawnError === null ? 'it exited early' : (spawnError as Error).message;
      throw new BrowserError(`browser did not start: ${reason}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  if (child.exitCode === null) child.kill('SIGKILL');
  throw new BrowserError(`browser did not report a DevTools port within ${timeoutMs} ms`);
}

export async function launchBrowser(opts: LaunchOptions = {}): Promise<BrowserSession> {
  const env = opts.env ?? process.env;
  const binary = opts.binary ?? resolveChromiumBinary(env);
  if (binary === null) {
    throw new BrowserError(
      'no Chromium found: install chromium or google-chrome, or set AGENTS_CHROMIUM',
    );
  }
  const profileDir = opts.profileDir ?? resolveProfileDir(opts);
  mkdirSync(profileDir, { recursive: true });
  const args = buildChromiumArgs({
    profileDir,
    noSandbox: env.AGENTS_BROWSER_NO_SANDBOX === '1',
  });
  const timeoutMs = opts.startTimeoutMs ?? 20_000;
  const wantScope = opts.scoped ?? shouldUseScope(env);
  let started: { child: ChildProcess; port: number };
  if (wantScope) {
    try {
      started = await startChild(
        buildLaunchCommand({ binary, args, scoped: true }),
        profileDir,
        timeoutMs,
      );
    } catch {
      started = await startChild(
        buildLaunchCommand({ binary, args, scoped: false }),
        profileDir,
        timeoutMs,
      );
    }
  } else {
    started = await startChild(
      buildLaunchCommand({ binary, args, scoped: false }),
      profileDir,
      timeoutMs,
    );
  }
  try {
    const wsUrl = await browserWebSocketUrl(started.port);
    const connectOptions = opts.factory === undefined ? {} : { factory: opts.factory };
    const client = await CdpClient.connect(wsUrl, connectOptions);
    return new BrowserSession(client, started.child.pid ?? null, started.child);
  } catch (error) {
    if (started.child.exitCode === null) started.child.kill('SIGKILL');
    throw error;
  }
}
