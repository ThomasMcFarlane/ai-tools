/**
 * Host-wide GitHub queue without a daemon. Every gh-watcher process on the host funnels its `gh`
 * calls through files under the state dir: a short-TTL response cache with single-flight, a global
 * minimum spacing between calls, and a shared cooldown that is set when GitHub rate-limits anyone.
 * Cache entries hold only gh stdout; no token ever reaches these files.
 */
import { createHash, randomUUID } from 'node:crypto';
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
/** A lock is never held across a sleep or longer than one gh call, so a little over the exec timeout is stale. */
export const LOCK_STALE_MS = 3 * 60_000;
const RESET_MARGIN_MS = 1_000;

export class QueueAbortedError extends Error {
  constructor() {
    super('gh-watcher: stopped');
    this.name = 'AbortError';
  }
}

export class RateLimitTimeoutError extends Error {
  readonly resumeAt: number;

  constructor(resumeAt: number) {
    super(`GitHub rate limit: resume at ${new Date(resumeAt).toISOString()} is beyond the wait limit`);
    this.name = 'RateLimitTimeoutError';
    this.resumeAt = resumeAt;
  }
}

/** A gh executor that can also be told the absolute time (epoch ms) after which it must stop waiting. */
export type QueuedExec = GhExec & {
  setDeadline?: (deadline: number | undefined) => void;
  setSignal?: (signal: AbortSignal | undefined) => void;
};

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
  /** Ends queued sleeps and lock waits promptly (for example on SIGINT). */
  signal?: AbortSignal;
}

interface CacheEntry {
  /** When the fetch that produced this entry began. */
  startedAt: number;
  /** When that fetch finished; a caller that arrived before this may share the entry. */
  completedAt: number;
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

/** Identity scope: host, config dir and a hash of the token (never the token), so accounts never share state. */
export function identityScope(env: NodeJS.ProcessEnv = process.env): string {
  const token = env['GH_TOKEN'] ?? env['GITHUB_TOKEN'] ?? '';
  const tokenHash = token.length === 0 ? '' : createHash('sha256').update(token).digest('hex');
  const host = env['GH_HOST']?.trim() || 'github.com';
  return createHash('sha256')
    .update(JSON.stringify([host, env['GH_CONFIG_DIR'] ?? '', tokenHash]))
    .digest('hex')
    .slice(0, 16);
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

interface LockBody {
  pid?: number;
  at?: number;
  token?: string;
}

/**
 * Try to take an advisory lock file (O_EXCL). Returns the owner token, or undefined when another
 * live holder has it. A stale lock (dead PID, or older than LOCK_STALE_MS) is renamed away to a
 * unique name and deleted only if what was renamed is the stale content that was read.
 */
export async function acquireLock(file: string, now: () => number = () => Date.now()): Promise<string | undefined> {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: now(), token } satisfies LockBody));
      } finally {
        await handle.close();
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue; // released in between: retry the exclusive create
    }
    let owner: LockBody | undefined;
    try {
      owner = JSON.parse(raw) as LockBody;
    } catch {
      owner = undefined;
    }
    if (owner === undefined) {
      const info = await stat(file).catch(() => undefined);
      if (info === undefined || Date.now() - info.mtimeMs < 5_000) {
        return undefined; // probably half written
      }
    } else {
      const age = owner.at === undefined ? 0 : now() - owner.at;
      const dead = owner.pid !== undefined && !lockOwnerAlive(owner.pid);
      if (!dead && age < LOCK_STALE_MS) {
        return undefined;
      }
    }
    const aside = `${file}.stale.${randomUUID()}`;
    try {
      await rename(file, aside);
    } catch {
      continue;
    }
    // Whatever we moved is discarded; if it was not the stale lock we read, a live holder only
    // loses exclusion (its release is token checked) and nothing is put back.
    await unlink(aside).catch(() => undefined);
  }
  return undefined;
}

/** Release a lock only if it still carries our token. */
export async function releaseLock(file: string, token: string): Promise<void> {
  const owner = await readJson<LockBody>(file);
  if (owner?.token === token) {
    await unlink(file).catch(() => undefined);
  }
}

export class GhQueue {
  private readonly dir: string;
  private readonly scope: string;
  private readonly cacheTtlMs: number;
  private readonly minSpacingMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly defaultMaxWaitMs: number;
  private readonly now: () => number;
  private readonly sleepFn: ((ms: number) => Promise<void>) | undefined;
  private readonly log: (line: string) => void;
  private deadline: number | undefined;
  private signal: AbortSignal | undefined;
  private lastLoggedUntil = 0;

  constructor(
    private readonly inner: GhExec,
    options: QueueOptions = {},
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.dir = join(options.dir ?? stateDir(), 'queue');
    this.scope = identityScope(env);
    this.cacheTtlMs = options.cacheTtlMs ?? envSeconds(CACHE_TTL_ENV, env) ?? DEFAULT_CACHE_TTL_MS;
    this.minSpacingMs = options.minSpacingMs ?? envSeconds(MIN_SPACING_ENV, env) ?? DEFAULT_MIN_SPACING_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffCapMs = options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    this.defaultMaxWaitMs = options.defaultMaxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.now = options.now ?? (() => Date.now());
    this.sleepFn = options.sleep;
    this.signal = options.signal;
    this.log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  }

  setDeadline(deadline: number | undefined): void {
    this.deadline = deadline;
  }

  setSignal(signal: AbortSignal | undefined): void {
    this.signal = signal;
  }

  readonly exec: QueuedExec = Object.assign((args: string[]) => this.run(args), {
    setDeadline: (deadline: number | undefined) => {
      this.setDeadline(deadline);
    },
    setSignal: (signal: AbortSignal | undefined) => {
      this.setSignal(signal);
    },
  });

  /** Sleep that ends early (by throwing) when the abort signal fires. */
  private async nap(ms: number): Promise<void> {
    const signal = this.signal;
    if (signal?.aborted === true) {
      throw new QueueAbortedError();
    }
    if (this.sleepFn !== undefined) {
      await this.sleepFn(ms);
    } else {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done(): void {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
      });
    }
    if (this.signal?.aborted === true) {
      throw new QueueAbortedError();
    }
  }

  private cooldownFile(): string {
    return join(this.dir, `cooldown-${this.scope}.json`);
  }

  private async run(args: string[]): Promise<GhExecResult> {
    await mkdir(join(this.dir, 'cache'), { recursive: true, mode: 0o700 });
    const requestStart = this.now();
    const key = createHash('sha256').update(JSON.stringify([this.scope, args])).digest('hex');
    const cacheFile = join(this.dir, 'cache', `${key}.json`);
    const lockFile = join(this.dir, 'cache', `${key}.lock`);
    const deadline = this.deadline ?? requestStart + this.defaultMaxWaitMs;
    for (;;) {
      const cached = await this.readCache(cacheFile, requestStart);
      if (cached !== undefined) {
        return { stdout: cached.stdout, stderr: '', code: 0 };
      }
      this.checkDeadline(deadline);
      // Sleeping happens here, outside any lock.
      await this.waitForCooldown(deadline);
      const token = await acquireLock(lockFile, this.now);
      if (token === undefined) {
        await this.nap(LOCK_POLL_MS);
        continue;
      }
      let slotWait: number | undefined;
      let result: GhExecResult | undefined;
      try {
        const again = await this.readCache(cacheFile, requestStart);
        if (again !== undefined) {
          return { stdout: again.stdout, stderr: '', code: 0 };
        }
        const cooling = await this.readCooldown();
        if (cooling !== undefined && cooling.until > this.now()) {
          continue; // finally releases; the wait happens at the top of the loop
        }
        slotWait = await this.claimSlot(deadline);
        if (slotWait === undefined) {
          const startedAt = this.now();
          result = await this.inner(args);
          const limit = detectRateLimit(result);
          if (limit !== undefined) {
            await this.recordLimit(limit);
            result = undefined;
          } else {
            if (result.code === 0) {
              await this.clearAttempts();
              if (this.cacheTtlMs > 0) {
                await this.writeCache(cacheFile, { startedAt, completedAt: this.now(), stdout: result.stdout });
              }
            }
            return result;
          }
        }
      } finally {
        await releaseLock(lockFile, token);
      }
      if (slotWait !== undefined) {
        await this.sleepUntil(slotWait, deadline);
      }
    }
  }

  private checkDeadline(deadline: number): void {
    if (this.signal?.aborted === true) {
      throw new QueueAbortedError();
    }
    if (this.now() > deadline) {
      throw new RateLimitTimeoutError(this.now());
    }
  }

  /**
   * An entry is shared only with callers that were already waiting while the fetch ran: it must
   * have completed at or after the caller's request start. It never serves a pre-request result.
   */
  private async readCache(file: string, requestStart: number): Promise<CacheEntry | undefined> {
    if (this.cacheTtlMs <= 0) {
      return undefined;
    }
    const entry = await readJson<CacheEntry>(file);
    if (
      entry === undefined ||
      typeof entry.completedAt !== 'number' ||
      typeof entry.startedAt !== 'number' ||
      typeof entry.stdout !== 'string' ||
      entry.completedAt < requestStart ||
      this.now() - entry.completedAt >= this.cacheTtlMs
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

  private async readCooldown(): Promise<Cooldown | undefined> {
    return readJson<Cooldown>(this.cooldownFile());
  }

  /** Sleep until `until`, but never beyond the deadline: then give up with a timeout error. */
  private async sleepUntil(until: number, deadline: number): Promise<void> {
    if (until > deadline) {
      await this.nap(Math.max(0, deadline - this.now()));
      throw new RateLimitTimeoutError(until);
    }
    await this.nap(Math.max(0, until - this.now()));
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

  /**
   * Claim the next global call slot. Returns undefined when claimed (call gh now), otherwise the
   * time to wait until; the caller sleeps with no lock held and tries again.
   */
  private async claimSlot(deadline: number): Promise<number | undefined> {
    if (this.minSpacingMs <= 0) {
      return undefined;
    }
    const lock = join(this.dir, `slot-${this.scope}.lock`);
    let token: string | undefined;
    while ((token = await acquireLock(lock, this.now)) === undefined) {
      this.checkDeadline(deadline);
      await this.nap(LOCK_POLL_MS);
    }
    try {
      const slotFile = join(this.dir, `slot-${this.scope}.json`);
      const state = await readJson<{ next?: number }>(slotFile);
      const next = state?.next ?? 0;
      if (next > this.now()) {
        return next;
      }
      await writeAtomic(slotFile, { next: this.now() + this.minSpacingMs });
      return undefined;
    } finally {
      await releaseLock(lock, token);
    }
  }

  private logResume(until: number, reason: string): void {
    if (until !== this.lastLoggedUntil) {
      this.lastLoggedUntil = until;
      this.log(`gh-watcher: GitHub ${reason}, waiting until ${new Date(until).toISOString()}`);
    }
  }

  private async clearAttempts(): Promise<void> {
    const cooldown = await this.readCooldown();
    if (cooldown !== undefined && cooldown.attempts > 0 && cooldown.until <= this.now()) {
      await writeAtomic(this.cooldownFile(), { ...cooldown, attempts: 0 });
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
    await writeAtomic(this.cooldownFile(), { until, attempts, reason } satisfies Cooldown);
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
