import { fireHook, type HookResult } from '@ai-tools/hooks';
import { aggregateState, GhClient, runsKey } from './gh.js';
import { appendEvent, loadState, saveState } from './store.js';
import { targetKey } from './types.js';
import type { CheckReport, CheckState, FailedStep, GhEvent, GhWatchSpec, GhWatcherState } from './types.js';

export interface EngineDeps {
  client?: GhClient;
  fireHookFn?: typeof fireHook;
  now?: () => Date;
}

export interface RunDaemonOptions {
  pollSeconds?: number;
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
}

function summaryLines(repo: string, key: string, state: CheckState, failedSteps: FailedStep[]): string[] {
  const lines = [`gh-watcher: ${repo} ${key} is ${state}`];
  if (state === 'failure') {
    for (const step of failedSteps.slice(0, 3)) {
      lines.push(`step ${step.stepNumber} '${step.stepName}' failed in job '${step.jobName}' (run ${step.runId})`);
    }
  }
  return lines;
}

export function describeEvent(event: GhEvent): string {
  const lines = summaryLines(event.repo, event.targetKey, event.state, event.failedSteps);
  if (event.error !== undefined) {
    lines.push(`error: ${event.error}`);
  }
  return lines.join('\n');
}

export async function collectReport(spec: GhWatchSpec, deps?: EngineDeps): Promise<CheckReport> {
  const client = deps?.client ?? new GhClient();
  const now = deps?.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const runs = await client.listRuns(spec.repo, spec.target);
  const state = aggregateState(runs);
  const failedSteps = state === 'failure' ? await client.collectFailures(spec.repo, runs) : [];
  return {
    repo: spec.repo,
    target: spec.target,
    targetKey: targetKey(spec.target),
    state,
    runs,
    failedSteps,
    checkedAt,
  };
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
  const report = await collectReport(spec, deps);
  const key = runsKey(report.runs);
  const last = state.lastFired[spec.name];
  const edgeReset = last !== undefined && last.runsKey !== key;
  const previousState: CheckState = last === undefined || edgeReset ? 'none' : last.state;
  const failureDue =
    report.state === 'failure' && spec.triggers.failure && (manual || previousState !== 'failure');
  const successDue =
    report.state === 'success' && spec.triggers.success && (manual || previousState !== 'success');
  const shouldFire = failureDue || successDue;
  const event: GhEvent = {
    watch: spec.name,
    repo: spec.repo,
    targetKey: report.targetKey,
    state: report.state,
    failedSteps: report.failedSteps,
    runsCount: report.runs.length,
    checkedAt: report.checkedAt,
    fired: false,
  };
  if (shouldFire) {
    const payload = {
      summary: summaryLines(spec.repo, report.targetKey, report.state, report.failedSteps).join('\n'),
      watch: spec.name,
      repo: spec.repo,
      targetKey: report.targetKey,
      state: report.state,
      failedSteps: report.failedSteps,
      runsCount: report.runs.length,
      checkedAt: report.checkedAt,
    };
    const hookResult: HookResult = await fireHookFn(spec.hook, payload);
    event.fired = hookResult.ok;
    if (!hookResult.ok && hookResult.detail !== undefined) {
      event.error = hookResult.detail;
    }
  }
  target.lastCheckedAt = report.checkedAt;
  target.lastState = report.state;
  target.lastRunsKey = key;
  if (event.fired) {
    target.lastFiredAt = report.checkedAt;
  }
  state.lastFired[spec.name] = { state: report.state, runsKey: key };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runDaemon(
  names: string[] | undefined,
  opts?: RunDaemonOptions,
  deps?: EngineDeps,
): Promise<void> {
  const pollMs = (opts?.pollSeconds ?? 5) * 1000;
  const now = deps?.now ?? (() => new Date());
  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
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
          await checkWatch(spec, deps);
        }
      }
      if (!running) {
        break;
      }
      await delay(pollMs);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
