import { spawn } from 'node:child_process';
import { createQueuedExec, EtagStore, queueDisabled, RateLimitTimeoutError, type QueuedExec } from './queue.js';
import type {
  CheckState,
  ExternalCheck,
  ExternalCheckStatus,
  FailedCheck,
  FailedStep,
  GhJobInfo,
  GhRunInfo,
  GhStepInfo,
  PrComment,
  PrReview,
  PrReviewComment,
  PrSnapshot,
  PrState,
  WatchTarget,
} from './types.js';

export const MIN_REMAINING_ENV = 'GH_WATCHER_MIN_REMAINING';
/** Below this many REST calls left in the hour, polling waits slow down. */
export const DEFAULT_MIN_REMAINING = 500;
/** Polling waits sleep this many times longer while the budget is low. */
export const LOW_BUDGET_FACTOR = 4;

const PR_FIELDS =
  'number,url,title,state,isDraft,headRefOid,headRefName,reviewDecision,mergedAt,closedAt,comments,reviews,updatedAt';
const REVIEW_COMMENT_JQ =
  '.[] | {id: .id, author: .user.login, createdAt: .created_at, path: .path, url: .html_url}';

/** Check runs created by Actions are already covered by workflow runs. */
const ACTIONS_APP_SLUG = 'github-actions';

export const FAILURE_CONCLUSIONS: readonly string[] = [
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
  'action_required',
];

export const SUCCESS_CONCLUSIONS: readonly string[] = ['success', 'neutral', 'skipped'];

export interface GhExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type GhExec = (args: string[]) => Promise<GhExecResult>;

/** Rate-limit waits are bounded by this deadline (epoch ms) when the executor supports it. */
function applyDeadline(exec: GhExec, deadline: number | undefined): void {
  (exec as QueuedExec).setDeadline?.(deadline);
}

function applySignal(exec: GhExec, signal: AbortSignal | undefined): void {
  (exec as QueuedExec).setSignal?.(signal);
}

/** What a previous snapshot of the same pull request offers for skipping the inline comments call. */
export interface PrSnapshotReuse {
  updatedAt?: string;
  reviewComments: PrReviewComment[];
}

export interface GhClientOptions {
  ghBin?: string;
  exec?: GhExec;
  /** Also request startedAt, updatedAt and attempt for each run. */
  detailedRuns?: boolean;
  /** Clock for snapshot timestamps; defaults to the system clock. */
  now?: () => Date;
  /**
   * Store for conditional requests. Defaults to the shared queue store, except with an injected
   * `exec` or a disabled queue, where there is none. Pass `null` to switch it off.
   */
  etagStore?: EtagStore | null;
  /** Low-budget threshold; defaults to GH_WATCHER_MIN_REMAINING, else 500. */
  minRemaining?: number;
  /** Receives the one-off low-budget notice; defaults to stderr. */
  log?: (line: string) => void;
}

export interface HttpResponse {
  status: number;
  headers: Map<string, string>;
  body: string;
}

/** Split `gh api -i` output into status, lower-cased headers and body; undefined when it has no HTTP header block. */
export function parseHttpResponse(stdout: string): HttpResponse | undefined {
  const first = /^HTTP\/\S+ (\d{3})/.exec(stdout);
  if (first === null) {
    return undefined;
  }
  const match = /\r?\n\r?\n/.exec(stdout);
  const head = match === null ? stdout : stdout.slice(0, match.index);
  const body = match === null ? '' : stdout.slice(match.index + match[0].length);
  const headers = new Map<string, string>();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }
  return { status: Number(first[1]), headers, body };
}

/** Map an Actions REST workflow run to the shape `normaliseRun` reads. */
function restRunToGh(raw: unknown, detailed: boolean): unknown {
  const record = (raw ?? {}) as Record<string, unknown>;
  const mapped: Record<string, unknown> = {
    databaseId: record['id'],
    workflowName: record['name'],
    displayTitle: record['display_title'],
    status: record['status'],
    conclusion: record['conclusion'],
    url: record['html_url'],
    headSha: record['head_sha'],
    createdAt: record['created_at'],
  };
  if (detailed) {
    mapped['startedAt'] = record['run_started_at'];
    mapped['updatedAt'] = record['updated_at'];
    mapped['attempt'] = record['run_attempt'];
  }
  return mapped;
}

/** Map a REST job to the shape `normaliseJob` reads. */
function restJobToGh(raw: unknown): unknown {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    name: record['name'],
    status: record['status'],
    conclusion: record['conclusion'],
    url: record['html_url'],
    steps: asArray(record['steps']).map((step) => {
      const item = (step ?? {}) as Record<string, unknown>;
      return { name: item['name'], number: item['number'], status: item['status'], conclusion: item['conclusion'] };
    }),
  };
}

/** Map a REST check run to the shape `normaliseCheckRuns` reads (the old jq output). */
function restCheckRunToGh(raw: unknown): unknown {
  const record = (raw ?? {}) as Record<string, unknown>;
  const app = (record['app'] ?? {}) as Record<string, unknown>;
  return {
    id: record['id'],
    name: record['name'],
    status: record['status'],
    conclusion: record['conclusion'],
    url: record['html_url'],
    startedAt: record['started_at'],
    completedAt: record['completed_at'],
    app: app['slug'],
  };
}

function restStatusToGh(raw: unknown): unknown {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    id: record['id'],
    context: record['context'],
    state: record['state'],
    url: record['target_url'],
    updatedAt: record['updated_at'],
  };
}

/** A hung gh call must not hold queue locks for ever. */
export const GH_EXEC_TIMEOUT_MS = 120_000;

export function spawnGh(ghBin: string, timeoutMs: number = GH_EXEC_TIMEOUT_MS): GhExec {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(ghBin, args, { shell: false });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`gh ${args.slice(0, 2).join(' ')} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? -1 });
      });
    });
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function assertOk(result: GhExecResult, context: string): void {
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new Error(detail.length > 0 ? `gh ${context} failed: ${detail}` : `gh ${context} failed with exit code ${result.code}`);
  }
}

function normaliseRun(raw: unknown): GhRunInfo {
  const record = (raw ?? {}) as Partial<GhRunInfo>;
  const run: GhRunInfo = {
    databaseId: Number(record.databaseId),
    workflowName: record.workflowName ?? '',
    displayTitle: record.displayTitle ?? '',
    status: record.status ?? '',
    conclusion: record.conclusion ?? null,
    url: record.url ?? '',
    headSha: record.headSha ?? '',
  };
  if (record.createdAt !== undefined) {
    run.createdAt = record.createdAt;
  }
  if (record.startedAt !== undefined) {
    run.startedAt = record.startedAt;
  }
  if (record.updatedAt !== undefined) {
    run.updatedAt = record.updatedAt;
  }
  if (record.attempt !== undefined) {
    run.attempt = Number(record.attempt);
  }
  return run;
}

function loginOf(raw: unknown): string {
  const record = (raw ?? {}) as { login?: unknown };
  return typeof record.login === 'string' ? record.login : '';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalisePrState(value: unknown): PrState {
  const upper = text(value).toUpperCase();
  return upper === 'MERGED' || upper === 'CLOSED' ? upper : 'OPEN';
}

function normalisePrComment(raw: unknown): PrComment {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(record['id'] ?? ''),
    author: loginOf(record['author']),
    createdAt: text(record['createdAt']),
    url: text(record['url']),
  };
}

function normalisePrReview(raw: unknown): PrReview {
  const record = (raw ?? {}) as Record<string, unknown>;
  const review: PrReview = {
    id: String(record['id'] ?? ''),
    author: loginOf(record['author']),
    state: text(record['state']).toUpperCase(),
    submittedAt: text(record['submittedAt']),
  };
  if (typeof record['url'] === 'string' && record['url'].length > 0) {
    review.url = record['url'];
  }
  return review;
}

function normalisePrReviewComment(raw: unknown): PrReviewComment {
  const record = (raw ?? {}) as Record<string, unknown>;
  const comment: PrReviewComment = {
    id: String(record['id'] ?? ''),
    author: typeof record['author'] === 'string' ? record['author'] : loginOf(record['author']),
    createdAt: text(record['createdAt']),
    url: text(record['url']),
  };
  if (typeof record['path'] === 'string' && record['path'].length > 0) {
    comment.path = record['path'];
  }
  return comment;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalisePr(raw: unknown, reviewComments: PrReviewComment[], checkedAt: string): PrSnapshot {
  const record = (raw ?? {}) as Record<string, unknown>;
  const snapshot: PrSnapshot = {
    number: Number(record['number']),
    url: text(record['url']),
    title: text(record['title']),
    state: normalisePrState(record['state']),
    isDraft: record['isDraft'] === true,
    headSha: text(record['headRefOid']),
    headRef: text(record['headRefName']),
    reviewDecision: text(record['reviewDecision']).length > 0 ? text(record['reviewDecision']) : null,
    comments: asArray(record['comments']).map((item) => normalisePrComment(item)),
    reviews: asArray(record['reviews'])
      .map((item) => normalisePrReview(item))
      .filter((review) => review.state !== 'PENDING'),
    reviewComments,
    checkedAt,
  };
  if (text(record['mergedAt']).length > 0) {
    snapshot.mergedAt = text(record['mergedAt']);
  }
  if (text(record['closedAt']).length > 0) {
    snapshot.closedAt = text(record['closedAt']);
  }
  if (text(record['updatedAt']).length > 0) {
    snapshot.updatedAt = text(record['updatedAt']);
  }
  return snapshot;
}

function parseJsonLines(stdout: string, context: string): unknown[] {
  const items: unknown[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      throw new Error(`gh ${context} returned malformed output`);
    }
  }
  return items;
}

function normaliseStep(raw: unknown): GhStepInfo {
  const record = (raw ?? {}) as Partial<GhStepInfo>;
  const step: GhStepInfo = {
    name: record.name ?? '',
    number: Number(record.number),
    conclusion: record.conclusion ?? null,
  };
  if (record.status !== undefined) {
    step.status = record.status;
  }
  return step;
}

function normaliseJob(raw: unknown): GhJobInfo {
  const record = (raw ?? {}) as Partial<GhJobInfo>;
  const job: GhJobInfo = {
    name: record.name ?? '',
    status: record.status ?? '',
    conclusion: record.conclusion ?? null,
    steps: (record.steps ?? []).map((step) => normaliseStep(step)),
  };
  if (record.url !== undefined) {
    job.url = record.url;
  }
  return job;
}

function isFailureish(conclusion: string | null): boolean {
  return conclusion !== null && FAILURE_CONCLUSIONS.includes(conclusion);
}

function isNewer(candidate: GhRunInfo, current: GhRunInfo): boolean {
  const left = candidate.createdAt ?? '';
  const right = current.createdAt ?? '';
  if (left !== right) {
    return left > right;
  }
  return candidate.databaseId > current.databaseId;
}

/** Keep only runs for the given commit; a short sha given by the user matches by prefix. */
function onlySha(runs: GhRunInfo[], sha: string): GhRunInfo[] {
  const wanted = sha.toLowerCase();
  return runs.filter((run) => run.headSha.toLowerCase().startsWith(wanted));
}

/** Keep the newest run of each workflow, so a successful re-run supersedes a failed attempt. */
export function latestPerWorkflow(runs: GhRunInfo[]): GhRunInfo[] {
  const latest = new Map<string, GhRunInfo>();
  for (const run of runs) {
    const current = latest.get(run.workflowName);
    if (current === undefined || isNewer(run, current)) {
      latest.set(run.workflowName, run);
    }
  }
  return runs.filter((run) => latest.get(run.workflowName) === run);
}

/** Fallback: restrict to the commit of the most recently created run, then newest per workflow. */
function newestCommitRuns(runs: GhRunInfo[]): GhRunInfo[] {
  let newest: GhRunInfo | undefined;
  for (const run of runs) {
    if (newest === undefined || isNewer(run, newest)) {
      newest = run;
    }
  }
  if (newest === undefined) {
    return [];
  }
  return latestPerWorkflow(runs.filter((run) => run.headSha === newest.headSha));
}

/** Map a check run to a status; undefined for `stale` runs, which GitHub has superseded. */
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

/** Latest-per-(app, name) external check runs, skipping Actions check runs and stale ones. */
function normaliseCheckRuns(items: unknown[]): ExternalCheck[] {
  const latest = new Map<string, { check: ExternalCheck | undefined; at: string; id: number }>();
  for (const item of items) {
    const record = (item ?? {}) as Record<string, unknown>;
    const source = text(record['app']);
    if (source === ACTIONS_APP_SLUG) {
      continue;
    }
    const name = text(record['name']);
    const at = text(record['startedAt']);
    const id = Number(record['id']);
    const key = `${source}\u0000${name}`;
    const current = latest.get(key);
    if (current !== undefined && (at < current.at || (at === current.at && id <= current.id))) {
      continue;
    }
    const conclusion = typeof record['conclusion'] === 'string' ? record['conclusion'] : null;
    const status = checkRunStatus(text(record['status']), conclusion);
    if (status === undefined) {
      // A stale run still supersedes older runs of the same check but is not reported itself.
      latest.set(key, { check: undefined, at, id });
      continue;
    }
    const check: ExternalCheck = { kind: 'check_run', name, source, status, conclusion, url: text(record['url']) };
    const updatedAt = text(record['completedAt']).length > 0 ? text(record['completedAt']) : at;
    if (updatedAt.length > 0) {
      check.updatedAt = updatedAt;
    }
    latest.set(key, { check, at, id });
  }
  const checks: ExternalCheck[] = [];
  for (const entry of latest.values()) {
    if (entry.check !== undefined) {
      checks.push(entry.check);
    }
  }
  return checks;
}

/** The combined-status endpoint has no creator, so the target URL's host names the source. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Result of a checks lookup; `unavailable` explains why the token could not read them. */
export interface ChecksResult {
  checks: ExternalCheck[];
  unavailable?: string;
}

function isPermissionError(result: GhExecResult): boolean {
  return result.code !== 0 && /\b403\b|forbidden|resource not accessible|insufficient|permission/i.test(result.stderr);
}

/** Commit statuses; the combined status lists the latest per context, duplicates across pages are collapsed. */
function normaliseStatuses(items: unknown[]): ExternalCheck[] {
  const latest = new Map<string, { check: ExternalCheck; at: string; id: number }>();
  for (const item of items) {
    const record = (item ?? {}) as Record<string, unknown>;
    const name = text(record['context']);
    const at = text(record['updatedAt']);
    const id = Number(record['id']);
    const current = latest.get(name);
    if (current !== undefined && (at < current.at || (at === current.at && id <= current.id))) {
      continue;
    }
    const state = text(record['state']);
    const check: ExternalCheck = {
      kind: 'status',
      name,
      source: hostOf(text(record['url'])),
      status: statusState(state),
      conclusion: state,
      url: text(record['url']),
    };
    if (at.length > 0) {
      check.updatedAt = at;
    }
    latest.set(name, { check, at, id });
  }
  return [...latest.values()].map((entry) => entry.check);
}

function setResolved(resolved: { sha?: string } | undefined, sha: string): void {
  if (resolved !== undefined && /^[0-9a-f]{40}$/i.test(sha)) {
    resolved.sha = sha.toLowerCase();
  }
}

/** True when a saved change key is the same edge: equal, or an old-format (run ids only) key matching the ids of the new one. */
export function sameRunsKey(saved: string, key: string): boolean {
  if (saved === key) {
    return true;
  }
  return !saved.includes('|') && key.includes('|') && key.slice(0, key.indexOf('|')) === saved;
}

export class GhClient {
  private readonly exec: GhExec;
  private readonly detailed: boolean;
  private readonly now: () => Date;
  private readonly etags: EtagStore | undefined;
  private readonly minRemaining: number;
  private readonly log: (line: string) => void;
  private remaining: number | undefined;
  private warnedLow = false;
  private warnedUnavailable = false;

  constructor(options?: GhClientOptions) {
    this.exec =
      options?.exec ??
      (queueDisabled() ? spawnGh(options?.ghBin ?? 'gh') : createQueuedExec(spawnGh(options?.ghBin ?? 'gh')));
    this.detailed = options?.detailedRuns === true;
    this.now = options?.now ?? (() => new Date());
    if (options?.etagStore !== undefined) {
      this.etags = options.etagStore ?? undefined;
    } else {
      this.etags = options?.exec === undefined && !queueDisabled() ? new EtagStore() : undefined;
    }
    const fromEnv = Number(process.env[MIN_REMAINING_ENV]);
    this.minRemaining =
      options?.minRemaining ??
      (process.env[MIN_REMAINING_ENV]?.trim() !== undefined && Number.isFinite(fromEnv) && fromEnv >= 0
        ? fromEnv
        : DEFAULT_MIN_REMAINING);
    this.log = options?.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  }

  /** True once a response reported fewer REST calls left than the threshold. */
  isLowBudget(): boolean {
    return this.remaining !== undefined && this.remaining < this.minRemaining;
  }

  /** How many times longer polling waits should sleep: 1 normally, 4 while the budget is low. */
  pollFactor(): number {
    return this.isLowBudget() ? LOW_BUDGET_FACTOR : 1;
  }

  private noteBudget(header: string | undefined): void {
    if (header === undefined) {
      return;
    }
    const value = Number(header);
    if (!Number.isFinite(value)) {
      return;
    }
    this.remaining = value;
    if (this.isLowBudget() && !this.warnedLow) {
      this.warnedLow = true;
      this.log(
        `gh-watcher: GitHub REST budget low (${value} left, below ${this.minRemaining}), waiting ${LOW_BUDGET_FACTOR}x longer between checks`,
      );
    }
  }

  /**
   * GET a REST path with `gh api -i`, sending `If-None-Match` when the shared store holds an ETag
   * for it. A 304 reply costs no rate limit and returns the stored body. The result has the body
   * as stdout (headers removed); failures come back unchanged.
   */
  private async conditionalGet(path: string): Promise<GhExecResult> {
    const cached = await this.etags?.get(path);
    const args = ['api', path, '-i', ...(cached === undefined ? [] : ['-H', `If-None-Match: ${cached.etag}`])];
    const result = await this.exec(args);
    const parsed = parseHttpResponse(result.stdout);
    if (parsed === undefined) {
      return result;
    }
    this.noteBudget(parsed.headers.get('x-ratelimit-remaining'));
    if (parsed.status === 304 && cached !== undefined) {
      return { stdout: cached.body, stderr: '', code: 0 };
    }
    if (result.code !== 0) {
      return result;
    }
    const etag = parsed.headers.get('etag');
    if (etag !== undefined && etag.length > 0) {
      await this.etags?.set(path, { etag, body: parsed.body });
    }
    return { stdout: parsed.body, stderr: result.stderr, code: 0 };
  }

  /** Bound any rate-limit wait by an absolute deadline (epoch ms); undefined lifts the bound. */
  setDeadline(deadline: number | undefined): void {
    applyDeadline(this.exec, deadline);
  }

  /** Make queued rate-limit sleeps and lock waits end promptly when the signal aborts. */
  setSignal(signal: AbortSignal | undefined): void {
    applySignal(this.exec, signal);
  }

  /**
   * One pull request with its comments, reviews and inline review comments. When `reuse` carries the
   * same `updatedAt`, the paginated inline comments call is skipped and `reuse.reviewComments` kept.
   */
  async prSnapshot(repo: string, number: number, reuse?: PrSnapshotReuse): Promise<PrSnapshot> {
    const view = await this.exec(['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS]);
    assertOk(view, `pr view ${number}`);
    const raw = parseJson<Record<string, unknown>>(view.stdout);
    const updatedAt = text(raw['updatedAt']);
    let reviewComments: PrReviewComment[];
    if (reuse?.updatedAt !== undefined && updatedAt.length > 0 && reuse.updatedAt === updatedAt) {
      reviewComments = reuse.reviewComments;
    } else {
      const inline = await this.exec(['api', `repos/${repo}/pulls/${number}/comments`, '--paginate', '--jq', REVIEW_COMMENT_JQ]);
      assertOk(inline, `api pulls/${number}/comments`);
      reviewComments = parseJsonLines(inline.stdout, `api pulls/${number}/comments`).map((item) =>
        normalisePrReviewComment(item),
      );
    }
    return normalisePr(raw, reviewComments, this.now().toISOString());
  }

  /** Newest pull request (any state) whose head branch is `branch`; undefined when there is none. */
  async findPrForBranch(repo: string, branch: string): Promise<number | undefined> {
    const result = await this.exec([
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      branch,
      '--state',
      'all',
      '--limit',
      '5',
      '--json',
      'number,createdAt',
    ]);
    assertOk(result, `pr list ${branch}`);
    let newest: { number: number; createdAt: string } | undefined;
    for (const item of asArray(parseJson<unknown>(result.stdout))) {
      const record = (item ?? {}) as Record<string, unknown>;
      const number = Number(record['number']);
      if (!Number.isInteger(number) || number <= 0) {
        continue;
      }
      const createdAt = text(record['createdAt']);
      if (newest === undefined || createdAt > newest.createdAt || (createdAt === newest.createdAt && number > newest.number)) {
        newest = { number, createdAt };
      }
    }
    return newest?.number;
  }

  async listRuns(repo: string, target: WatchTarget, resolved?: { sha?: string }): Promise<GhRunInfo[]> {
    if (target.kind === 'run') {
      const result = await this.conditionalGet(`repos/${repo}/actions/runs/${target.runId}`);
      assertOk(result, `api actions/runs/${target.runId}`);
      return [normaliseRun(restRunToGh(parseJson(result.stdout), this.detailed))];
    }
    if (target.kind === 'pr') {
      const prResult = await this.exec([
        'pr',
        'view',
        String(target.number),
        '--repo',
        repo,
        '--json',
        'headRefName,headRefOid',
      ]);
      assertOk(prResult, `pr view ${target.number}`);
      const parsed = parseJson<{ headRefName?: string; headRefOid?: string }>(prResult.stdout);
      const headSha = parsed.headRefOid ?? '';
      if (headSha.length > 0) {
        setResolved(resolved, headSha);
        return latestPerWorkflow(onlySha(await this.listRunsBy(repo, 'head_sha', headSha), headSha));
      }
      // Older gh versions may omit headRefOid: fall back to the newest commit on the head branch.
      return newestCommitRuns(await this.listRunsBy(repo, 'branch', parsed.headRefName ?? ''));
    }
    if (target.kind === 'branch') {
      const headSha = await this.branchHeadSha(repo, target.branch);
      if (headSha !== undefined) {
        setResolved(resolved, headSha);
        return latestPerWorkflow(onlySha(await this.listRunsBy(repo, 'head_sha', headSha), headSha));
      }
      return newestCommitRuns(await this.listRunsBy(repo, 'branch', target.branch));
    }
    setResolved(resolved, target.sha);
    return latestPerWorkflow(onlySha(await this.listRunsBy(repo, 'head_sha', target.sha), target.sha));
  }

  /**
   * Checks on the target's head commit that Actions workflow runs do not cover: third-party check
   * runs and commit statuses. A `run` target is Actions-only and has none. The sha comes from
   * `knownSha`, else from `runs` (already limited to one commit), else one head lookup. A
   * permission error (403) degrades to no checks with `unavailable` set; other failures throw.
   */
  async listChecks(
    repo: string,
    target: WatchTarget,
    runs: GhRunInfo[] = [],
    knownSha?: string,
  ): Promise<ChecksResult> {
    if (target.kind === 'run') {
      return { checks: [] };
    }
    const isFull = (value: string | undefined): value is string => value !== undefined && /^[0-9a-f]{40}$/i.test(value);
    const fromRuns = runs[0]?.headSha;
    const sha = isFull(knownSha) ? knownSha : isFull(fromRuns) ? fromRuns : await this.resolveHeadSha(repo, target);
    if (!isFull(sha)) {
      return { checks: [] };
    }
    const checkRuns = await this.conditionalGet(`repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    if (isPermissionError(checkRuns)) {
      return this.degraded(repo, 'check-runs', checkRuns);
    }
    assertOk(checkRuns, `api commits/${sha}/check-runs`);
    const checkRunItems = await this.pagedItems(
      checkRuns,
      'check_runs',
      `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      '.check_runs[]',
      restCheckRunToGh,
      `api commits/${sha}/check-runs`,
    );
    const statuses = await this.conditionalGet(`repos/${repo}/commits/${sha}/status?per_page=100`);
    if (isPermissionError(statuses)) {
      return this.degraded(repo, 'status', statuses);
    }
    assertOk(statuses, `api commits/${sha}/status`);
    const statusItems = await this.pagedItems(
      statuses,
      'statuses',
      `repos/${repo}/commits/${sha}/status?per_page=100`,
      '.statuses[]',
      restStatusToGh,
      `api commits/${sha}/status`,
    );
    return { checks: [...normaliseCheckRuns(checkRunItems), ...normaliseStatuses(statusItems)] };
  }

  /**
   * Items of a REST list from its first page. When the page is not the whole list (more than 100
   * items), the full list is read again with `--paginate`, uncached.
   */
  private async pagedItems(
    first: GhExecResult,
    key: string,
    path: string,
    jq: string,
    map: (raw: unknown) => unknown,
    context: string,
  ): Promise<unknown[]> {
    const parsed = parseJson<Record<string, unknown>>(first.stdout);
    const items = asArray(parsed[key]);
    const total = Number(parsed['total_count']);
    if (!Number.isFinite(total) || total <= items.length) {
      return items.map(map);
    }
    const all = await this.exec(['api', path, '--paginate', '--jq', jq]);
    assertOk(all, context);
    // The paginated jq output is raw REST objects: map them like the first page.
    return parseJsonLines(all.stdout, context).map(map);
  }

  private degraded(repo: string, what: string, result: GhExecResult): ChecksResult {
    const detail = result.stderr.trim().split('\n')[0] ?? '';
    const unavailable = `cannot read ${what} for ${repo} (${detail.slice(0, 120)})`;
    if (!this.warnedUnavailable) {
      this.warnedUnavailable = true;
      process.stderr.write(`gh-watcher: warning: ${unavailable}; using Actions runs only\n`);
    }
    return { checks: [], unavailable };
  }

  /**
   * Resolve a target to the full head sha without listing runs; undefined when it cannot be
   * resolved (callers then fall back to polling, which surfaces the underlying error).
   */
  async resolveHeadSha(repo: string, target: WatchTarget): Promise<string | undefined> {
    const isFull = (value: string): boolean => /^[0-9a-f]{40}$/i.test(value);
    try {
      if (target.kind === 'commit') {
        if (isFull(target.sha)) {
          return target.sha.toLowerCase();
        }
        const result = await this.exec(['api', `repos/${repo}/commits/${encodeURIComponent(target.sha)}`, '--jq', '.sha']);
        const sha = result.stdout.trim();
        return result.code === 0 && isFull(sha) ? sha.toLowerCase() : undefined;
      }
      if (target.kind === 'branch') {
        return (await this.branchHeadSha(repo, target.branch))?.toLowerCase();
      }
      const result =
        target.kind === 'pr'
          ? await this.exec(['pr', 'view', String(target.number), '--repo', repo, '--json', 'headRefOid'])
          : await this.conditionalGet(`repos/${repo}/actions/runs/${target.runId}`);
      if (result.code !== 0) {
        return undefined;
      }
      const parsed = parseJson<{ headRefOid?: string; head_sha?: string }>(result.stdout);
      const sha = parsed.headRefOid ?? parsed.head_sha ?? '';
      return isFull(sha) ? sha.toLowerCase() : undefined;
    } catch (error) {
      if (error instanceof RateLimitTimeoutError) {
        throw error;
      }
      return undefined;
    }
  }

  /** Resolve the branch tip through the API; undefined when it cannot be resolved. */
  private async branchHeadSha(repo: string, branch: string): Promise<string | undefined> {
    const encoded = branch.split('/').map(encodeURIComponent).join('/');
    try {
      const result = await this.exec(['api', `repos/${repo}/branches/${encoded}`, '--jq', '.commit.sha']);
      if (result.code !== 0) {
        return undefined;
      }
      const sha = result.stdout.trim();
      return /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
    } catch (error) {
      if (error instanceof RateLimitTimeoutError) {
        throw error;
      }
      return undefined;
    }
  }

  private async listRunsBy(repo: string, filter: 'head_sha' | 'branch', value: string): Promise<GhRunInfo[]> {
    const path = `repos/${repo}/actions/runs?${filter}=${encodeURIComponent(value)}&per_page=100`;
    const result = await this.conditionalGet(path);
    assertOk(result, `api actions/runs for ${value}`);
    const parsed = parseJson<{ workflow_runs?: unknown[] }>(result.stdout);
    return asArray(parsed.workflow_runs).map((run) => normaliseRun(restRunToGh(run, this.detailed)));
  }

  async runJobs(repo: string, runId: number): Promise<GhJobInfo[]> {
    const path = `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`;
    const result = await this.conditionalGet(path);
    assertOk(result, `api actions/runs/${runId}/jobs`);
    const items = await this.pagedItems(result, 'jobs', path, '.jobs[]', (job) => job, `api actions/runs/${runId}/jobs`);
    return items.map((job) => normaliseJob(restJobToGh(job)));
  }

  async collectFailures(repo: string, runs: GhRunInfo[]): Promise<FailedStep[]> {
    const failures: FailedStep[] = [];
    for (const run of runs) {
      if (!isFailureish(run.conclusion)) {
        continue;
      }
      const jobs = await this.runJobs(repo, run.databaseId);
      for (const job of jobs) {
        if (!isFailureish(job.conclusion)) {
          continue;
        }
        const steps = (job.steps ?? []).filter((step) => step.conclusion === 'failure');
        if (steps.length === 0) {
          failures.push({
            runId: run.databaseId,
            workflowName: run.workflowName,
            jobName: job.name,
            stepName: '',
            stepNumber: 0,
          });
          continue;
        }
        for (const step of steps) {
          failures.push({
            runId: run.databaseId,
            workflowName: run.workflowName,
            jobName: job.name,
            stepName: step.name,
            stepNumber: step.number,
          });
        }
      }
    }
    return failures;
  }
}

export function aggregateState(runs: GhRunInfo[], checks: ExternalCheck[] = []): CheckState {
  if (runs.length === 0 && checks.length === 0) {
    return 'none';
  }
  if (runs.some((run) => run.status !== 'completed') || checks.some((check) => check.status === 'pending')) {
    return 'pending';
  }
  if (runs.some((run) => isFailureish(run.conclusion)) || checks.some((check) => check.status === 'failure')) {
    return 'failure';
  }
  return 'success';
}

export function failedChecksOf(checks: ExternalCheck[]): FailedCheck[] {
  return checks
    .filter((check) => check.status === 'failure')
    .map((check) => ({ kind: check.kind, name: check.name, source: check.source, url: check.url }));
}

/**
 * Change-detection key: the run ids, then (when there are external checks) each check with its
 * status, so any status change of any check changes the key.
 */
export function runsKey(runs: GhRunInfo[], checks: ExternalCheck[] = []): string {
  const ids = runs
    .map((run) => run.databaseId)
    .sort((left, right) => left - right)
    .join(',');
  if (checks.length === 0) {
    return ids;
  }
  const parts = checks.map((check) => `${check.kind}:${check.source}:${check.name}=${check.status}`).sort();
  return `${ids}|${parts.join(',')}`;
}
