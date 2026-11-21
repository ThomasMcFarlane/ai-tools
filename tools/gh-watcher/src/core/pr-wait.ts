import { MAX_EVENT_WAIT_SECONDS } from './events.js';
import { diffPr, sinceEvents, stateEvents, summarisePr } from './pr.js';
import { prStatusToSnapshot, RelaySession } from './relay.js';
import type { PrEvent, PrEventKind, PrSnapshot, PrSummary } from './types.js';

export type PrTarget = { kind: 'pr'; number: number } | { kind: 'branch'; branch: string };

/** The state always comes from the relay. */
export type PrWaitSource = 'relay';

export interface PrWaitOptions {
  repo: string;
  target: PrTarget;
  kinds: PrEventKind[];
  /** `--on any`: every kind is wanted and the initial state is not matched. */
  any?: boolean;
  timeoutMs: number;
  /** ISO time: comments, reviews and inline comments after it count as new. */
  since?: string;
  changesOnly?: boolean;
  /** Relay base URL; undefined makes the wait fail with `relay_unreachable` at the timeout. */
  eventsUrl?: string;
}

export interface PrWaitDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
  /** Called after each relay answer, for progress output. */
  onPoll?: () => void;
  /** Called for each wanted event as it is detected. */
  onEvent?: (event: PrEvent, pr: PrSummary) => void;
}

export type PrWaitResult =
  | { kind: 'matched'; events: PrEvent[]; pr: PrSummary; source: PrWaitSource; relaySource?: 'webhook' | 'relay-poll'; warning?: string }
  | { kind: 'ended'; events: PrEvent[]; pr: PrSummary; source: PrWaitSource; relaySource?: 'webhook' | 'relay-poll'; warning?: string }
  | { kind: 'timeout'; events: PrEvent[]; pr?: PrSummary; source: PrWaitSource; relaySource?: 'webhook' | 'relay-poll'; warning?: string };

async function watchPr(options: PrWaitOptions, deps: PrWaitDeps, follow: boolean): Promise<PrWaitResult> {
  const clock = deps.now ?? Date.now;
  const deadline = clock() + options.timeoutMs;
  const session = new RelaySession({
    baseUrl: options.eventsUrl,
    fetchFn: deps.fetchFn,
    sleep: deps.sleep,
    log: deps.log,
    now: deps.now,
    deadline,
  });
  const wanted = new Set<PrEventKind>(options.kinds);
  const seen: PrEvent[] = [];
  let summary: PrSummary | undefined;
  let previous: PrSnapshot | undefined;
  let relaySource: 'webhook' | 'relay-poll' | undefined;
  let warning: string | undefined;
  const extra = (): { relaySource?: 'webhook' | 'relay-poll'; warning?: string } => ({
    ...(relaySource !== undefined ? { relaySource } : {}),
    ...(warning !== undefined ? { warning } : {}),
  });

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
      return snapshot.state === 'OPEN' ? undefined : { kind: 'ended', events: seen, pr: summary, source: 'relay', ...extra() };
    }
    return matched ? { kind: 'matched', events: seen, pr: summary, source: 'relay', ...extra() } : undefined;
  };

  const prTarget = options.target.kind === 'pr' ? { number: options.target.number } : { branch: options.target.branch };
  let after = 0;
  let probed = false;
  let sawNone = false;
  for (;;) {
    const remaining = deadline - clock();
    if (remaining <= 0 && previous !== undefined) {
      return { kind: 'timeout', events: seen, pr: summary, source: 'relay', ...extra() };
    }
    const waitSeconds = !probed ? 0 : Math.min(MAX_EVENT_WAIT_SECONDS, Math.max(1, Math.ceil(remaining / 1000)));
    const response = await session.prStatus(options.repo, prTarget, after, waitSeconds, options.since);
    probed = true;
    deps.onPoll?.();
    relaySource = response.source;
    warning = response.warning ?? warning;
    const restarted = response.rev < after || response.bootChanged === true;
    // A new boot means the relay restarted: its revisions start again, so never keep the old `after`.
    after = response.bootChanged === true ? 0 : response.rev;
    const snapshot = prStatusToSnapshot(response);
    if (snapshot !== undefined && (previous === undefined || response.changed || restarted)) {
      let events: PrEvent[];
      if (previous === undefined || previous.number !== snapshot.number) {
        events = [];
        if (previous !== undefined || sawNone) {
          // A pull request appeared after the start, or replaced the one watched.
          events.push(...diffPr(undefined, snapshot));
        } else if (options.changesOnly !== true && options.any !== true) {
          for (const event of stateEvents(snapshot)) {
            if (wanted.has(event.kind)) {
              events.push({ ...event, initial: true });
            }
          }
        }
        if (options.since !== undefined) {
          events.push(...sinceEvents(snapshot, options.since));
        }
      } else {
        events = diffPr(previous, snapshot);
      }
      previous = snapshot;
      const result = settle(events, snapshot);
      if (result !== undefined) {
        return result;
      }
    }
    if (snapshot === undefined) {
      sawNone = true;
    }
    if (deadline - clock() <= 0) {
      return { kind: 'timeout', events: seen, pr: summary, source: 'relay', ...extra() };
    }
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
