import { MAX_EVENT_WAIT_SECONDS } from './events.js';
import { RelaySession, type StatusResponse } from './relay.js';
import { snapshotToReport } from './relay.js';
import type { CheckReport, CheckState, WatchTarget } from './types.js';

/** The state always comes from the relay. */
export type WaitSource = 'relay';

export interface WaitOptions {
  repo: string;
  target: WatchTarget;
  timeoutMs: number;
  /** Relay base URL; undefined makes the wait fail with `relay_unreachable` at the timeout. */
  eventsUrl?: string;
  /** Ask the relay for jobs of every run (follow). Failed runs always carry their jobs. */
  jobs?: boolean;
}

export interface WaitDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
  /** Called after each non-terminal snapshot that changed, for progress output. */
  onPending?: (report: CheckReport, snapshot: StatusResponse) => void | Promise<void>;
}

export type WaitResult =
  | { kind: 'terminal'; report: CheckReport; snapshot: StatusResponse; source: WaitSource }
  | { kind: 'timeout'; source: WaitSource; state: CheckState; relaySource?: 'webhook' | 'relay-poll'; warning?: string };

/** After this long with no run, check or status at all, tell the user that no checks exist yet. */
export const NO_CHECKS_NOTICE_MS = 30_000;

/** Terminal only for a finished, non-empty set: `none` and `pending` never end a wait. */
export function isTerminal(report: CheckReport): boolean {
  return (report.state === 'success' && (report.runs.length > 0 || report.checks.length > 0)) || report.state === 'failure';
}

/** Wait for a terminal state by long-polling the relay. No call to GitHub is made. */
export async function waitForTerminal(options: WaitOptions, deps: WaitDeps = {}): Promise<WaitResult> {
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
  const startedAt = clock();
  let noticed = false;
  let after = 0;
  let last: CheckReport | undefined;
  for (;;) {
    const remaining = deadline - clock();
    if (remaining <= 0 && last !== undefined) {
      return timeout(last);
    }
    const waitSeconds = last === undefined ? 0 : Math.min(MAX_EVENT_WAIT_SECONDS, Math.max(1, Math.ceil(remaining / 1000)));
    const snapshot = await session.status(options.target, options.repo, after, waitSeconds, options.jobs === true);
    const report = snapshotToReport(options.repo, options.target, snapshot);
    const first = last === undefined;
    last = report;
    if (isTerminal(report)) {
      return { kind: 'terminal', report, snapshot, source: 'relay' };
    }
    if (report.state === 'none' && !noticed && clock() - startedAt >= NO_CHECKS_NOTICE_MS) {
      noticed = true;
      (deps.log ?? ((line: string) => process.stderr.write(`${line}\n`)))('gh-watcher: no checks exist yet for this target; still waiting');
    }
    if (snapshot.rev < after || snapshot.changed || snapshot.bootChanged === true || first) {
      await deps.onPending?.(report, snapshot);
    }
    // A new boot means the relay restarted: its revisions start again, so never keep the old `after`.
    after = snapshot.bootChanged === true ? 0 : snapshot.rev;
    if (deadline - clock() <= 0) {
      return timeout(report);
    }
  }
}

function timeout(report: CheckReport): WaitResult {
  const result: WaitResult = { kind: 'timeout', source: 'relay', state: report.state === 'none' ? 'none' : 'pending' };
  if (report.relaySource !== undefined) {
    result.relaySource = report.relaySource;
  }
  if (report.warning !== undefined) {
    result.warning = report.warning;
  }
  return result;
}

/** One non-blocking read of the relay snapshot. */
export async function readStatus(
  options: Pick<WaitOptions, 'repo' | 'target' | 'timeoutMs' | 'eventsUrl'>,
  deps: Omit<WaitDeps, 'onPending'> = {},
): Promise<CheckReport> {
  const clock = deps.now ?? Date.now;
  const session = new RelaySession({
    baseUrl: options.eventsUrl,
    fetchFn: deps.fetchFn,
    sleep: deps.sleep,
    log: deps.log,
    now: deps.now,
    deadline: clock() + options.timeoutMs,
  });
  const snapshot = await session.status(options.target, options.repo, 0, 0, false);
  return snapshotToReport(options.repo, options.target, snapshot);
}
