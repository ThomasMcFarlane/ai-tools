/** Client for a private webhook relay that serves GitHub `workflow_run` events (see README, "Event mode"). */

export const EVENTS_URL_ENV = 'GH_WATCHER_EVENTS_URL';
export const MAX_EVENT_WAIT_SECONDS = 25;

export interface RunEvent {
  seq: number;
  received_at?: string;
  action?: string;
  repo?: string;
  run_id?: number;
  run_attempt?: number;
  workflow_name?: string;
  head_sha: string;
  head_branch?: string;
  status?: string;
  conclusion?: string | null;
  event?: string;
  html_url?: string;
  updated_at?: string;
  pull_requests?: unknown;
}

export interface RunsResponse {
  repo?: string;
  owner_mode: 'app' | 'poll' | 'unknown';
  workflow_run_subscribed: boolean;
  latest_seq: number;
  buffer_started_at?: string;
  events: RunEvent[];
}

export interface FetchRunsParams {
  baseUrl: string;
  repo: string;
  sha: string;
  after: number;
  waitSeconds: number;
  fetchFn?: typeof fetch;
}

export interface PrRelayEvent {
  seq: number;
  received_at?: string;
  event?: 'pull_request' | 'issue_comment' | 'pull_request_review' | 'pull_request_review_comment';
  action?: string;
  repo?: string;
  pr?: number;
  head_sha?: string;
  head_ref?: string;
  merged?: boolean;
  draft?: boolean;
  actor?: string;
  html_url?: string;
  updated_at?: string;
}

export interface PrEventsResponse {
  repo?: string;
  owner_mode: 'app' | 'poll' | 'unknown';
  pr_events_subscribed: boolean;
  latest_seq: number;
  buffer_started_at?: string;
  events: PrRelayEvent[];
}

export interface FetchPrEventsParams {
  baseUrl: string;
  repo: string;
  pr?: number;
  headRef?: string;
  after: number;
  waitSeconds: number;
  fetchFn?: typeof fetch;
}

export function resolveEventsUrl(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = (flag ?? env[EVENTS_URL_ENV])?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

async function getJson(url: URL, waitSeconds: number, fetchFn: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, (waitSeconds + 10) * 1000);
  try {
    const response = await fetchFn(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`event source returned HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('event source timed out');
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

function clampWait(waitSeconds: number): number {
  return Math.max(0, Math.min(MAX_EVENT_WAIT_SECONDS, Math.floor(waitSeconds)));
}

function endpoint(baseUrl: string, path: string): URL {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
}

/** Fetch events after a sequence number, long-polling up to waitSeconds. Throws on any failure. */
export async function fetchRuns(params: FetchRunsParams): Promise<RunsResponse> {
  const waitSeconds = clampWait(params.waitSeconds);
  const url = endpoint(params.baseUrl, 'api/runs');
  url.searchParams.set('repo', params.repo);
  url.searchParams.set('sha', params.sha);
  url.searchParams.set('after', String(params.after));
  url.searchParams.set('wait', String(waitSeconds));
  return parseRunsResponse(await getJson(url, waitSeconds, params.fetchFn ?? fetch));
}

/** Fetch pull request events after a sequence number, long-polling up to waitSeconds. Throws on any failure. */
export async function fetchPrEvents(params: FetchPrEventsParams): Promise<PrEventsResponse> {
  const waitSeconds = clampWait(params.waitSeconds);
  const url = endpoint(params.baseUrl, 'api/prs');
  url.searchParams.set('repo', params.repo);
  if (params.pr !== undefined) {
    url.searchParams.set('pr', String(params.pr));
  }
  if (params.headRef !== undefined) {
    url.searchParams.set('head_ref', params.headRef);
  }
  url.searchParams.set('after', String(params.after));
  url.searchParams.set('wait', String(waitSeconds));
  return parsePrEventsResponse(await getJson(url, waitSeconds, params.fetchFn ?? fetch));
}

export function parseRunsResponse(raw: unknown): RunsResponse {
  const record = raw as Partial<RunsResponse> | null;
  if (
    record === null ||
    typeof record !== 'object' ||
    typeof record.latest_seq !== 'number' ||
    !Array.isArray(record.events) ||
    !record.events.every((event) => event !== null && typeof event === 'object' && typeof (event as RunEvent).seq === 'number')
  ) {
    throw new Error('event source returned a malformed response');
  }
  const mode = record.owner_mode;
  return {
    ...record,
    owner_mode: mode === 'app' || mode === 'poll' ? mode : 'unknown',
    workflow_run_subscribed: record.workflow_run_subscribed === true,
    latest_seq: record.latest_seq,
    events: record.events,
  };
}

export function parsePrEventsResponse(raw: unknown): PrEventsResponse {
  const record = raw as Partial<PrEventsResponse> | null;
  if (
    record === null ||
    typeof record !== 'object' ||
    typeof record.latest_seq !== 'number' ||
    !Array.isArray(record.events) ||
    !record.events.every((event) => event !== null && typeof event === 'object' && typeof (event as PrRelayEvent).seq === 'number')
  ) {
    throw new Error('event source returned a malformed response');
  }
  const mode = record.owner_mode;
  return {
    ...record,
    owner_mode: mode === 'app' || mode === 'poll' ? mode : 'unknown',
    pr_events_subscribed: record.pr_events_subscribed === true,
    latest_seq: record.latest_seq,
    events: record.events,
  };
}
