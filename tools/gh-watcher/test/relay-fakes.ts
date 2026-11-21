/** Fakes for the relay: no network and no GitHub. */

export const SHA = 'a'.repeat(40);
export const REPO = 'octo-org/hello-world';

export type FakeReply = Record<string, unknown> | Error | { status: number; body?: string };

export interface FakeRelay {
  fetchFn: typeof fetch;
  urls: URL[];
}

/** Serves the replies in order; the last one repeats. An Error rejects like a network failure. */
export function fakeRelay(replies: FakeReply[], onFetch?: () => void): FakeRelay {
  const urls: URL[] = [];
  let index = 0;
  const fetchFn = (async (input: URL | string): Promise<Response> => {
    urls.push(new URL(String(input)));
    onFetch?.();
    const reply = replies[Math.min(index, replies.length - 1)] as FakeReply;
    index += 1;
    if (reply instanceof Error) {
      throw reply;
    }
    if ('status' in reply && typeof reply['status'] === 'number') {
      return new Response((reply as { body?: string }).body ?? '', { status: reply['status'] });
    }
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchFn, urls };
}

export function run(id: number, status: string, conclusion: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `W${id}`,
    status,
    conclusion,
    run_attempt: 1,
    html_url: `https://example.com/run/${id}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:01:00Z',
    head_sha: SHA,
    display_title: 't',
    ...extra,
  };
}

export function snapshot(rev: number, runs: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: REPO,
    target: { kind: 'commit', value: SHA },
    sha: SHA,
    rev,
    changed: true,
    owner_mode: 'app',
    source: 'webhook',
    fetched_at: '2026-01-01T00:02:00Z',
    boot: 'boot-1',
    stale: false,
    error: null,
    runs,
    check_runs: [],
    statuses: [],
    ...extra,
  };
}

/** The relay's /api/pr-status shape: latest items only, `user` for the author, no `title` or `closed_at`. */
export function prStatus(rev: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: REPO,
    pr: 7,
    rev,
    changed: true,
    owner_mode: 'app',
    source: 'webhook',
    fetched_at: '2026-01-01T00:02:00Z',
    boot: 'boot-1',
    stale: false,
    error: null,
    state: 'open',
    draft: false,
    html_url: 'https://example.com/pull/7',
    head_sha: SHA,
    head_ref: 'feature',
    base_ref: 'main',
    updated_at: '2026-01-01T00:01:00Z',
    merged_at: null,
    review_decision: null,
    latest_comment: null,
    latest_review_comment: null,
    latest_review: null,
    ...extra,
  };
}

/** A sleep that records its delays and returns at once; advances a fake clock. */
export function fakeClock(start = 1_000_000): { now: () => number; sleep: (ms: number) => Promise<void>; delays: number[] } {
  let t = start;
  const delays: number[] = [];
  return {
    now: () => t,
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
      t += ms;
    },
  };
}
