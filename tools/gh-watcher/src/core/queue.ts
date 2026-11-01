/**
 * Host-wide GitHub queue without a daemon. Every gh-watcher process on the host funnels its `gh`
 * calls through files under the state dir: a short-TTL response cache with single-flight, a global
 * minimum spacing between calls, and a shared cooldown that is set when GitHub rate-limits anyone.
 * Cache entries hold only gh stdout; no token ever reaches these files.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GhExec, GhExecResult } from './gh.js';
import { stateDir } from './store.js';

export const CACHE_TTL_ENV = 'GH_WATCHER_CACHE_TTL';
export const MIN_SPACING_ENV = 'GH_WATCHER_MIN_SPACING';
export const QUEUE_DISABLE_ENV = 'GH_WATCHER_QUEUE';

const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_MIN_SPACING_MS = 1_000;
const DEFAULT_BACKOFF_BASE_MS = 60_000;
const DEFAULT_BACKOFF_CAP_MS = 15 * 60_000;
const DEFAULT_MAX_WAIT_MS = 10 * 60_000;
const LOCK_POLL_MS = 50;
// A lock holder may legitimately sit out a long rate-limit wait, so only a dead PID or a very old lock is stale.
const LOCK_STALE_MS = 25 * 3_600_000;
const RESET_MARGIN_MS = 1_000;

export class RateLimitTimeoutError extends Error {
  readonly resumeAt: number;

  constructor(resumeAt: number) {
    super(`GitHub rate limit: resume at ${new Date(resumeAt).toISOString()} is beyond the wait limit`);
    this.name = 'RateLimitTimeoutError';
    this.resumeAt = resumeAt;
  }
}

/** A gh executor that can also be told the absolute time (epoch ms) after which it must stop waiting. */
export type QueuedExec = GhExec & { setDeadline?: (deadline: number | undefined) => void };

export interface QueueOptions {
  dir?: string;
  cacheTtlMs?: number;
  minSpacingMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Longest single rate-limit wait when no deadline was set. */
  defaultMaxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

interface CacheEntry {
  storedAt: number;
  stdout: string;
}

interface Cooldown {
  until: number;
  attempts: number;
  reason: string;
}

type LimitKind = 'primary' | 'secondary';

interface LimitInfo {
  kind: LimitKind;
  retryAfterMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envSeconds(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value * 1000 : undefined;
}

export function queueDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[QUEUE_DISABLE_ENV]?.trim().toLowerCase();
  return raw === '0' || raw === 'off' || raw === 'false';
}

/** Recognise a primary or secondary GitHub rate limit in a failed gh call; undefined otherwise. */
export function detectRateLimit(result: GhExecResult): LimitInfo | undefined {
  if (result.code === 0) {
    return undefined;
  }
  const text = result.stderr;
  const secondary = /secondary rate limit|abuse detection|abuse rate/i.test(text);
  const primary = /api rate limit (already )?exceeded|rate limit exceeded/i.test(text);
  const tooMany = /\bHTTP 429\b|too many requests/i.test(text);
  const forbiddenRate = /\bHTTP 403\b/i.test(text) && /rate limit|retry/i.test(text);
  if (!secondary && !primary && !tooMany && !forbiddenRate) {
    return undefined;
  }
  const retry = /retry[- ]after[:= ]+(\d+)/i.exec(text);
  const info: LimitInfo = { kind: primary && !secondary ? 'primary' : 'secondary' };
  if (retry?.[1] !== undefined) {
    info.retryAfterMs = Number(retry[1]) * 1000;
  }
  return info;
}

function lockOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

export class GhQueue {
  private readonly dir: string;
  private readonly cacheTtlMs: number;
  private readonly minSpacingMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly defaultMaxWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private deadline: number | undefined;
  private lastLoggedUntil = 0;

  constructor(
    private readonly inner: GhExec,
    options: QueueOptions = {},
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.dir = join(options.dir ?? stateDir(), 'queue');
    this.cacheTtlMs = options.cacheTtlMs ?? envSeconds(CACHE_TTL_ENV, env) ?? DEFAULT_CACHE_TTL_MS;
    this.minSpacingMs = options.minSpacingMs ?? envSeconds(MIN_SPACING_ENV, env) ?? DEFAULT_MIN_SPACING_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffCapMs = options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    this.defaultMaxWaitMs = options.defaultMaxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  }

  setDeadline(deadline: number | undefined): void {
    this.deadline = deadline;
  }

  readonly exec: QueuedExec = Object.assign((args: string[]) => this.run(args), {
    setDeadline: (deadline: number | undefined) => {
      this.setDeadline(deadline);
    },
  });

  private async run(args: string[]): Promise<GhExecResult> {
    await mkdir(join(this.dir, 'cache'), { recursive: true, mode: 0o700 });
    const key = createHash('sha256').update(JSON.stringify(args)).digest('hex');
    const cacheFile = join(this.dir, 'cache', `${key}.json`);
    const lockFile = join(this.dir, 'cache', `${key}.lock`);
    const callDeadline = this.deadline ?? this.now() + this.defaultMaxWaitMs;
    for (;;) {
      const cached = await this.readCache(cacheFile);
      if (cached !== undefined) {
        return { stdout: cached.stdout, stderr: '', code: 0 };
      }
      if (!(await this.tryLock(lockFile))) {
        await this.sleep(LOCK_POLL_MS);
        if (this.now() > callDeadline) {
          throw new RateLimitTimeoutError(this.now());
        }
        continue;
      }
      try {
        // Another process may have filled the cache while we waited for the lock.
        const again = await this.readCache(cacheFile);
        if (again !== undefined) {
          return { stdout: again.stdout, stderr: '', code: 0 };
        }
        const result = await this.callWithBackoff(args, callDeadline);
        if (result.code === 0 && this.cacheTtlMs > 0) {
          await this.writeCache(cacheFile, { storedAt: this.now(), stdout: result.stdout });
        }
        return result;
      } finally {
        await unlink(lockFile).catch(() => undefined);
      }
    }
  }

  private async readCache(file: string): Promise<CacheEntry | undefined> {
    if (this.cacheTtlMs <= 0) {
      return undefined;
    }
    const entry = await readJson<CacheEntry>(file);
    if (
      entry === undefined ||
      typeof entry.storedAt !== 'number' ||
      typeof entry.stdout !== 'string' ||
      this.now() - entry.storedAt >= this.cacheTtlMs ||
      entry.storedAt > this.now() + this.cacheTtlMs
    ) {
      return undefined;
    }
    return entry;
  }

  private async writeCache(file: string, entry: CacheEntry): Promise<void> {
    await writeAtomic(file, entry);
    await this.purgeCache();
  }

  /** Drop cache files that are long expired so the directory stays small. */
  private async purgeCache(): Promise<void> {
    const dir = join(this.dir, 'cache');
    const horizon = Math.max(this.cacheTtlMs * 6, 60_000);
    try {
      for (const name of await readdir(dir)) {
        const file = join(dir, name);
        const info = await stat(file).catch(() => undefined);
        if (info !== undefined && Date.now() - info.mtimeMs > horizon && !name.endsWith('.lock')) {
          await unlink(file).catch(() => undefined);
        }
      }
    } catch {
      // Best effort only.
    }
  }

  /** Try to take an advisory lock file (O_EXCL), recovering stale locks by owner PID and age. */
  private async tryLock(file: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(file, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: this.now() }));
        } finally {
          await handle.close();
        }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
      const owner = await readJson<{ pid?: number; at?: number }>(file);
      const age = owner?.at === undefined ? 0 : this.now() - owner.at;
      const dead = owner?.pid !== undefined && !lockOwnerAlive(owner.pid);
      if (owner === undefined) {
        // Unreadable or half-written: judge by file age on disk.
        const info = await stat(file).catch(() => undefined);
        if (info === undefined || Date.now() - info.mtimeMs < 5_000) {
          return false;
        }
      } else if (!dead && age < LOCK_STALE_MS) {
        return false;
      }
      await unlink(file).catch(() => undefined);
    }
    return false;
  }

  private async withLock<T>(file: string, body: () => Promise<T>): Promise<T> {
    while (!(await this.tryLock(file))) {
      await this.sleep(LOCK_POLL_MS);
    }
    try {
      return await body();
    } finally {
      await unlink(file).catch(() => undefined);
    }
  }

  private async readCooldown(): Promise<Cooldown | undefined> {
    return readJson<Cooldown>(join(this.dir, 'cooldown.json'));
  }

  /** Sleep until `until`, but never beyond the deadline: then give up with a timeout error. */
  private async sleepUntil(until: number, deadline: number): Promise<void> {
    if (until > deadline) {
      await this.sleep(Math.max(0, deadline - this.now()));
      throw new RateLimitTimeoutError(until);
    }
    await this.sleep(Math.max(0, until - this.now()));
  }

  private async waitForCooldown(deadline: number): Promise<void> {
    for (;;) {
      const cooldown = await this.readCooldown();
      if (cooldown === undefined || cooldown.until <= this.now()) {
        return;
      }
      this.logResume(cooldown.until, cooldown.reason);
      await this.sleepUntil(cooldown.until, deadline);
    }
  }

  /** Reserve the next global call slot and wait for it, so calls across processes are spaced. */
  private async waitForSlot(deadline: number): Promise<void> {
    if (this.minSpacingMs <= 0) {
      return;
    }
    const slotFile = join(this.dir, 'slot.json');
    const slot = await this.withLock(join(this.dir, 'slot.lock'), async () => {
      const state = await readJson<{ next?: number }>(slotFile);
      const at = Math.max(this.now(), state?.next ?? 0);
      await writeAtomic(slotFile, { next: at + this.minSpacingMs });
      return at;
    });
    if (slot > this.now()) {
      await this.sleepUntil(slot, deadline);
    }
  }

  private logResume(until: number, reason: string): void {
    if (until !== this.lastLoggedUntil) {
      this.lastLoggedUntil = until;
      this.log(`gh-watcher: GitHub ${reason}, waiting until ${new Date(until).toISOString()}`);
    }
  }

  private async callWithBackoff(args: string[], deadline: number): Promise<GhExecResult> {
    for (;;) {
      await this.waitForCooldown(deadline);
      await this.waitForSlot(deadline);
      const again = await this.readCooldown();
      if (again !== undefined && again.until > this.now()) {
        continue; // Another process hit a limit while we waited for our slot.
      }
      const result = await this.inner(args);
      const limit = detectRateLimit(result);
      if (limit === undefined) {
        if (result.code === 0) {
          await this.clearAttempts();
        }
        return result;
      }
      await this.recordLimit(limit);
    }
  }

  private async clearAttempts(): Promise<void> {
    const cooldown = await this.readCooldown();
    if (cooldown !== undefined && cooldown.attempts > 0 && cooldown.until <= this.now()) {
      await writeAtomic(join(this.dir, 'cooldown.json'), { ...cooldown, attempts: 0 });
    }
  }

  private async recordLimit(limit: LimitInfo): Promise<void> {
    const existing = await this.readCooldown();
    const attempts = (existing?.attempts ?? 0) + 1;
    let until: number;
    if (limit.retryAfterMs !== undefined) {
      until = this.now() + limit.retryAfterMs;
    } else if (limit.kind === 'primary') {
      until = (await this.primaryReset()) ?? this.now() + this.backoffBaseMs;
    } else {
      until = this.now() + Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** (attempts - 1));
    }
    if (existing !== undefined && existing.until > until) {
      return; // Another process already recorded a later resume time.
    }
    const reason = `${limit.kind} rate limit hit`;
    await writeAtomic(join(this.dir, 'cooldown.json'), { until, attempts, reason } satisfies Cooldown);
  }

  /** Reset time of the exhausted rate-limit bucket; `gh api rate_limit` is free of charge. */
  private async primaryReset(): Promise<number | undefined> {
    try {
      const result = await this.inner(['api', 'rate_limit']);
      if (result.code !== 0) {
        return undefined;
      }
      const parsed = JSON.parse(result.stdout) as {
        resources?: Record<string, { remaining?: number; reset?: number }>;
      };
      const resets = Object.values(parsed.resources ?? {})
        .filter((bucket) => bucket.remaining === 0 && typeof bucket.reset === 'number')
        .map((bucket) => (bucket.reset as number) * 1000);
      if (resets.length === 0) {
        return undefined;
      }
      return Math.min(...resets) + RESET_MARGIN_MS;
    } catch {
      return undefined;
    }
  }
}

/** Wrap a gh executor in the shared host-wide queue. */
export function createQueuedExec(inner: GhExec, options?: QueueOptions, env?: NodeJS.ProcessEnv): QueuedExec {
  return new GhQueue(inner, options, env).exec;
}
