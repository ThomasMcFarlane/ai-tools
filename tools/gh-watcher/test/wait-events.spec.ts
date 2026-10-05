import { describe, expect, it } from 'vitest';
import { GhClient, resolveEventsUrl, waitForTerminal, type GhExec, type WaitOptions } from '../src/index.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BASE = 'https://events.invalid';

function run(status: string, conclusion: string | null): string {
  return JSON.stringify([
    {
      databaseId: 1,
      workflowName: 'CI',
      displayTitle: 't',
      status,
      conclusion,
      url: 'u',
      headSha: SHA,
      createdAt: '2026-01-01T00:00:00Z',
    },
  ]);
}

/** Scripted gh: `runs` is consumed one entry per `run list` call, the last entry repeating. */
function fakeGh(runs: string[]): { client: GhClient; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  const exec: GhExec = async (args) => {
    calls.push(args);
    if (args[0] === 'pr') {
      return { stdout: JSON.stringify({ headRefOid: SHA, headRefName: 'x' }), stderr: '', code: 0 };
    }
    if (args[0] === 'run' && args[1] === 'list') {
      const stdout = runs[Math.min(index, runs.length - 1)] as string;
      index += 1;
      return { stdout, stderr: '', code: 0 };
    }
    if (args[0] === 'run' && args[1] === 'view') {
      return { stdout: JSON.stringify({ jobs: [] }), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: 'unexpected', code: 1 };
  };
  return { client: new GhClient({ exec }), calls };
}

interface Reply {
  latest_seq: number;
  owner_mode?: string;
  workflow_run_subscribed?: boolean;
  events?: { seq: number; head_sha: string }[];
  delayMs?: number;
}
type Responder = (url: URL, call: number) => Reply | Response | Error;

function fakeFetch(responder: Responder): { fetchFn: typeof fetch; urls: URL[] } {
  const urls: URL[] = [];
  const fetchFn = (async (input: URL | string) => {
    const url = new URL(String(input));
    urls.push(url);
    const reply = responder(url, urls.length - 1);
    if (reply instanceof Error) {
      throw reply;
    }
    if (reply instanceof Response) {
      return reply;
    }
    await new Promise((resolve) => setTimeout(resolve, reply.delayMs ?? 5));
    return new Response(
      JSON.stringify({
        repo: 'o/r',
        owner_mode: reply.owner_mode ?? 'app',
        workflow_run_subscribed: reply.workflow_run_subscribed ?? true,
        latest_seq: reply.latest_seq,
        events: reply.events ?? [],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, urls };
}

function options(overrides?: Partial<WaitOptions>): WaitOptions {
  return {
    repo: 'o/r',
    target: { kind: 'commit', sha: SHA },
    intervalMs: 5,
    timeoutMs: 2000,
    fallbackMs: 60_000,
    source: 'auto',
    eventsUrl: BASE,
    ...overrides,
  };
}

const quiet = { log: () => undefined, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))) };

describe('event mode wait', () => {
  it('re-checks on a matching event and succeeds with few gh calls', async () => {
    const gh = fakeGh([run('in_progress', null), run('completed', 'success')]);
    const { fetchFn, urls } = fakeFetch((_url, call) =>
      call === 0 ? { latest_seq: 4 } : { latest_seq: 5, events: [{ seq: 5, head_sha: SHA }] },
    );
    const result = await waitForTerminal(options(), { ...quiet, client: gh.client, fetchFn });
    expect(result).toMatchObject({ kind: 'terminal', source: 'events', report: { state: 'success' } });
    expect(urls[1]?.searchParams.get('after')).toBe('4');
    expect(urls[1]?.searchParams.get('sha')).toBe(SHA);
    expect(gh.calls.length).toBeLessThanOrEqual(3);
    expect(gh.calls).toHaveLength(2);
  });

  it('keeps gh calls to 3 for a PR target', async () => {
    const gh = fakeGh([run('in_progress', null), run('completed', 'success')]);
    const { fetchFn } = fakeFetch((_u, call) =>
      call === 0 ? { latest_seq: 0 } : { latest_seq: 1, events: [{ seq: 1, head_sha: SHA }] },
    );
    const result = await waitForTerminal(options({ target: { kind: 'pr', number: 7 } }), {
      ...quiet,
      client: gh.client,
      fetchFn,
    });
    expect(result.kind).toBe('terminal');
    expect(gh.calls).toHaveLength(3);
  });

  it('exits straight away when the initial check is terminal', async () => {
    const gh = fakeGh([run('completed', 'failure'), run('completed', 'failure')]);
    const { fetchFn, urls } = fakeFetch(() => ({ latest_seq: 0 }));
    const result = await waitForTerminal(options(), { ...quiet, client: gh.client, fetchFn });
    expect(result).toMatchObject({ kind: 'terminal', source: 'events', report: { state: 'failure' } });
    expect(urls).toHaveLength(1);
  });

  it('ignores events for another sha', async () => {
    const gh = fakeGh([run('in_progress', null)]);
    const { fetchFn } = fakeFetch((_u, call) =>
      call === 0 ? { latest_seq: 0 } : { latest_seq: call, events: [{ seq: call, head_sha: OTHER }] },
    );
    const result = await waitForTerminal(options({ timeoutMs: 80 }), { ...quiet, client: gh.client, fetchFn });
    expect(result).toEqual({ kind: 'timeout', source: 'events' });
    expect(gh.calls).toHaveLength(1);
  });

  it('re-checks on the fallback interval without events', async () => {
    const gh = fakeGh([run('in_progress', null), run('completed', 'success')]);
    const { fetchFn } = fakeFetch(() => ({ latest_seq: 0 }));
    const result = await waitForTerminal(options({ fallbackMs: 30 }), { ...quiet, client: gh.client, fetchFn });
    expect(result).toMatchObject({ kind: 'terminal', source: 'events', report: { state: 'success' } });
    expect(gh.calls).toHaveLength(2);
  });

  it('resets after and re-checks immediately when latest_seq goes backwards', async () => {
    const gh = fakeGh([run('in_progress', null), run('completed', 'success')]);
    const { fetchFn, urls } = fakeFetch((_u, call) => (call === 0 ? { latest_seq: 50 } : { latest_seq: 2 }));
    const result = await waitForTerminal(options(), { ...quiet, client: gh.client, fetchFn });
    expect(result.kind).toBe('terminal');
    expect(urls[1]?.searchParams.get('after')).toBe('50');
    expect(gh.calls).toHaveLength(2);
  });

  it('degrades to polling for the rest of the wait when the endpoint fails mid-wait', async () => {
    const gh = fakeGh([run('in_progress', null), run('in_progress', null), run('completed', 'success')]);
    const logs: string[] = [];
    const { fetchFn } = fakeFetch((_u, call) => (call === 0 ? { latest_seq: 0 } : new Response('busy', { status: 503 })));
    const result = await waitForTerminal(options(), { ...quiet, log: (l) => logs.push(l), client: gh.client, fetchFn });
    expect(result).toMatchObject({ kind: 'terminal', source: 'poll' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('503');
  });

  it.each([
    ['network error', () => new Error('ECONNREFUSED')],
    ['5xx', () => new Response('x', { status: 502 })],
    ['malformed body', () => new Response('{"nope":true}', { status: 200 })],
  ])('polls when the probe hits a %s', async (_name, make) => {
    const gh = fakeGh([run('completed', 'success')]);
    const logs: string[] = [];
    const { fetchFn } = fakeFetch(() => make());
    const result = await waitForTerminal(options(), { ...quiet, log: (l) => logs.push(l), client: gh.client, fetchFn });
    expect(result).toMatchObject({ kind: 'terminal', source: 'poll' });
    expect(logs).toHaveLength(1);
  });

  it('polls when owner_mode is poll', async () => {
    const gh = fakeGh([run('completed', 'success')]);
    const { fetchFn, urls } = fakeFetch(() => ({ latest_seq: 0, owner_mode: 'poll' }));
    const result = await waitForTerminal(options(), { ...quiet, client: gh.client, fetchFn });
    expect(result).toMatchObject({ kind: 'terminal', source: 'poll' });
    expect(urls).toHaveLength(1);
  });

  it('polls when workflow_run is not subscribed', async () => {
    const gh = fakeGh([run('completed', 'success')]);
    const { fetchFn } = fakeFetch(() => ({ latest_seq: 0, workflow_run_subscribed: false }));
    const result = await waitForTerminal(options(), { ...quiet, client: gh.client, fetchFn });
    expect(result).toMatchObject({ kind: 'terminal', source: 'poll' });
  });

  it('polls without touching the network when no URL is configured or source is poll', async () => {
    const gh = fakeGh([run('completed', 'success')]);
    const { fetchFn, urls } = fakeFetch(() => ({ latest_seq: 0 }));
    await waitForTerminal(options({ eventsUrl: undefined }), { ...quiet, client: gh.client, fetchFn });
    await waitForTerminal(options({ source: 'poll' }), { ...quiet, client: gh.client, fetchFn });
    expect(urls).toHaveLength(0);
  });

  it('rejects --source events without a URL', async () => {
    await expect(
      waitForTerminal(options({ source: 'events', eventsUrl: undefined }), { ...quiet, client: fakeGh([]).client }),
    ).rejects.toThrow(/events URL/);
  });

  it('times out as before', async () => {
    const gh = fakeGh([run('in_progress', null)]);
    const result = await waitForTerminal(options({ source: 'poll', timeoutMs: 30 }), { ...quiet, client: gh.client });
    expect(result).toEqual({ kind: 'timeout', source: 'poll' });
  });
});

describe('resolveEventsUrl', () => {
  it('prefers the flag over the environment and ignores blanks', () => {
    expect(resolveEventsUrl('https://a', { GH_WATCHER_EVENTS_URL: 'https://b' })).toBe('https://a');
    expect(resolveEventsUrl(undefined, { GH_WATCHER_EVENTS_URL: 'https://b' })).toBe('https://b');
    expect(resolveEventsUrl(undefined, { GH_WATCHER_EVENTS_URL: ' ' })).toBeUndefined();
  });
});
