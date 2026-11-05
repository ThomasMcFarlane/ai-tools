import { GhClient } from './gh.js';
import { fetchPrEvents, MAX_EVENT_WAIT_SECONDS, type PrRelayEvent } from './events.js';
import { diffPr, sinceEvents, stateEvents, summarisePr } from './pr.js';
import { RateLimitTimeoutError } from './queue.js';
import type { SourceChoice } from './wait.js';
import type { PrEvent, PrEventKind, PrSnapshot, PrSummary } from './types.js';

export type PrTarget = { kind: 'pr'; number: number } | { kind: 'branch'; branch: string };

export interface PrWatchClient {
  prSnapshot(repo: string, number: number): Promise<PrSnapshot>;
  findPrForBranch(repo: string, branch: string): Promise<number | undefined>;
  setDeadline?(deadline: number | undefined): void;
}

export type PrWaitSource = 'events' | 'poll';

export interface PrWaitOptions {
  repo: string;
  target: PrTarget;
  kinds: PrEventKind[];
  /** `--on any`: every kind is wanted and the initial state is not matched. */
  any?: boolean;
  intervalMs: number;
  timeoutMs: number;
  /** ISO time: comments, reviews and inline comments after it count as new. */
  since?: string;
  changesOnly?: boolean;
  /** Defaults to poll. `auto` and `events` use the relay when `eventsUrl` is set. */
  source?: SourceChoice;
  eventsUrl?: string;
  /** Event mode: safety-net gh re-check interval. */
  fallbackMs?: number;
}

export interface PrWaitDeps {
  client?: PrWatchClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
  /** Called after each gh check, for progress output. */
  onPoll?: () => void;
  /** Called for each wanted event as it is detected. */
  onEvent?: (event: PrEvent, pr: PrSummary) => void;
}

export type PrWaitResult =
  | { kind: 'matched'; events: PrEvent[]; pr: PrSummary; source: PrWaitSource }
  | { kind: 'ended'; events: PrEvent[]; pr: PrSummary; source: PrWaitSource }
  | { kind: 'timeout'; events: PrEvent[]; pr?: PrSummary; source: PrWaitSource };

const DEFAULT_FALLBACK_MS = 5 * 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function watchPr(options: PrWaitOptions, deps: PrWaitDeps, follow: boolean): Promise<PrWaitResult> {
  const choice: SourceChoice = options.source ?? 'poll';
  if (choice === 'events' && options.eventsUrl === undefined) {
    throw new Error('--source events needs an events URL (--events-url or GH_WATCHER_EVENTS_URL)');
  }
  const client = deps.client ?? new GhClient();
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fallbackMs = options.fallbackMs ?? DEFAULT_FALLBACK_MS;
  const deadline = now() + options.timeoutMs;
  client.setDeadline?.(deadline);
  const wanted = new Set<PrEventKind>(options.kinds);
  const seen: PrEvent[] = [];
  let summary: PrSummary | undefined;
  let previous: PrSnapshot | undefined;
  let number: number | undefined = options.target.kind === 'pr' ? options.target.number : undefined;
  let source: PrWaitSource = 'poll';

  const settle = (events: PrEvent[], snapshot: PrSnapshot): PrWaitResult | undefined => {
    summary = summarisePr(snapshot);
    let matched = false;
    for (const event of events) {
      seen.push(event);
      if (wanted.has(event.kind)) {
        matched = true;
        deps.onEvent?.(event, summary);
      }
    }
    if (follow) {
      return snapshot.state === 'OPEN' ? undefined : { kind: 'ended', events: seen, pr: summary, source };
    }
    return matched ? { kind: 'matched', events: seen, pr: summary, source } : undefined;
  };

  /** One gh check against the previous snapshot; gh stays the source of truth in both modes. */
  const check = async (): Promise<PrWaitResult | undefined> => {
    if (number === undefined) {
      if (options.target.kind === 'branch') {
        number = await client.findPrForBranch(options.repo, options.target.branch);
      }
      deps.onPoll?.();
      if (number === undefined) {
        return undefined;
      }
      const snapshot = await client.prSnapshot(options.repo, number);
      previous = snapshot;
      const events = diffPr(undefined, snapshot);
      if (options.since !== undefined) {
        events.push(...sinceEvents(snapshot, options.since));
      }
      return settle(events, snapshot);
    }
    const snapshot = await client.prSnapshot(options.repo, number);
    deps.onPoll?.();
    const events = previous === undefined ? [] : diffPr(previous, snapshot);
    previous = snapshot;
    return settle(events, snapshot);
  };

  const relayParams = (): { pr?: number; headRef?: string } =>
    number !== undefined
      ? { pr: number }
      : options.target.kind === 'branch'
        ? { headRef: options.target.branch }
        : {};
  const isRelevant = (event: PrRelayEvent): boolean => {
    if (number !== undefined && event.pr === number) {
      return true;
    }
    return options.target.kind === 'branch' && event.head_ref === options.target.branch;
  };

  try {
    // Probe the relay before the baseline so events landing during the first gh check are not missed.
    let after = 0;
    if (choice !== 'poll' && options.eventsUrl !== undefined) {
      try {
        const probe = await fetchPrEvents({
          baseUrl: options.eventsUrl,
          repo: options.repo,
          ...relayParams(),
          after: 0,
          waitSeconds: 0,
          fetchFn: deps.fetchFn,
        });
        const usable = probe.owner_mode === 'app' && probe.pr_events_subscribed;
        if (!usable && choice === 'auto') {
          log(
            `gh-watcher: event source not usable for pull requests (owner_mode=${probe.owner_mode}, pr_events_subscribed=${String(probe.pr_events_subscribed)}), polling instead`,
          );
        } else {
          if (!usable) {
            log('gh-watcher: warning: event source is not in app mode with pull request events subscribed; relying on the fallback interval');
          }
          source = 'events';
          after = probe.latest_seq;
        }
      } catch (error) {
        log(`gh-watcher: event source unavailable (${describe(error)}), polling instead`);
      }
    }

    if (number === undefined && options.target.kind === 'branch') {
      number = await client.findPrForBranch(options.repo, options.target.branch);
    }
    if (number !== undefined) {
      const baseline = await client.prSnapshot(options.repo, number);
      previous = baseline;
      const events: PrEvent[] = [];
      if (options.changesOnly !== true && options.any !== true) {
        for (const event of stateEvents(baseline)) {
          if (wanted.has(event.kind)) {
            events.push({ ...event, initial: true });
          }
        }
      }
      if (options.since !== undefined) {
        events.push(...sinceEvents(baseline, options.since));
      }
      const first = settle(events, baseline);
      if (first !== undefined) {
        return first;
      }
    }

    let lastCheck = now();
    for (;;) {
      if (now() >= deadline) {
        return { kind: 'timeout', events: seen, pr: summary, source };
      }
      if (source === 'poll') {
        await sleep(Math.min(options.intervalMs, Math.max(0, deadline - now())));
      } else {
        const untilFallback = Math.max(0, fallbackMs - (now() - lastCheck));
        const waitSeconds = Math.min(
          MAX_EVENT_WAIT_SECONDS,
          Math.ceil(Math.min(deadline - now(), untilFallback) / 1000),
        );
        let wake = false;
        try {
          const response = await fetchPrEvents({
            baseUrl: options.eventsUrl as string,
            repo: options.repo,
            ...relayParams(),
            after,
            waitSeconds,
            fetchFn: deps.fetchFn,
          });
          if (response.latest_seq < after) {
            wake = true; // relay restarted: the sequence space is new
          } else {
            wake = response.events.some((event) => isRelevant(event));
          }
          after = response.latest_seq;
        } catch (error) {
          log(`gh-watcher: event source failed (${describe(error)}), polling for the rest of the wait`);
          source = 'poll';
          continue;
        }
        if (!wake && now() - lastCheck < fallbackMs) {
          continue;
        }
      }
      const result = await check();
      lastCheck = now();
      if (result !== undefined) {
        return result;
      }
    }
  } catch (error) {
    if (error instanceof RateLimitTimeoutError) {
      return { kind: 'timeout', events: seen, pr: summary, source };
    }
    throw error;
  } finally {
    client.setDeadline?.(undefined);
  }
}

/** Return as soon as a wanted pull request event is detected (or already holds, unless `changesOnly`). */
export function waitForPrEvent(options: PrWaitOptions, deps: PrWaitDeps = {}): Promise<PrWaitResult> {
  return watchPr(options, deps, false);
}

/** Report every wanted event through `onEvent` until the pull request is merged or closed, or the time runs out. */
export function followPrEvents(options: PrWaitOptions, deps: PrWaitDeps = {}): Promise<PrWaitResult> {
  return watchPr(options, deps, true);
}
