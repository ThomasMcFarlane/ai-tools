import { fetchRuns, MAX_EVENT_WAIT_SECONDS, type RunsResponse } from './events.js';
import { GhClient } from './gh.js';
import { collectReport } from './engine.js';
import type { CheckReport, GhWatchSpec, WatchTarget } from './types.js';

export type SourceChoice = 'auto' | 'events' | 'poll';
export type WaitSource = 'events' | 'poll';

export interface WaitOptions {
  repo: string;
  target: WatchTarget;
  intervalMs: number;
  timeoutMs: number;
  fallbackMs: number;
  source: SourceChoice;
  eventsUrl?: string;
}

export interface WaitDeps {
  client?: GhClient;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Called after each non-terminal check, for progress output. */
  onPending?: () => void;
}

export type WaitResult =
  | { kind: 'terminal'; report: CheckReport; source: WaitSource }
  | { kind: 'timeout'; source: WaitSource };

function adhocSpec(repo: string, target: WatchTarget): GhWatchSpec {
  return {
    name: '',
    repo,
    target,
    triggers: { failure: false, success: false },
    hook: { kind: 'none' },
    intervalSeconds: 0,
    createdAt: new Date().toISOString(),
  };
}

function isTerminal(report: CheckReport): boolean {
  return report.state === 'success' || report.state === 'failure';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a terminal state, using the event source when usable and polling `gh` otherwise. */
export async function waitForTerminal(options: WaitOptions, deps: WaitDeps = {}): Promise<WaitResult> {
  const client = deps.client ?? new GhClient();
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const deadline = Date.now() + options.timeoutMs;
  const check = (target: WatchTarget): Promise<CheckReport> =>
    collectReport(adhocSpec(options.repo, target), { client });

  if (options.source !== 'poll' && options.eventsUrl !== undefined) {
    const outcome = await waitWithEvents(options, options.eventsUrl, deadline, client, check, deps, log);
    if (outcome !== undefined) {
      return outcome;
    }
  } else if (options.source === 'events') {
    throw new Error('--source events needs an events URL (--events-url or GH_WATCHER_EVENTS_URL)');
  }
  return pollLoop(options, deadline, check, deps);
}

async function pollLoop(
  options: WaitOptions,
  deadline: number,
  check: (target: WatchTarget) => Promise<CheckReport>,
  deps: WaitDeps,
): Promise<WaitResult> {
  const sleep = deps.sleep ?? defaultSleep;
  for (;;) {
    const report = await check(options.target);
    if (isTerminal(report)) {
      return { kind: 'terminal', report, source: 'poll' };
    }
    deps.onPending?.();
    if (Date.now() >= deadline) {
      return { kind: 'timeout', source: 'poll' };
    }
    await sleep(Math.min(options.intervalMs, deadline - Date.now()));
  }
}

/** Returns undefined when the caller should poll instead (nothing consumed beyond gh calls). */
async function waitWithEvents(
  options: WaitOptions,
  baseUrl: string,
  deadline: number,
  client: GhClient,
  check: (target: WatchTarget) => Promise<CheckReport>,
  deps: WaitDeps,
  log: (line: string) => void,
): Promise<WaitResult | undefined> {
  let sha = await client.resolveHeadSha(options.repo, options.target);
  if (sha === undefined) {
    log('gh-watcher: could not resolve the head commit, polling instead');
    return undefined;
  }
  const pin = (value: string): WatchTarget =>
    options.target.kind === 'run' ? options.target : { kind: 'commit', sha: value };
  const request = (after: number, waitSeconds: number): Promise<RunsResponse> =>
    fetchRuns({ baseUrl, repo: options.repo, sha: sha as string, after, waitSeconds, fetchFn: deps.fetchFn });

  // Probe first so events landing during the initial gh check are not missed.
  let after: number;
  try {
    const probe = await request(0, 0);
    const usable = probe.owner_mode === 'app' && probe.workflow_run_subscribed;
    if (!usable && options.source === 'auto') {
      log(
        `gh-watcher: event source not usable (owner_mode=${probe.owner_mode}, workflow_run_subscribed=${String(probe.workflow_run_subscribed)}), polling instead`,
      );
      return undefined;
    }
    if (!usable) {
      log('gh-watcher: warning: event source is not in app mode with workflow_run subscribed; relying on the fallback interval');
    }
    after = probe.latest_seq;
  } catch (error) {
    log(`gh-watcher: event source unavailable (${describe(error)}), polling instead`);
    return undefined;
  }

  let report = await check(pin(sha));
  if (isTerminal(report)) {
    return { kind: 'terminal', report, source: 'events' };
  }
  deps.onPending?.();
  let lastCheck = Date.now();
  for (;;) {
    const now = Date.now();
    if (now >= deadline) {
      return { kind: 'timeout', source: 'events' };
    }
    const untilFallback = Math.max(0, options.fallbackMs - (now - lastCheck));
    const waitSeconds = Math.min(MAX_EVENT_WAIT_SECONDS, Math.ceil(Math.min(deadline - now, untilFallback) / 1000));
    let response: RunsResponse;
    try {
      response = await request(after, waitSeconds);
    } catch (error) {
      log(`gh-watcher: event source failed (${describe(error)}), polling for the rest of the wait`);
      return pollLoop(options, deadline, check, deps);
    }
    let recheck = false;
    if (response.latest_seq < after) {
      recheck = true; // service restarted: the sequence space is new
      after = response.latest_seq;
    } else {
      after = response.latest_seq;
      recheck = response.events.some((event) => (event.head_sha ?? '').toLowerCase() === sha);
    }
    const fallbackDue = Date.now() - lastCheck >= options.fallbackMs;
    if (!recheck && !fallbackDue) {
      continue;
    }
    if (fallbackDue && !recheck && options.target.kind !== 'run') {
      // Safety net: pick up a new head commit (force-push, new PR commit) as well.
      const fresh = await client.resolveHeadSha(options.repo, options.target);
      if (fresh !== undefined) {
        sha = fresh;
      }
    }
    report = await check(pin(sha));
    lastCheck = Date.now();
    if (isTerminal(report)) {
      return { kind: 'terminal', report, source: 'events' };
    }
    deps.onPending?.();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
