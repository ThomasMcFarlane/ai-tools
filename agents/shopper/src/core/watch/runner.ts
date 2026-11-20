import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ShopperDefaults } from '../defaults.js';
import { parseInterval } from '../defaults.js';
import { runSearch, type RunDeps, type SearchOutput } from '../run.js';
import type { Condition, SearchHit } from '../types.js';
import {
  EMPTY_PREVIOUS,
  diffRun,
  mergeEvents,
  siteFailed,
  type SiteOutcome,
  type WatchEvent,
} from './diff.js';
import {
  appendHistory,
  pendingEvents,
  previousState,
  readHistory,
  type HistoryLine,
} from './history.js';
import {
  formatMessage,
  notify as sendNotification,
  type NotifyResult,
  type SpawnFn,
} from './notify.js';
import {
  historyFile,
  readWatches,
  recordRun,
  specHash,
  type Watch,
  type WatchPaths,
} from './store.js';

export const LOCK_STALE_MS = 2 * 3_600_000;
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

export interface WatchDeps {
  runDeps: RunDeps;
  defaults: ShopperDefaults;
  defaultsSource: string;
  paths: WatchPaths;
  now: () => Date;
  notifyCommand: string | null;
  env: NodeJS.ProcessEnv;
  spawn: SpawnFn;
  print: ((text: string) => void) | null;
  search?: typeof runSearch;
}

export interface RunWatchOptions {
  notify: boolean;
}

export type RunStatus = 'ok' | 'changes' | 'error' | 'baseline';

export interface WatchRunResult {
  watchId: string;
  ts: string;
  status: RunStatus;
  baseline: boolean;
  hits: SearchHit[];
  events: WatchEvent[];
  pendingEvents: WatchEvent[];
  sites: Record<string, SiteOutcome>;
  skipped: Array<{ site: string; reason: string }>;
  errors: Array<{ site: string; message: string }>;
  message: string | null;
  notify: NotifyResult | null;
}

export interface Lock {
  release: () => void;
}

interface LockContent {
  pid: number;
  startedAt: string;
  token: string;
}

export interface LockOptions {
  staleMs?: number;
  isAlive?: (pid: number) => boolean;
  afterTakeover?: () => void;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file: string): LockContent | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockContent>;
    if (typeof parsed.startedAt === 'string' && typeof parsed.token === 'string') {
      return parsed as LockContent;
    }
  } catch {
    return null;
  }
  return null;
}

function lockStartedAt(file: string, held: LockContent | null): number | null {
  if (held !== null) {
    const time = new Date(held.startedAt).getTime();
    if (!Number.isNaN(time)) return time;
  }
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export function acquireLock(file: string, now: Date, options: LockOptions = {}): Lock | null {
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const isAlive = options.isAlive ?? pidAlive;
  mkdirSync(dirname(file), { recursive: true });
  const content: LockContent = {
    pid: process.pid,
    startedAt: now.toISOString(),
    token: randomBytes(8).toString('hex'),
  };
  const body = JSON.stringify(content);
  try {
    writeFileSync(file, body, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const held = readLock(file);
    const started = lockStartedAt(file, held);
    const dead = held !== null && typeof held.pid === 'number' && !isAlive(held.pid);
    const stale = started === null || now.getTime() - started > staleMs;
    if (!dead && !stale) return null;
    const temp = `${file}.${content.token}.tmp`;
    writeFileSync(temp, body);
    renameSync(temp, file);
    options.afterTakeover?.();
    if (readLock(file)?.token !== content.token) return null;
  }
  return {
    release: () => {
      const held = readLock(file);
      if (held !== null && held.token === content.token) rmSync(file, { force: true });
    },
  };
}

export function isDue(watch: Watch, now: Date): boolean {
  if (!watch.enabled) return false;
  if (watch.lastRunAt === null) return true;
  const interval = parseInterval(watch.interval);
  if (interval === null) return true;
  return new Date(watch.lastRunAt).getTime() + interval <= now.getTime();
}

export function nextRunAt(watch: Watch, now: Date): string | null {
  if (!watch.enabled) return null;
  if (watch.lastRunAt === null) return now.toISOString();
  const interval = parseInterval(watch.interval);
  if (interval === null) return now.toISOString();
  return new Date(new Date(watch.lastRunAt).getTime() + interval).toISOString();
}

export function matchesSpec(title: string, spec: Watch['spec']): boolean {
  for (const pattern of spec.include) {
    if (!new RegExp(pattern, 'i').test(title)) return false;
  }
  for (const pattern of spec.exclude) {
    if (new RegExp(pattern, 'i').test(title)) return false;
  }
  return true;
}

function queryIdParams(deps: WatchDeps): Record<string, readonly string[]> {
  const params: Record<string, readonly string[]> = {};
  for (const adapter of deps.runDeps.adapters) {
    const declared = (adapter as { idQueryParams?: readonly string[] }).idQueryParams;
    if (declared !== undefined) params[adapter.id] = declared;
  }
  return params;
}

function historySites(output: SearchOutput, hits: SearchHit[]): Record<string, SiteOutcome> {
  const sites: Record<string, SiteOutcome> = {};
  for (const [id, report] of Object.entries(output.sites)) {
    if (report.status === 'needs-user-browser') continue;
    const count = hits.filter((hit) => hit.site === id).length;
    const status = report.status === 'ok' && count === 0 ? 'empty' : report.status;
    sites[id] = {
      status,
      count: status === 'ok' || status === 'empty' ? count : report.count,
      ...(report.reason === undefined ? {} : { reason: report.reason }),
    };
  }
  return sites;
}

function stripRaw(hit: SearchHit): SearchHit {
  const copy = { ...hit };
  delete copy.raw;
  return copy;
}

export async function runWatch(
  watch: Watch,
  deps: WatchDeps,
  opts: RunWatchOptions,
): Promise<WatchRunResult> {
  const now = deps.now();
  const search = deps.search ?? runSearch;
  const currency = watch.currency ?? deps.defaults.currency;
  const budget = { ...deps.defaults.budget };
  delete budget.max;
  const defaults: ShopperDefaults = { ...deps.defaults, currency, budget };

  const output = await search(
    {
      query: watch.query,
      defaults,
      defaultsSource: deps.defaultsSource,
      includeOos: true,
      limit: NO_LIMIT,
      ...(watch.sites === null ? {} : { sites: watch.sites }),
      ...(watch.condition === null ? {} : { condition: watch.condition as Condition[] }),
    },
    deps.runDeps,
  );

  const hits = output.hits.filter((hit) => matchesSpec(hit.title, watch.spec)).map(stripRaw);
  const sites = historySites(output, hits);
  const file = historyFile(deps.paths, watch.id);
  const lines = readHistory(file);
  const hash = specHash(watch);
  const lastHash = lines.at(-1)?.specHash;
  const previous =
    lastHash !== undefined && lastHash !== hash ? EMPTY_PREVIOUS : previousState(lines);
  const events = diffRun({
    hits,
    sites,
    previous,
    options: {
      maxPrice: watch.maxPrice,
      minDropPercent: watch.notify.minDropPercent,
      currency,
      notifyOn: watch.notify.on,
      queryIdParams: queryIdParams(deps),
    },
  });

  const errors = [...output.errors];
  const attempted = Object.values(sites);
  if (attempted.length === 0) {
    errors.push({ site: '-', message: 'no site can run in a scheduled run' });
  }
  const failed = attempted.length === 0 || attempted.every((site) => siteFailed(site.status));
  const baseline = !previous.hasHistory;
  const status: RunStatus = failed
    ? 'error'
    : baseline
      ? 'baseline'
      : events.length > 0
        ? 'changes'
        : 'ok';

  const pending = pendingEvents(lines);
  const toSend = mergeEvents(pending, events);
  const quiet = deps.defaults.watch.quietUnchanged;
  const message =
    toSend.length > 0 || !quiet
      ? formatMessage({
          watchId: watch.id,
          events: toSend,
          timeZones: deps.defaults.report.timeZones,
          at: now,
        })
      : null;
  let notified: NotifyResult | null = null;
  if (opts.notify) {
    notified = await sendNotification({
      watchId: watch.id,
      events: toSend,
      message: message ?? '',
      command: deps.notifyCommand,
      quietUnchanged: quiet,
      env: deps.env,
      spawn: deps.spawn,
      print: deps.print,
    });
  }
  const delivered = opts.notify && notified?.ok === true;

  const line: HistoryLine = {
    v: 1,
    ts: now.toISOString(),
    watchId: watch.id,
    hits,
    sites,
    errors,
    events,
    notified: delivered,
    specHash: hash,
  };
  appendHistory(file, line);
  recordRun(deps.paths.watchesFile, watch.id, now, status);

  return {
    watchId: watch.id,
    ts: line.ts,
    status,
    baseline,
    hits,
    events,
    pendingEvents: pending,
    sites,
    skipped: output.needsUserBrowser.map((item) => ({
      site: item.site,
      reason: 'needs the user browser, never part of a scheduled run',
    })),
    errors,
    message,
    notify: notified,
  };
}

export interface DueResult {
  locked: boolean;
  due: string[];
  results: WatchRunResult[];
  failures: Array<{ watchId: string; message: string }>;
}

export async function runDue(deps: WatchDeps, opts: RunWatchOptions): Promise<DueResult> {
  const lock = acquireLock(deps.paths.lockFile, deps.now());
  if (lock === null) return { locked: true, due: [], results: [], failures: [] };
  const result: DueResult = { locked: false, due: [], results: [], failures: [] };
  try {
    const due = readWatches(deps.paths.watchesFile).watches.filter((watch) =>
      isDue(watch, deps.now()),
    );
    result.due = due.map((watch) => watch.id);
    for (const watch of due) {
      try {
        result.results.push(await runWatch(watch, deps, opts));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failures.push({ watchId: watch.id, message });
        try {
          recordRun(deps.paths.watchesFile, watch.id, deps.now(), 'error');
        } catch {
          continue;
        }
      }
    }
  } finally {
    lock.release();
  }
  return result;
}

export async function runOne(
  watch: Watch,
  deps: WatchDeps,
  opts: RunWatchOptions,
): Promise<WatchRunResult | null> {
  const lock = acquireLock(deps.paths.lockFile, deps.now());
  if (lock === null) return null;
  try {
    return await runWatch(watch, deps, opts);
  } finally {
    lock.release();
  }
}
