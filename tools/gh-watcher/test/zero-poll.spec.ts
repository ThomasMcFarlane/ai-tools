import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_POLL_MIN_MS,
  EtagStore,
  followTarget,
  GhClient,
  parseHttpResponse,
  waitForTerminal,
  type FollowLine,
  type GhExec,
  type GhExecResult,
  type WaitOptions,
} from '../src/index.js';
import { restCheckRunsBody, restJobsBody, restRunsBody, restStatusBody } from './rest-fixtures.js';

const SHA = 'a'.repeat(40);
const REPO = 'octo-org/hello-world';
const RUNS_PATH = `repos/${REPO}/actions/runs?head_sha=${SHA}&per_page=100`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gh-watcher-etag-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function withHeaders(status: string, headers: Record<string, string>, body: string): string {
  const head = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
  return [`HTTP/2.0 ${status}`, ...head, '', body].join('\r\n');
}

const run = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  databaseId: 1,
  workflowName: 'CI',
  displayTitle: 't',
  status: 'completed',
  conclusion: 'success',
  url: 'https://example.invalid/runs/1',
  headSha: SHA,
  createdAt: '2026-01-01T00:00:00Z',
  startedAt: '2026-01-01T00:00:05Z',
  updatedAt: '2026-01-01T00:05:00Z',
  attempt: 2,
  ...over,
});

describe('parseHttpResponse', () => {
  it('splits status, lower-cased headers and body', () => {
    const parsed = parseHttpResponse(withHeaders('200 OK', { ETag: 'W/"x"', 'X-RateLimit-Remaining': '42' }, '{"a":1}'));
    expect(parsed?.status).toBe(200);
    expect(parsed?.headers.get('etag')).toBe('W/"x"');
    expect(parsed?.headers.get('x-ratelimit-remaining')).toBe('42');
    expect(parsed?.body).toBe('{"a":1}');
  });

  it('returns undefined for plain output', () => {
    expect(parseHttpResponse('{"a":1}')).toBeUndefined();
  });
});

describe('REST run listing', () => {
  it('uses one api call and maps REST fields to the gh shape', async () => {
    const calls: string[][] = [];
    const exec: GhExec = async (args) => {
      calls.push(args);
      return { stdout: restRunsBody([run()]), stderr: '', code: 0 };
    };
    const runs = await new GhClient({ exec, detailedRuns: true }).listRuns(REPO, { kind: 'commit', sha: SHA });
    expect(calls).toEqual([['api', RUNS_PATH, '-i']]);
    expect(runs).toEqual([
      {
        databaseId: 1,
        workflowName: 'CI',
        displayTitle: 't',
        status: 'completed',
        conclusion: 'success',
        url: 'https://example.invalid/runs/1',
        headSha: SHA,
        createdAt: '2026-01-01T00:00:00Z',
        startedAt: '2026-01-01T00:00:05Z',
        updatedAt: '2026-01-01T00:05:00Z',
        attempt: 2,
      },
    ]);
  });

  it('leaves out the detailed fields unless asked for', async () => {
    const exec: GhExec = async () => ({ stdout: restRunsBody([run()]), stderr: '', code: 0 });
    const [first] = await new GhClient({ exec }).listRuns(REPO, { kind: 'commit', sha: SHA });
    expect(first).not.toHaveProperty('updatedAt');
    expect(first).not.toHaveProperty('attempt');
    expect(first?.createdAt).toBe('2026-01-01T00:00:00Z');
  });

  it('lists by branch with an encoded name', async () => {
    const calls: string[][] = [];
    const exec: GhExec = async (args) => {
      calls.push(args);
      return { stdout: args[1]?.includes('/branches/') ? `${SHA}\n` : restRunsBody([]), stderr: '', code: 0 };
    };
    await new GhClient({ exec }).listRuns(REPO, { kind: 'branch', branch: 'feat/a b' });
    expect(calls[1]?.[1]).toBe(`repos/${REPO}/actions/runs?head_sha=${SHA}&per_page=100`);
    const fallback: GhExec = async (args) => {
      calls.push(args);
      return args[1]?.includes('/branches/') ? { stdout: '', stderr: 'Not Found', code: 1 } : { stdout: restRunsBody([]), stderr: '', code: 0 };
    };
    await new GhClient({ exec: fallback }).listRuns(REPO, { kind: 'branch', branch: 'feat/a b' });
    expect(calls.at(-1)?.[1]).toBe(`repos/${REPO}/actions/runs?branch=feat%2Fa%20b&per_page=100`);
  });

  it('reads all pages of check runs and jobs when the first page is partial', async () => {
    const calls: string[][] = [];
    const item = (id: number): Record<string, unknown> => ({
      id, name: `c${id}`, status: 'completed', conclusion: 'success', html_url: 'u', started_at: 's', completed_at: 'e', app: { slug: 'x' },
    });
    const exec: GhExec = async (args) => {
      calls.push(args);
      if (args.includes('--paginate')) {
        return { stdout: [item(1), item(2)].map((i) => JSON.stringify(i)).join('\n'), stderr: '', code: 0 };
      }
      const status = args[1]?.includes('/status') === true;
      return { stdout: JSON.stringify(status ? { total_count: 0, statuses: [] } : { total_count: 2, check_runs: [item(1)] }), stderr: '', code: 0 };
    };
    const result = await new GhClient({ exec }).listChecks(REPO, { kind: 'commit', sha: SHA });
    expect(result.checks.map((check) => check.name)).toEqual(['c1', 'c2']);
    expect(calls.filter((c) => c.includes('--paginate'))).toHaveLength(1);
  });
});

describe('conditional requests', () => {
  it('sends If-None-Match from the stored ETag and reuses the body on 304, across processes', async () => {
    const calls: string[][] = [];
    const exec: GhExec = async (args) => {
      calls.push(args);
      if (args.includes('If-None-Match: "v1"')) {
        return { stdout: withHeaders('304 Not Modified', { ETag: '"v1"' }, ''), stderr: 'gh: HTTP 304', code: 1 };
      }
      return { stdout: withHeaders('200 OK', { ETag: '"v1"' }, restRunsBody([run()])), stderr: '', code: 0 };
    };
    const first = new GhClient({ exec, etagStore: new EtagStore({ dir }) });
    const second = new GhClient({ exec, etagStore: new EtagStore({ dir }) }); // a separate process on the same host
    const a = await first.listRuns(REPO, { kind: 'commit', sha: SHA });
    const b = await second.listRuns(REPO, { kind: 'commit', sha: SHA });
    expect(b).toEqual(a);
    expect(calls[0]).toEqual(['api', RUNS_PATH, '-i']);
    expect(calls[1]).toEqual(['api', RUNS_PATH, '-i', '-H', 'If-None-Match: "v1"']);
  });

  it('accepts a 304 that gh reports with exit code 0', async () => {
    let call = 0;
    const exec: GhExec = async () => {
      call += 1;
      return call === 1
        ? { stdout: withHeaders('200 OK', { ETag: '"v1"' }, restJobsBody([{ name: 'build', status: 'completed', conclusion: 'success' }])), stderr: '', code: 0 }
        : { stdout: withHeaders('304 Not Modified', {}, ''), stderr: '', code: 0 };
    };
    const client = new GhClient({ exec, etagStore: new EtagStore({ dir }) });
    await client.runJobs(REPO, 5);
    expect((await client.runJobs(REPO, 5))[0]?.name).toBe('build');
  });

  it('replaces the stored body when the response changes', async () => {
    let etag = 0;
    const exec: GhExec = async () => {
      etag += 1;
      const body = restRunsBody([run({ databaseId: etag })]);
      return { stdout: withHeaders('200 OK', { ETag: `"v${etag}"` }, body), stderr: '', code: 0 };
    };
    const store = new EtagStore({ dir });
    const client = new GhClient({ exec, etagStore: store });
    await client.listRuns(REPO, { kind: 'commit', sha: SHA });
    await client.listRuns(REPO, { kind: 'commit', sha: SHA });
    expect((await store.get(RUNS_PATH))?.etag).toBe('"v2"');
  });

  it('covers check runs and statuses, and keeps tokens out of the store files', async () => {
    const calls: string[][] = [];
    const exec: GhExec = async (args) => {
      calls.push(args);
      const body = args[1]?.includes('/check-runs') ? restCheckRunsBody([]) : restStatusBody([]);
      return args.includes('-H')
        ? { stdout: withHeaders('304 Not Modified', {}, ''), stderr: '', code: 1 }
        : { stdout: withHeaders('200 OK', { ETag: '"e"' }, body), stderr: '', code: 0 };
    };
    const client = new GhClient({ exec, etagStore: new EtagStore({ dir }, { GH_TOKEN: 'secret-token-value' }) });
    await client.listChecks(REPO, { kind: 'commit', sha: SHA });
    await client.listChecks(REPO, { kind: 'commit', sha: SHA });
    expect(calls.filter((c) => c.includes('-H'))).toHaveLength(2);
    for (const name of await readdir(join(dir, 'etag'))) {
      expect(await readFile(join(dir, 'etag', name), 'utf8')).not.toContain('secret-token-value');
    }
  });

  it('keeps entries of different accounts apart', async () => {
    const one = new EtagStore({ dir }, { GH_TOKEN: 'one' });
    const two = new EtagStore({ dir }, { GH_TOKEN: 'two' });
    await one.set('p', { etag: '"1"', body: 'x' });
    expect(await two.get('p')).toBeUndefined();
    expect(await one.get('p')).toEqual({ etag: '"1"', body: 'x' });
  });
});

describe('low budget', () => {
  const lowExec = (remaining: string): GhExec => async (args) => {
    const path = args[1] ?? '';
    const body = path.includes('/check-runs')
      ? restCheckRunsBody([])
      : path.includes('/status')
        ? restStatusBody([])
        : restRunsBody([run({ status: 'in_progress', conclusion: null })]);
    return { stdout: withHeaders('200 OK', { 'X-RateLimit-Remaining': remaining }, body), stderr: '', code: 0 };
  };

  it('reports a low budget below the threshold and logs once', async () => {
    const logs: string[] = [];
    const client = new GhClient({ exec: lowExec('120'), log: (l) => logs.push(l), minRemaining: 500 });
    expect(client.pollFactor()).toBe(1);
    await client.listRuns(REPO, { kind: 'commit', sha: SHA });
    await client.listRuns(REPO, { kind: 'commit', sha: SHA });
    expect(client.isLowBudget()).toBe(true);
    expect(client.pollFactor()).toBe(4);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('120 left');
  });

  it('stays normal at or above the threshold', async () => {
    const client = new GhClient({ exec: lowExec('500'), log: () => undefined, minRemaining: 500 });
    await client.listRuns(REPO, { kind: 'commit', sha: SHA });
    expect(client.pollFactor()).toBe(1);
  });

  it('reads the threshold from GH_WATCHER_MIN_REMAINING', async () => {
    process.env['GH_WATCHER_MIN_REMAINING'] = '50';
    try {
      const client = new GhClient({ exec: lowExec('120'), log: () => undefined });
      await client.listRuns(REPO, { kind: 'commit', sha: SHA });
      expect(client.isLowBudget()).toBe(false);
    } finally {
      delete process.env['GH_WATCHER_MIN_REMAINING'];
    }
  });

  it('makes a polling wait sleep four times longer', async () => {
    const sleeps: number[] = [];
    const client = new GhClient({ exec: lowExec('10'), log: () => undefined });
    const options: WaitOptions = {
      repo: REPO, target: { kind: 'commit', sha: SHA }, intervalMs: 1000, timeoutMs: 3_600_000, fallbackMs: 300_000, source: 'poll',
    };
    await waitForTerminal(options, {
      client,
      log: () => undefined,
      sleep: async (ms) => {
        sleeps.push(ms);
        throw new Error('stop');
      },
    }).catch(() => undefined);
    expect(sleeps[0]).toBe(4000);
  });
});

describe('poll fallback when the relay is down', () => {
  const pending = async (): Promise<GhExecResult> => ({
    stdout: restRunsBody([run({ status: 'in_progress', conclusion: null })]),
    stderr: '',
    code: 0,
  });
  const exec: GhExec = async (args) => {
    if (args[1]?.includes('/check-runs')) {
      return { stdout: restCheckRunsBody([]), stderr: '', code: 0 };
    }
    if (args[1]?.includes('/status')) {
      return { stdout: restStatusBody([]), stderr: '', code: 0 };
    }
    return pending();
  };
  const down = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;

  async function sleepsFor(source: 'auto' | 'poll'): Promise<{ sleeps: number[]; logs: string[] }> {
    const sleeps: number[] = [];
    const logs: string[] = [];
    const options: WaitOptions = {
      repo: REPO, target: { kind: 'commit', sha: SHA }, intervalMs: 30_000, timeoutMs: 3_600_000, fallbackMs: 300_000, source, eventsUrl: 'https://relay.invalid',
    };
    await waitForTerminal(options, {
      client: new GhClient({ exec, detailedRuns: true }),
      fetchFn: down,
      log: (line) => logs.push(line),
      sleep: async (ms) => {
        sleeps.push(ms);
        throw new Error('stop');
      },
    }).catch(() => undefined);
    return { sleeps, logs };
  }

  it('warns and polls no faster than 2 minutes in auto mode', async () => {
    const { sleeps, logs } = await sleepsFor('auto');
    expect(logs).toContain('gh-watcher: WARNING relay unreachable at https://relay.invalid, polling GitHub');
    expect(sleeps[0]).toBe(AUTO_POLL_MIN_MS);
  });

  it('keeps the given interval for an explicit poll source', async () => {
    const { sleeps, logs } = await sleepsFor('poll');
    expect(logs.some((line) => line.includes('WARNING'))).toBe(false);
    expect(sleeps[0]).toBe(30_000);
  });
});

describe('follow job fetches', () => {
  it('fetches jobs again only when the run changed', async () => {
    const jobCalls: string[] = [];
    let round = 0;
    const exec: GhExec = async (args) => {
      const path = args[1] ?? '';
      if (path.includes('/check-runs')) {
        return { stdout: restCheckRunsBody([]), stderr: '', code: 0 };
      }
      if (path.includes('/status')) {
        return { stdout: restStatusBody([]), stderr: '', code: 0 };
      }
      if (path.includes('/jobs')) {
        jobCalls.push(path);
        return { stdout: restJobsBody([{ name: 'build', status: 'in_progress', conclusion: null }]), stderr: '', code: 0 };
      }
      round += 1;
      // Rounds 1 to 3 report the same updatedAt; round 4 changes it; round 5 completes.
      const updatedAt = round <= 3 ? '2026-01-01T00:01:00Z' : '2026-01-01T00:02:00Z';
      return {
        stdout: restRunsBody([run(round >= 5 ? { updatedAt } : { status: 'in_progress', conclusion: null, updatedAt })]),
        stderr: '',
        code: 0,
      };
    };
    const lines: FollowLine[] = [];
    await followTarget(
      { repo: REPO, target: { kind: 'commit', sha: SHA }, intervalMs: 1, timeoutMs: 60_000, fallbackMs: 1000, source: 'poll' },
      { client: new GhClient({ exec, detailedRuns: true }), sleep: async () => {}, emit: (line) => lines.push(line) },
    );
    expect(lines.length).toBeGreaterThanOrEqual(5);
    // Round 1 fetches; rounds 2 and 3 reuse; round 4 (updatedAt changed) and 5 (completed) fetch again.
    expect(jobCalls).toHaveLength(3);
  });
});
