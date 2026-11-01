import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GhClient, type GhExec, type GhExecResult } from '../src/core/gh.js';
import { createQueuedExec, detectRateLimit, RateLimitTimeoutError, type QueueOptions } from '../src/core/queue.js';
import { waitForTerminal, type WaitOptions } from '../src/core/wait.js';

const SHA = 'a'.repeat(40);
const RATE_LIMITED: GhExecResult = {
  stdout: '',
  stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
  code: 1,
};
const SECONDARY: GhExecResult = {
  stdout: '',
  stderr: 'gh: You have exceeded a secondary rate limit. (HTTP 403)',
  code: 1,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gh-watcher-queue-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A fake clock whose sleep advances time instantly but still yields to other tasks. */
function fakeClock(start = 1_000_000): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let time = start;
  const slept: number[] = [];
  return {
    now: () => time,
    sleep: async (ms) => {
      slept.push(ms);
      time += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
    slept,
  };
}

function queueOptions(clock: ReturnType<typeof fakeClock>, extra?: Partial<QueueOptions>): QueueOptions {
  return { dir, now: clock.now, sleep: clock.sleep, log: () => undefined, ...extra };
}

function ok(stdout: string): GhExecResult {
  return { stdout, stderr: '', code: 0 };
}

describe('detectRateLimit', () => {
  it('classifies primary, secondary and unrelated failures', () => {
    expect(detectRateLimit(RATE_LIMITED)?.kind).toBe('primary');
    expect(detectRateLimit(SECONDARY)?.kind).toBe('secondary');
    expect(detectRateLimit({ stdout: '', stderr: 'HTTP 429: slow down', code: 1 })?.kind).toBe('secondary');
    expect(detectRateLimit({ stdout: '', stderr: 'retry-after: 42 (HTTP 403)', code: 1 })?.retryAfterMs).toBe(42_000);
    expect(detectRateLimit({ stdout: '', stderr: 'HTTP 403: Resource not accessible', code: 1 })).toBeUndefined();
    expect(detectRateLimit({ stdout: '', stderr: 'HTTP 404', code: 1 })).toBeUndefined();
    expect(detectRateLimit(ok('x'))).toBeUndefined();
  });
});

describe('shared queue', () => {
  it('single-flights concurrent clients asking the same thing', async () => {
    const clock = fakeClock();
    let calls = 0;
    const inner: GhExec = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return ok('[]');
    };
    const first = createQueuedExec(inner, queueOptions(clock));
    const second = createQueuedExec(inner, queueOptions(clock));
    const results = await Promise.all([first(['run', 'list']), second(['run', 'list']), first(['run', 'list'])]);
    expect(calls).toBe(1);
    expect(results.map((r) => r.stdout)).toEqual(['[]', '[]', '[]']);
  });

  it('serves repeats from the cache until the TTL passes, and different args separately', async () => {
    const clock = fakeClock();
    let calls = 0;
    const inner: GhExec = async () => {
      calls += 1;
      return ok(String(calls));
    };
    const exec = createQueuedExec(inner, queueOptions(clock, { cacheTtlMs: 10_000, minSpacingMs: 0 }));
    await exec(['a']);
    await exec(['a']);
    await exec(['b']);
    expect(calls).toBe(2);
    await clock.sleep(10_001);
    await exec(['a']);
    expect(calls).toBe(3);
  });

  it('does not cache failures and keeps cache files private and token free', async () => {
    const clock = fakeClock();
    let calls = 0;
    const inner: GhExec = async () => {
      calls += 1;
      return calls === 1 ? { stdout: '', stderr: 'HTTP 404', code: 1 } : ok('fine');
    };
    const exec = createQueuedExec(inner, queueOptions(clock, { minSpacingMs: 0 }));
    expect((await exec(['x'])).code).toBe(1);
    expect((await exec(['x'])).stdout).toBe('fine');
    const cacheDir = join(dir, 'queue', 'cache');
    const files = (await readdir(cacheDir)).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect((await stat(join(cacheDir, files[0] as string))).mode & 0o777).toBe(0o600);
    expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
    const body = await readFile(join(cacheDir, files[0] as string), 'utf8');
    expect(Object.keys(JSON.parse(body) as object).sort()).toEqual(['stdout', 'storedAt']);
  });

  it('spaces calls across clients by the minimum spacing', async () => {
    const clock = fakeClock();
    const times: number[] = [];
    const inner: GhExec = async () => {
      times.push(clock.now());
      return ok('');
    };
    const first = createQueuedExec(inner, queueOptions(clock, { cacheTtlMs: 0, minSpacingMs: 1000 }));
    const second = createQueuedExec(inner, queueOptions(clock, { cacheTtlMs: 0, minSpacingMs: 1000 }));
    await first(['a']);
    await second(['b']);
    await first(['c']);
    expect(times).toHaveLength(3);
    expect((times[1] as number) - (times[0] as number)).toBeGreaterThanOrEqual(1000);
    expect((times[2] as number) - (times[1] as number)).toBeGreaterThanOrEqual(1000);
  });

  it('recovers a stale lock left by a dead process', async () => {
    const clock = fakeClock();
    const exec = createQueuedExec(async () => ok('done'), queueOptions(clock, { minSpacingMs: 0 }));
    await exec(['warm']);
    const { createHash } = await import('node:crypto');
    const key = createHash('sha256').update(JSON.stringify(['stuck'])).digest('hex');
    await writeFile(join(dir, 'queue', 'cache', `${key}.lock`), JSON.stringify({ pid: 2 ** 22 + 12345, at: clock.now() }));
    expect((await exec(['stuck'])).stdout).toBe('done');
  });
});

describe('rate limits', () => {
  it('honours a cooldown written by another client before calling gh', async () => {
    const clock = fakeClock();
    let hits = 0;
    const limited: GhExec = async () => {
      hits += 1;
      return SECONDARY;
    };
    const logs: string[] = [];
    const hitter = createQueuedExec(limited, queueOptions(clock, { minSpacingMs: 0, log: (l) => logs.push(l) }));
    hitter.setDeadline?.(clock.now() + 1000);
    await expect(hitter(['x'])).rejects.toBeInstanceOf(RateLimitTimeoutError);
    expect(hits).toBe(1);
    expect(logs.length).toBeGreaterThanOrEqual(1);

    const callTimes: number[] = [];
    const healthy: GhExec = async () => {
      callTimes.push(clock.now());
      return ok('fine');
    };
    const other = createQueuedExec(healthy, queueOptions(clock, { minSpacingMs: 0 }));
    const cooldown = JSON.parse(await readFile(join(dir, 'queue', 'cooldown.json'), 'utf8')) as { until: number };
    expect(cooldown.until).toBeGreaterThan(clock.now());
    expect((await other(['y'])).stdout).toBe('fine');
    expect(callTimes[0]).toBeGreaterThanOrEqual(cooldown.until);
  });

  it('backs off on a secondary limit then succeeds, logging one line per backoff', async () => {
    const clock = fakeClock();
    const responses = [SECONDARY, SECONDARY, ok('fine')];
    const logs: string[] = [];
    const exec = createQueuedExec(
      async () => responses.shift() as GhExecResult,
      queueOptions(clock, { minSpacingMs: 0, log: (l) => logs.push(l) }),
    );
    const start = clock.now();
    expect((await exec(['x'])).stdout).toBe('fine');
    expect(clock.now() - start).toBeGreaterThanOrEqual(60_000 + 120_000);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/waiting until \d{4}-\d\d-\d\dT/);
  });

  it('takes the primary reset time from gh api rate_limit', async () => {
    const clock = fakeClock(1_700_000_000_000);
    const reset = Math.floor(clock.now() / 1000) + 300;
    const calls: string[][] = [];
    let limitedOnce = false;
    const inner: GhExec = async (args) => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'rate_limit') {
        return ok(JSON.stringify({ resources: { core: { remaining: 0, reset }, graphql: { remaining: 9, reset: 1 } } }));
      }
      if (!limitedOnce) {
        limitedOnce = true;
        return RATE_LIMITED;
      }
      return ok('fine');
    };
    const exec = createQueuedExec(inner, queueOptions(clock, { minSpacingMs: 0 }));
    expect((await exec(['run', 'list'])).stdout).toBe('fine');
    expect(clock.now()).toBeGreaterThanOrEqual(reset * 1000);
    expect(calls.filter((c) => c[0] === 'api')).toHaveLength(1);
  });

  it('returns the 124 path when the wait times out during a backoff', async () => {
    const clock = fakeClock(Date.now()); // the wait computes its deadline from the real clock
    const client = new GhClient({ exec: createQueuedExec(async () => SECONDARY, queueOptions(clock, { minSpacingMs: 0 })) });
    const options: WaitOptions = {
      repo: 'o/r',
      target: { kind: 'commit', sha: SHA },
      intervalMs: 1000,
      timeoutMs: 30_000,
      fallbackMs: 60_000,
      source: 'poll',
    };
    const start = clock.now();
    const result = await waitForTerminal(options, { client, sleep: clock.sleep, log: () => undefined });
    expect(result).toEqual({ kind: 'timeout', source: 'poll' });
    expect(clock.now() - start).toBeLessThanOrEqual(31_000);
  });
});
