import { fetchRuns, MAX_EVENT_WAIT_SECONDS, type RunEvent, type RunsResponse } from './events.js';
import { applyRunEvents } from './apply-events.js';
import { aggregateState, GhClient } from './gh.js';
import { RateLimitTimeoutError } from './queue.js';
import { collectReport } from './engine.js';
import type { CheckReport, GhRunInfo, GhWatchSpec, WatchTarget } from './types.js';

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
  onPending?: (report: CheckReport, source: WaitSource) => void | Promise<void>;
}

/** In auto mode, a poll fallback after a failed relay never polls faster than this. */
export const AUTO_POLL_MIN_MS = 120_000;

/** Mutable note shared by the event and poll paths: set when auto mode fell back because the relay failed. */
interface FallbackState {
  minIntervalMs: number;
}

/** 1 normally; larger while the shared GitHub REST budget is low. Test fakes without the method count as 1. */
function budgetFactor(client: GhClient): number {
  return (client as Partial<GhClient>).pollFactor?.() ?? 1;
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

/**
 * The relay only delivers Actions `workflow_run` events, so a pending non-Actions check (or no
 * checks seen yet, which may be statuses that have not started) can only be noticed by polling.
 */
function needsPolling(report: CheckReport): boolean {
  return report.state === 'none' || report.checks.some((check) => check.status === 'pending');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a terminal state, using the event source when usable and polling `gh` otherwise. */
export async function waitForTerminal(options: WaitOptions, deps: WaitDeps = {}): Promise<WaitResult> {
  const client = deps.client ?? new GhClient({ detailedRuns: true });
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const deadline = Date.now() + options.timeoutMs;
  client.setDeadline(deadline);
  const check = (target: WatchTarget): Promise<CheckReport> =>
    collectReport(adhocSpec(options.repo, target), { client });
  const fallback: FallbackState = { minIntervalMs: 0 };

  if (options.source !== 'poll' && options.eventsUrl !== undefined) {
    try {
      const outcome = await waitWithEvents(options, options.eventsUrl, deadline, client, check, deps, log, fallback);
      if (outcome !== undefined) {
        return outcome;
      }
    } catch (error) {
      if (error instanceof RateLimitTimeoutError) {
        return { kind: 'timeout', source: 'events' };
      }
      throw error;
    }
  } else if (options.source === 'events') {
    throw new Error('--source events needs an events URL (--events-url or GH_WATCHER_EVENTS_URL)');
  }
  return pollLoop(options, deadline, check, deps, client, fallback);
}

async function pollLoop(
  options: WaitOptions,
  deadline: number,
  check: (target: WatchTarget) => Promise<CheckReport>,
  deps: WaitDeps,
  client: GhClient,
  fallback: FallbackState,
): Promise<WaitResult> {
  try {
    return await pollLoopInner(options, deadline, check, deps, client, fallback);
  } catch (error) {
    if (error instanceof RateLimitTimeoutError) {
      return { kind: 'timeout', source: 'poll' };
    }
    throw error;
  }
}

async function pollLoopInner(
  options: WaitOptions,
  deadline: number,
  check: (target: WatchTarget) => Promise<CheckReport>,
  deps: WaitDeps,
  client: GhClient,
  fallback: FallbackState,
): Promise<WaitResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const intervalMs = Math.max(options.intervalMs, fallback.minIntervalMs);
  for (;;) {
    const report = await check(options.target);
    if (isTerminal(report)) {
      return { kind: 'terminal', report, source: 'poll' };
    }
    await deps.onPending?.(report, 'poll');
    if (Date.now() >= deadline) {
      return { kind: 'timeout', source: 'poll' };
    }
    await sleep(Math.min(intervalMs * budgetFactor(client), deadline - Date.now()));
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
  fallback: FallbackState,
): Promise<WaitResult | undefined> {
  const relayDown = (): void => {
    if (options.source === 'auto') {
      log(`gh-watcher: WARNING relay unreachable at ${baseUrl}, polling GitHub`);
      fallback.minIntervalMs = AUTO_POLL_MIN_MS;
    }
  };
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
    relayDown();
    return undefined;
  }

  let report = await check(pin(sha));
  if (isTerminal(report)) {
    return { kind: 'terminal', report, source: 'events' };
  }
  await deps.onPending?.(report, 'events');
  let lastCheck = Date.now();
  for (;;) {
    const now = Date.now();
    if (now >= deadline) {
      return { kind: 'timeout', source: 'events' };
    }
    const polling = needsPolling(report);
    const factor = budgetFactor(client);
    const recheckMs = (polling ? Math.min(options.fallbackMs, options.intervalMs) : options.fallbackMs) * factor;
    const untilFallback = Math.max(0, recheckMs - (now - lastCheck));
    const waitSeconds = Math.min(MAX_EVENT_WAIT_SECONDS, Math.ceil(Math.min(deadline - now, untilFallback) / 1000));
    let response: RunsResponse;
    try {
      response = await request(after, waitSeconds);
    } catch (error) {
      log(`gh-watcher: event source failed (${describe(error)}), polling for the rest of the wait`);
      relayDown();
      return pollLoop(options, deadline, check, deps, client, fallback);
    }
    let full = false;
    let matching: RunEvent[] = [];
    if (response.latest_seq < after) {
      full = true; // service restarted: the sequence space is new
    } else {
      matching = response.events.filter((event) => (event.head_sha ?? '').toLowerCase() === sha);
    }
    after = response.latest_seq;
    let confirm = false;
    if (matching.length > 0) {
      const applied = applyRunEvents(report.runs, matching, options.target);
      if (applied.unmappable) {
        full = true;
      } else if (applied.changed) {
        const local = localReport(report, applied.runs);
        if (isTerminal(local)) {
          // Event data alone never ends a wait: confirm with a fresh gh check.
          confirm = true;
        } else {
          report = local;
          await deps.onPending?.(report, 'events');
        }
      }
    }
    const fallbackDue = Date.now() - lastCheck >= recheckMs;
    full = full || confirm;
    if (!full && !fallbackDue) {
      continue;
    }
    if (fallbackDue && !full && options.target.kind !== 'run') {
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
    await deps.onPending?.(report, 'events');
  }
}

/** Recompute the state locally from updated runs; failed steps are only fetched by a confirming check. */
function localReport(previous: CheckReport, runs: GhRunInfo[]): CheckReport {
  return { ...previous, state: aggregateState(runs, previous.checks), runs, failedSteps: [], failedChecks: [], checkedAt: new Date().toISOString() };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
