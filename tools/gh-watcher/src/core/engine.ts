import { fireHook, type HookEvent, type HookResult } from '@ai-tools/hooks';
import { aggregateState, failedChecksOf, GhClient, runsKey, sameRunsKey } from './gh.js';
import { appendEvent, loadState, saveState } from './store.js';
import { describePrEvent, diffPr, lastStateToBase, lastStateToReuse, summarisePr, toLastState } from './pr.js';
import { targetKey } from './types.js';
import type {
  CheckReport,
  CheckState,
  FailedCheck,
  FailedStep,
  GhEvent,
  GhWatchSpec,
  GhWatcherState,
  PrEvent,
  PrLastState,
  PrSnapshot,
} from './types.js';

export interface EngineDeps {
  client?: GhClient;
  fireHookFn?: typeof fireHook;
  now?: () => Date;
}

export interface RunDaemonOptions {
  pollSeconds?: number;
  /** External stop request, handled like SIGINT/SIGTERM. */
  signal?: AbortSignal;
}

function selectWatchers(watchers: GhWatchSpec[], names: string[] | undefined): GhWatchSpec[] {
  if (names === undefined) {
    return [...watchers];
  }
  for (const name of names) {
    if (!watchers.some((watcher) => watcher.name === name)) {
      throw new Error(`unknown watch "${name}"`);
    }
  }
  const wanted = new Set(names);
  return watchers.filter((watcher) => wanted.has(watcher.name));
}

function syncSpec(target: GhWatchSpec, spec: GhWatchSpec): void {
  target.repo = spec.repo;
  target.target = spec.target;
  target.triggers = spec.triggers;
  target.hook = spec.hook;
  target.intervalSeconds = spec.intervalSeconds;
  target.createdAt = spec.createdAt;
  if (spec.prEvents === undefined) {
    delete target.prEvents;
  } else {
    target.prEvents = spec.prEvents;
  }
}

function summaryLines(
  repo: string,
  key: string,
  state: CheckState,
  failedSteps: FailedStep[],
  failedChecks: FailedCheck[],
): string[] {
  const lines = [`gh-watcher: ${repo} ${key} is ${state}`];
  if (state === 'failure') {
    for (const step of failedSteps.slice(0, 3)) {
      lines.push(`step ${step.stepNumber} '${step.stepName}' failed in job '${step.jobName}' (run ${step.runId})`);
    }
    for (const check of failedChecks.slice(0, 3)) {
      lines.push(`check '${check.name}' failed${check.url.length > 0 ? ` (${check.url})` : ''}`);
    }
  }
  return lines;
}

export function describeEvent(event: GhEvent): string {
  const lines = summaryLines(event.repo, event.targetKey, event.state, event.failedSteps, event.failedChecks ?? []);
  for (const prEvent of event.prEvents ?? []) {
    lines.push(`pr event: ${describePrEvent(prEvent)}`);
  }
  if (event.error !== undefined) {
    lines.push(`error: ${event.error}`);
  }
  return lines.join('\n');
}

interface PrCheck {
  snapshot?: PrSnapshot;
  matched: PrEvent[];
  next: PrLastState | null | undefined;
}

async function checkPr(spec: GhWatchSpec, last: PrLastState | null | undefined, client: GhClient): Promise<PrCheck> {
  const wanted = new Set(spec.prEvents ?? []);
  let number: number | undefined;
  if (spec.target.kind === 'pr') {
    number = spec.target.number;
  } else if (spec.target.kind === 'branch') {
    number = await client.findPrForBranch(spec.repo, spec.target.branch);
  }
  if (number === undefined) {
    return { matched: [], next: last === undefined ? null : last };
  }
  const sameNumber = last !== null && last !== undefined && last.number === number;
  const snapshot = await client.prSnapshot(spec.repo, number, sameNumber ? lastStateToReuse(last) : undefined);
  const next = toLastState(snapshot);
  if (last === undefined) {
    return { snapshot, matched: [], next };
  }
  const replaced = last !== null && last.number !== snapshot.number;
  const events = diffPr(last === null || replaced ? undefined : lastStateToBase(last), snapshot);
  return { snapshot, matched: events.filter((event) => wanted.has(event.kind)), next };
}

export async function collectReport(spec: GhWatchSpec, deps?: EngineDeps): Promise<CheckReport> {
  const client = deps?.client ?? new GhClient();
  const now = deps?.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const resolved: { sha?: string } = {};
  const runs = await client.listRuns(spec.repo, spec.target, resolved);
  const { checks, unavailable } = await client.listChecks(spec.repo, spec.target, runs, resolved.sha);
  const state = aggregateState(runs, checks);
  const failedSteps = state === 'failure' ? await client.collectFailures(spec.repo, runs) : [];
  const failedChecks = state === 'failure' ? failedChecksOf(checks) : [];
  const report: CheckReport = {
    repo: spec.repo,
    target: spec.target,
    targetKey: targetKey(spec.target),
    state,
    runs,
    checks,
    failedSteps,
    failedChecks,
    checkedAt,
  };
  if (unavailable !== undefined) {
    report.checksUnavailable = unavailable;
  }
  return report;
}

async function checkOne(spec: GhWatchSpec, deps: EngineDeps | undefined, manual: boolean): Promise<GhEvent> {
  const fireHookFn = deps?.fireHookFn ?? fireHook;
  const state: GhWatcherState = await loadState();
  let target = state.watchers.find((watcher) => watcher.name === spec.name);
  if (target === undefined) {
    target = { ...spec };
    state.watchers.push(target);
  } else {
    syncSpec(target, spec);
  }
  const wantsPr = spec.prEvents !== undefined && spec.prEvents.length > 0;
  const wantsCi = !wantsPr || spec.triggers.failure || spec.triggers.success;
  const report: CheckReport = wantsCi
    ? await collectReport(spec, deps)
    : {
        repo: spec.repo,
        target: spec.target,
        targetKey: targetKey(spec.target),
        state: 'none',
        runs: [],
        checks: [],
        failedSteps: [],
        failedChecks: [],
        checkedAt: (deps?.now ?? (() => new Date()))().toISOString(),
      };
  const key = runsKey(report.runs, report.checks);
  const last = state.lastFired[spec.name];
  const edgeReset = last !== undefined && !sameRunsKey(last.runsKey, key);
  const previousState: CheckState = last === undefined || edgeReset ? 'none' : last.state;
  const failureDue =
    wantsCi && report.state === 'failure' && spec.triggers.failure && (manual || previousState !== 'failure');
  const successDue =
    wantsCi && report.state === 'success' && spec.triggers.success && (manual || previousState !== 'success');
  const ciDue = failureDue || successDue;
  const pr = wantsPr ? await checkPr(spec, target.lastPr, deps?.client ?? new GhClient()) : undefined;
  const prMatched = pr?.matched ?? [];
  const shouldFire = ciDue || prMatched.length > 0;
  const event: GhEvent = {
    watch: spec.name,
    repo: spec.repo,
    targetKey: report.targetKey,
    state: report.state,
    failedSteps: report.failedSteps,
    failedChecks: report.failedChecks,
    runsCount: report.runs.length,
    checksCount: report.checks.length,
    checkedAt: report.checkedAt,
    fired: false,
  };
  if (prMatched.length > 0) {
    event.prEvents = prMatched;
  }
  if (shouldFire) {
    const summary = [
      ...(ciDue ? summaryLines(spec.repo, report.targetKey, report.state, report.failedSteps, report.failedChecks) : []),
      ...(pr?.snapshot !== undefined && prMatched.length > 0
        ? [
            `gh-watcher: ${spec.repo} ${report.targetKey} PR #${pr.snapshot.number} "${pr.snapshot.title}"`,
            ...prMatched.map((prEvent) => `- ${describePrEvent(prEvent)}`),
          ]
        : []),
    ].join('\n');
    const payload: Record<string, unknown> = {
      summary,
      watch: spec.name,
      repo: spec.repo,
      targetKey: report.targetKey,
    };
    if (ciDue) {
      payload['state'] = report.state;
      payload['failedSteps'] = report.failedSteps;
      payload['failedChecks'] = report.failedChecks;
      payload['runsCount'] = report.runs.length;
      payload['checksCount'] = report.checks.length;
      payload['checkedAt'] = report.checkedAt;
    }
    if (pr?.snapshot !== undefined && prMatched.length > 0) {
      payload['prEvents'] = prMatched;
      payload['pr'] = summarisePr(pr.snapshot);
    }
    const hookResult: HookResult = await fireHookFn(spec.hook, payload as unknown as HookEvent);
    event.fired = hookResult.ok;
    if (!hookResult.ok && hookResult.detail !== undefined) {
      event.error = hookResult.detail;
    }
  }
  target.lastCheckedAt = report.checkedAt;
  if (wantsCi) {
    target.lastState = report.state;
    target.lastRunsKey = key;
    state.lastFired[spec.name] = { state: report.state, runsKey: key };
  }
  if (pr !== undefined && pr.next !== undefined) {
    target.lastPr = pr.next;
  }
  if (event.fired) {
    target.lastFiredAt = report.checkedAt;
  }
  await saveState(state);
  await appendEvent(event);
  return event;
}

export async function checkWatch(spec: GhWatchSpec, deps?: EngineDeps): Promise<GhEvent> {
  return checkOne(spec, deps, false);
}

export async function checkWatchManual(spec: GhWatchSpec, deps?: EngineDeps): Promise<GhEvent> {
  return checkOne(spec, deps, true);
}

export async function runWatches(names: string[] | undefined, deps?: EngineDeps): Promise<GhEvent[]> {
  const state: GhWatcherState = await loadState();
  const targets = selectWatchers(state.watchers, names);
  const events: GhEvent[] = [];
  for (const spec of targets) {
    events.push(await checkWatch(spec, deps));
  }
  return events;
}

export async function runDaemon(
  names: string[] | undefined,
  opts?: RunDaemonOptions,
  deps?: EngineDeps,
): Promise<void> {
  const pollMs = (opts?.pollSeconds ?? 5) * 1000;
  const now = deps?.now ?? (() => new Date());
  let running = true;
  const controller = new AbortController();
  const stop = (): void => {
    running = false;
    controller.abort();
  };
  const client = deps?.client ?? new GhClient();
  client.setSignal(controller.signal);
  const daemonDeps: EngineDeps = { ...deps, client };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (opts?.signal?.aborted === true) {
    stop();
  }
  opts?.signal?.addEventListener('abort', stop, { once: true });
  try {
    while (running) {
      const state = await loadState();
      const targets = selectWatchers(state.watchers, names);
      const nowMs = now().getTime();
      for (const spec of targets) {
        if (!running) {
          break;
        }
        const last = spec.lastCheckedAt !== undefined ? Date.parse(spec.lastCheckedAt) : Number.NaN;
        const due = Number.isNaN(last) || nowMs - last >= spec.intervalSeconds * 1000;
        if (due) {
          try {
            await checkWatch(spec, daemonDeps);
          } catch (error) {
            if (!running) {
              break; // stopped while a queued wait was pending
            }
            throw error;
          }
        }
      }
      if (!running) {
        break;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, pollMs);
        function done(): void {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', done);
          resolve();
        }
        controller.signal.addEventListener('abort', done, { once: true });
      });
    }
  } finally {
    client.setSignal(undefined);
    opts?.signal?.removeEventListener('abort', stop);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
