/**
 * Client for the relay's `/api/status` and `/api/pr-status` long-polls.
 *
 * gh-watcher never polls GitHub. The relay is the single central poller: it follows webhooks, and
 * it polls only for owners without webhooks. This client only talks to the relay and has no
 * fallback to `gh`.
 */
import { aggregateState, failedChecksOf, isFailureish, latestPerWorkflow, SUCCESS_CONCLUSIONS } from './check-state.js';
import { MAX_EVENT_WAIT_SECONDS } from './events.js';
import { targetKey } from './types.js';
import type {
  CheckReport,
  ExternalCheck,
  ExternalCheckStatus,
  FailedStep,
  GhJobInfo,
  GhRunInfo,
  PrComment,
  PrReview,
  PrReviewComment,
  PrSnapshot,
  PrState,
  WatchTarget,
} from './types.js';

export const BACKOFF_START_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;

export type RelaySource = 'webhook' | 'relay-poll';

export interface RelayErrorInfo {
  kind: string;
  message: string;
  retry_at: string | null;
}

/** Fields every relay snapshot carries. */
export interface RelayMeta {
  rev: number;
  changed: boolean;
  owner_mode: 'app' | 'poll' | 'unknown';
  source: RelaySource;
  fetched_at?: string;
  stale: boolean;
  /** True while the relay has not finished its first fetch for the target: the items are not final. */
  pending?: boolean;
  error: RelayErrorInfo | null;
  warning?: string;
  /** Random per relay process. A change means the relay restarted and its revisions start again. */
  boot?: string;
  /** Set by the session: true when `boot` differs from the last one seen. The caller must reset `after` to 0. */
  bootChanged?: boolean;
}

export interface RelayRunJob {
  id?: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  steps?: { number: number; name: string; status?: string; conclusion: string | null }[];
}

export interface RelayRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  run_attempt?: number;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  started_at?: string;
  head_sha?: string;
  display_title?: string;
  jobs?: RelayRunJob[];
}

export interface RelayCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  started_at?: string;
  completed_at?: string;
  app_slug?: string;
}

export interface RelayCommitStatus {
  id: number;
  context: string;
  state: string;
  target_url?: string;
  updated_at?: string;
}

export interface StatusResponse extends RelayMeta {
  repo?: string;
  sha?: string;
  runs: RelayRun[];
  check_runs: RelayCheckRun[];
  statuses: RelayCommitStatus[];
}

export interface RelayLatestItem {
  id: string;
  author?: string;
  at?: string;
  url?: string;
  state?: string;
  path?: string;
}

/** Response of `/api/pr-status`. `state` is `none` when the target has no pull request. */
export interface PrStatusResponse extends RelayMeta {
  repo?: string;
  pr?: number;
  state: 'open' | 'closed' | 'merged' | 'none';
  draft: boolean;
  title: string;
  url: string;
  head_sha: string;
  head_ref: string;
  review_decision: string | null;
  merged_at?: string;
  closed_at?: string;
  updated_at?: string;
  comments: RelayLatestItem[];
  reviews: RelayLatestItem[];
  review_comments: RelayLatestItem[];
  /** With `since`: the relay capped the arrays at 100 items. */
  truncated: boolean;
}

/** No relay URL is set. Retrying cannot help, so the caller exits 2 at once. */
export class RelayNotConfiguredError extends Error {
  constructor() {
    super('no relay configured (set GH_WATCHER_EVENTS_URL)');
    this.name = 'RelayNotConfiguredError';
  }
}

/** How one relay request failed. */
export type RelayFailureKind = 'timeout' | 'http' | 'connection' | 'invalid';

/**
 * One failed relay request. The message names the real cause: a timeout, an HTTP status from a
 * relay that answered, a connection error, or an answer that cannot be read.
 */
export class RelayFailure extends Error {
  readonly kind: RelayFailureKind;
  constructor(kind: RelayFailureKind, message: string) {
    super(message);
    this.name = 'RelayFailure';
    this.kind = kind;
  }
}

/**
 * The relay did not give a good answer before the deadline. The caller exits 2 with the JSON
 * code `relay_unreachable` (kept for scripts). The message names the real cause, see `kind`.
 */
export class RelayUnreachableError extends Error {
  readonly url: string;
  readonly kind: RelayFailureKind | undefined;
  constructor(url: string, message: string, kind?: RelayFailureKind) {
    super(message);
    this.name = 'RelayUnreachableError';
    this.url = url;
    this.kind = kind;
  }
}

/** The relay refused the request (HTTP 400). Retrying cannot help. */
export class RelayRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayRequestError';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The errno (ECONNREFUSED, ENOTFOUND and so on) or the message of a connection error. */
function connectionDetail(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    for (const candidate of [cause, error]) {
      const code = (candidate as { code?: unknown } | undefined)?.code;
      if (typeof code === 'string' && code.length > 0) {
        return code;
      }
    }
    if (cause instanceof Error && cause.message.length > 0) {
      return cause.message;
    }
  }
  return describe(error);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function conclusionOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function parseMeta(raw: Record<string, unknown>): RelayMeta {
  if (typeof raw['rev'] !== 'number') {
    throw new Error('relay returned a malformed response');
  }
  const mode = raw['owner_mode'];
  const errorRaw = raw['error'];
  let error: RelayErrorInfo | null = null;
  if (errorRaw !== null && errorRaw !== undefined) {
    const info = record(errorRaw);
    error = {
      kind: text(info['kind']),
      message: text(info['message']),
      retry_at: optionalText(info['retry_at']) ?? null,
    };
  }
  const meta: RelayMeta = {
    rev: raw['rev'],
    changed: raw['changed'] !== false,
    owner_mode: mode === 'app' || mode === 'poll' ? mode : 'unknown',
    source: raw['source'] === 'relay-poll' ? 'relay-poll' : 'webhook',
    stale: raw['stale'] === true,
    error,
  };
  if (raw['pending'] === true) {
    meta.pending = true;
  }
  const fetchedAt = optionalText(raw['fetched_at']);
  if (fetchedAt !== undefined) {
    meta.fetched_at = fetchedAt;
  }
  const warning = optionalText(raw['warning']);
  if (warning !== undefined) {
    meta.warning = warning;
  }
  const boot = optionalText(raw['boot']);
  if (boot !== undefined) {
    meta.boot = boot;
  }
  return meta;
}

export function parseStatusResponse(raw: unknown): StatusResponse {
  const body = record(raw);
  const meta = parseMeta(body);
  const response: StatusResponse = {
    ...meta,
    runs: asArray(body['runs']) as RelayRun[],
    check_runs: asArray(body['check_runs']) as RelayCheckRun[],
    statuses: asArray(body['statuses']) as RelayCommitStatus[],
  };
  const sha = optionalText(body['sha']);
  if (sha !== undefined) {
    response.sha = sha;
  }
  return response;
}

function latestItems(list: unknown, single: unknown, timeKeys: string[]): RelayLatestItem[] {
  const items = asArray(list);
  if (items.length === 0 && single !== null && single !== undefined) {
    items.push(single);
  }
  return items.map((item) => {
    const entry = record(item);
    const author = entry['author'] ?? entry['user'];
    const result: RelayLatestItem = { id: String(entry['id'] ?? '') };
    const login = typeof author === 'string' ? author : text(record(author)['login']);
    if (login.length > 0) {
      result.author = login;
    }
    for (const key of timeKeys) {
      const at = optionalText(entry[key]);
      if (at !== undefined) {
        result.at = at;
        break;
      }
    }
    const url = optionalText(entry['url']) ?? optionalText(entry['html_url']);
    if (url !== undefined) {
      result.url = url;
    }
    const state = optionalText(entry['state']);
    if (state !== undefined) {
      result.state = state;
    }
    const path = optionalText(entry['path']);
    if (path !== undefined) {
      result.path = path;
    }
    return result;
  });
}

export function parsePrStatusResponse(raw: unknown): PrStatusResponse {
  const body = record(raw);
  const meta = parseMeta(body);
  const state = text(body['state']).toLowerCase();
  const response: PrStatusResponse = {
    ...meta,
    state: state === 'open' || state === 'closed' || state === 'merged' ? state : 'none',
    draft: body['draft'] === true,
    title: text(body['title']),
    url: text(body['html_url']) || text(body['url']),
    head_sha: text(body['head_sha']),
    head_ref: text(body['head_ref']),
    review_decision: optionalText(body['review_decision']) ?? null,
    comments: latestItems(body['comments'], body['latest_comment'], ['created_at', 'updated_at', 'at']),
    reviews: latestItems(body['reviews'], body['latest_review'], ['submitted_at', 'created_at', 'updated_at', 'at']),
    review_comments: latestItems(body['review_comments'], body['latest_review_comment'], ['created_at', 'updated_at', 'at']),
    truncated: body['truncated'] === true,
  };
  if (typeof body['pr'] === 'number') {
    response.pr = body['pr'];
  } else if (typeof body['number'] === 'number') {
    response.pr = body['number'];
  }
  for (const key of ['merged_at', 'closed_at', 'updated_at'] as const) {
    const value = optionalText(body[key]);
    if (value !== undefined) {
      response[key] = value;
    }
  }
  return response;
}

const PR_STATES: Record<'open' | 'closed' | 'merged', PrState> = { open: 'OPEN', closed: 'CLOSED', merged: 'MERGED' };

/** Map a `/api/pr-status` answer to a pull request snapshot; undefined when the target has no pull request. */
export function prStatusToSnapshot(response: PrStatusResponse, now: () => Date = () => new Date()): PrSnapshot | undefined {
  if (response.state === 'none' || response.pr === undefined) {
    return undefined;
  }
  const comments: PrComment[] = response.comments.map((item) => ({
    id: item.id,
    author: item.author ?? '',
    createdAt: item.at ?? '',
    url: item.url ?? '',
  }));
  const reviews: PrReview[] = response.reviews
    .filter((item) => (item.state ?? '').toUpperCase() !== 'PENDING')
    .map((item) => {
      const review: PrReview = {
        id: item.id,
        author: item.author ?? '',
        state: (item.state ?? '').toUpperCase(),
        submittedAt: item.at ?? '',
      };
      if (item.url !== undefined) {
        review.url = item.url;
      }
      return review;
    });
  const reviewComments: PrReviewComment[] = response.review_comments.map((item) => {
    const comment: PrReviewComment = { id: item.id, author: item.author ?? '', createdAt: item.at ?? '', url: item.url ?? '' };
    if (item.path !== undefined) {
      comment.path = item.path;
    }
    return comment;
  });
  const snapshot: PrSnapshot = {
    number: response.pr,
    url: response.url,
    title: response.title,
    state: PR_STATES[response.state],
    isDraft: response.draft,
    headSha: response.head_sha,
    headRef: response.head_ref,
    reviewDecision: response.review_decision,
    comments,
    reviews,
    reviewComments,
    checkedAt: response.fetched_at ?? now().toISOString(),
  };
  if (response.merged_at !== undefined) {
    snapshot.mergedAt = response.merged_at;
  }
  if (response.closed_at !== undefined) {
    snapshot.closedAt = response.closed_at;
  }
  if (response.updated_at !== undefined) {
    snapshot.updatedAt = response.updated_at;
  }
  return snapshot;
}

function checkRunStatus(status: string, conclusion: string | null): ExternalCheckStatus | undefined {
  if (status !== 'completed') {
    return 'pending';
  }
  if (conclusion === 'stale') {
    return undefined;
  }
  if (conclusion !== null && SUCCESS_CONCLUSIONS.includes(conclusion)) {
    return 'success';
  }
  // Failure-like and unrecognised conclusions both count as failures, so nothing passes silently.
  return 'failure';
}

function statusState(state: string): ExternalCheckStatus {
  if (state === 'success') {
    return 'success';
  }
  return state === 'pending' ? 'pending' : 'failure';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function toRun(run: RelayRun): GhRunInfo {
  const info: GhRunInfo = {
    databaseId: Number(run.id),
    workflowName: text(run.name),
    displayTitle: text(run.display_title),
    status: text(run.status),
    conclusion: conclusionOf(run.conclusion),
    url: text(run.html_url),
    headSha: text(run.head_sha),
  };
  if (run.created_at !== undefined) {
    info.createdAt = run.created_at;
  }
  if (run.started_at !== undefined) {
    info.startedAt = run.started_at;
  }
  if (run.updated_at !== undefined) {
    info.updatedAt = run.updated_at;
  }
  if (run.run_attempt !== undefined) {
    info.attempt = Number(run.run_attempt);
  }
  return info;
}

function toJob(job: RelayRunJob): GhJobInfo {
  const info: GhJobInfo = {
    name: text(job.name),
    status: text(job.status),
    conclusion: conclusionOf(job.conclusion),
    steps: asArray(job.steps).map((raw) => {
      const step = record(raw);
      return {
        name: text(step['name']),
        number: Number(step['number']),
        status: text(step['status']),
        conclusion: conclusionOf(step['conclusion']),
      };
    }),
  };
  if (job.html_url !== undefined && job.html_url.length > 0) {
    info.url = job.html_url;
  }
  return info;
}

/** Latest-per-(app, name) external check runs, skipping stale ones. */
function toCheckRuns(items: RelayCheckRun[]): ExternalCheck[] {
  const latest = new Map<string, { check: ExternalCheck | undefined; at: string; id: number }>();
  for (const item of items) {
    const source = text(item.app_slug);
    const name = text(item.name);
    const at = text(item.started_at);
    const id = Number(item.id);
    const key = `${source}\u0000${name}`;
    const current = latest.get(key);
    if (current !== undefined && (at < current.at || (at === current.at && id <= current.id))) {
      continue;
    }
    const conclusion = conclusionOf(item.conclusion);
    const status = checkRunStatus(text(item.status), conclusion);
    if (status === undefined) {
      latest.set(key, { check: undefined, at, id });
      continue;
    }
    const check: ExternalCheck = { kind: 'check_run', name, source, status, conclusion, url: text(item.html_url) };
    const updatedAt = text(item.completed_at).length > 0 ? text(item.completed_at) : at;
    if (updatedAt.length > 0) {
      check.updatedAt = updatedAt;
    }
    latest.set(key, { check, at, id });
  }
  return [...latest.values()].flatMap((entry) => (entry.check === undefined ? [] : [entry.check]));
}

function toStatuses(items: RelayCommitStatus[]): ExternalCheck[] {
  const latest = new Map<string, { check: ExternalCheck; at: string; id: number }>();
  for (const item of items) {
    const name = text(item.context);
    const at = text(item.updated_at);
    const id = Number(item.id);
    const current = latest.get(name);
    if (current !== undefined && (at < current.at || (at === current.at && id <= current.id))) {
      continue;
    }
    const state = text(item.state);
    const url = text(item.target_url);
    const check: ExternalCheck = { kind: 'status', name, source: hostOf(url), status: statusState(state), conclusion: state, url };
    if (at.length > 0) {
      check.updatedAt = at;
    }
    latest.set(name, { check, at, id });
  }
  return [...latest.values()].map((entry) => entry.check);
}

/** Failed steps from the jobs the relay includes for every failed run. */
function failedStepsOf(runs: RelayRun[], infos: GhRunInfo[]): FailedStep[] {
  const failures: FailedStep[] = [];
  for (const info of infos) {
    if (!isFailureish(info.conclusion)) {
      continue;
    }
    const source = runs.find((run) => Number(run.id) === info.databaseId);
    for (const job of asArray(source?.jobs).map((raw) => toJob(raw as RelayRunJob))) {
      if (!isFailureish(job.conclusion)) {
        continue;
      }
      const steps = (job.steps ?? []).filter((step) => step.conclusion === 'failure');
      if (steps.length === 0) {
        failures.push({ runId: info.databaseId, workflowName: info.workflowName, jobName: job.name, stepName: '', stepNumber: 0 });
        continue;
      }
      for (const step of steps) {
        failures.push({
          runId: info.databaseId,
          workflowName: info.workflowName,
          jobName: job.name,
          stepName: step.name,
          stepNumber: step.number,
        });
      }
    }
  }
  return failures;
}

/** Jobs of each run in the snapshot, by run id (empty list when the relay sent none). */
export function jobsByRun(snapshot: StatusResponse): Map<number, GhJobInfo[]> {
  const map = new Map<number, GhJobInfo[]>();
  for (const run of snapshot.runs) {
    map.set(
      Number(run.id),
      asArray(run.jobs).map((raw) => toJob(raw as RelayRunJob)),
    );
  }
  return map;
}

/** Map a relay snapshot to the report shape that wait, follow, status and watch share. */
export function snapshotToReport(
  repo: string,
  target: WatchTarget,
  snapshot: StatusResponse,
  now: () => Date = () => new Date(),
): CheckReport {
  const runs = latestPerWorkflow(snapshot.runs.map((run) => toRun(run)));
  const checks = [...toCheckRuns(snapshot.check_runs), ...toStatuses(snapshot.statuses)];
  let state = aggregateState(runs, checks);
  // A first fetch not done, or stale data, is never final: keep waiting, never report success.
  if ((state === 'success' || state === 'failure') && (snapshot.pending === true || snapshot.stale)) {
    state = 'pending';
  }
  const report: CheckReport = {
    repo,
    target,
    targetKey: targetKey(target),
    state,
    runs,
    checks,
    failedSteps: state === 'failure' ? failedStepsOf(snapshot.runs, runs) : [],
    failedChecks: state === 'failure' ? failedChecksOf(checks) : [],
    checkedAt: snapshot.fetched_at ?? now().toISOString(),
    source: 'relay',
    relaySource: snapshot.source,
  };
  if (snapshot.warning !== undefined) {
    report.warning = snapshot.warning;
  }
  return report;
}

export interface RelayConfig {
  /** Relay base URL; undefined means no relay is configured. */
  baseUrl: string | undefined;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
  /** Absolute time (ms) when the session gives up on an unreachable relay. */
  deadline: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One conversation with the relay: requests with back-off, and the once-only notices (warning,
 * stale and error). The session retries only the relay, never GitHub.
 */
export class RelaySession {
  private readonly config: RelayConfig;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly clock: () => number;
  private backoffMs = BACKOFF_START_MS;
  private warned = new Set<string>();
  private boot: string | undefined;

  constructor(config: RelayConfig) {
    this.config = config;
    this.fetchFn = config.fetchFn ?? fetch;
    this.sleep = config.sleep ?? defaultSleep;
    this.log = config.log ?? ((line: string) => process.stderr.write(`${line}\n`));
    this.clock = config.now ?? Date.now;
  }

  get now(): () => number {
    return this.clock;
  }

  private async requestOnce(path: string, params: Record<string, string>, waitSeconds: number): Promise<unknown> {
    const base = this.config.baseUrl as string;
    const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, (waitSeconds + 10) * 1000);
    try {
      const response = await this.fetchFn(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (response.status === 400) {
        throw new RelayRequestError(`relay rejected the request: ${(await response.text()).trim().slice(0, 300)}`);
      }
      if (!response.ok) {
        throw new RelayFailure('http', `relay answered HTTP ${response.status} at ${base}`);
      }
      try {
        return await response.json();
      } catch (error) {
        if (controller.signal.aborted) {
          throw error;
        }
        throw new RelayFailure('invalid', `relay sent an unreadable answer at ${base}: ${describe(error)}`);
      }
    } catch (error) {
      if (error instanceof RelayRequestError || error instanceof RelayFailure) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new RelayFailure('timeout', `relay timed out after ${waitSeconds + 10} s at ${base}`);
      }
      throw new RelayFailure('connection', `relay connection failed at ${base}: ${connectionDetail(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Get a parsed relay answer. Retries with back-off (5 s doubling to 60 s) until the deadline. */
  async get<T>(path: string, params: Record<string, string>, waitSeconds: number, parse: (raw: unknown) => T): Promise<T> {
    const baseUrl = this.config.baseUrl;
    if (baseUrl === undefined) {
      this.log('gh-watcher: ERROR no relay configured (set GH_WATCHER_EVENTS_URL)');
      throw new RelayNotConfiguredError();
    }
    const wait = Math.max(0, Math.min(MAX_EVENT_WAIT_SECONDS, Math.floor(waitSeconds)));
    for (;;) {
      try {
        const raw = await this.requestOnce(path, { ...params, wait: String(wait) }, wait);
        let parsed: T;
        try {
          parsed = parse(raw);
        } catch (error) {
          throw new RelayFailure('invalid', `relay sent an unreadable answer at ${baseUrl}: ${describe(error)}`);
        }
        this.backoffMs = BACKOFF_START_MS;
        return parsed;
      } catch (error) {
        if (error instanceof RelayRequestError) {
          throw error;
        }
        const failure = error instanceof RelayFailure ? error : new RelayFailure('connection', `relay connection failed at ${baseUrl}: ${connectionDetail(error)}`);
        this.log(`gh-watcher: ERROR ${failure.message}`);
        const remaining = this.config.deadline - this.clock();
        if (remaining <= 0) {
          throw new RelayUnreachableError(baseUrl, failure.message, failure.kind);
        }
        const delay = Math.min(this.backoffMs, remaining);
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
        await this.sleep(delay);
        if (this.config.deadline - this.clock() <= 0) {
          throw new RelayUnreachableError(baseUrl, failure.message, failure.kind);
        }
      }
    }
  }

  /** Print the relay `warning` once, and each distinct `stale`/`error` notice once. */
  note(meta: RelayMeta): void {
    if (meta.boot !== undefined) {
      meta.bootChanged = this.boot !== undefined && this.boot !== meta.boot;
      this.boot = meta.boot;
    }
    const lines: string[] = [];
    if (meta.warning !== undefined) {
      lines.push(`gh-watcher: warning: ${meta.warning}`);
    }
    if (meta.stale || meta.error !== null) {
      const detail = meta.error === null ? 'no detail' : `${meta.error.kind}: ${meta.error.message}${meta.error.retry_at !== null ? ` (retry at ${meta.error.retry_at})` : ''}`;
      lines.push(`gh-watcher: relay data is stale (${detail}); waiting on the relay`);
    }
    for (const line of lines) {
      if (!this.warned.has(line)) {
        this.warned.add(line);
        this.log(line);
      }
    }
  }

  async status(target: WatchTarget, repo: string, after: number, waitSeconds: number, jobs: boolean): Promise<StatusResponse> {
    const response = await this.get('api/status', { repo, ...targetParams(target), after: String(after), jobs: jobs ? '1' : '0' }, waitSeconds, parseStatusResponse);
    this.note(response);
    return response;
  }

  async prStatus(
    repo: string,
    pr: { number: number } | { branch: string },
    after: number,
    waitSeconds: number,
    since?: string,
  ): Promise<PrStatusResponse> {
    const target: Record<string, string> = 'number' in pr ? { pr: String(pr.number) } : { branch: pr.branch };
    const response = await this.get('api/pr-status', { repo, ...target, after: String(after), ...(since !== undefined ? { since } : {}) }, waitSeconds, parsePrStatusResponse);
    this.note(response);
    return response;
  }
}

function targetParams(target: WatchTarget): Record<string, string> {
  switch (target.kind) {
    case 'commit':
      return { sha: target.sha.toLowerCase() };
    case 'pr':
      return { pr: String(target.number) };
    case 'branch':
      return { branch: target.branch };
    case 'run':
      return { run: String(target.runId) };
  }
}
