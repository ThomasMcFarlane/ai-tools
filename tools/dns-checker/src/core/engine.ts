import { fireHook, type HookResult } from './hooks.js';
import { evaluateRule } from './matcher.js';
import { answerValues, lookup } from './resolver.js';
import { appendEvent, loadState, saveState } from './store.js';
import type { WatchEvent, WatchSpec, WatcherState } from './types.js';

export interface EngineDeps {
  lookupFn?: typeof lookup;
  fireHookFn?: typeof fireHook;
  now?: () => Date;
}

export interface RunDaemonOptions {
  pollSeconds?: number;
}

function selectWatchers(watchers: WatchSpec[], names: string[] | undefined): WatchSpec[] {
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

function syncSpec(target: WatchSpec, spec: WatchSpec): void {
  target.domain = spec.domain;
  target.type = spec.type;
  target.rule = spec.rule;
  target.resolver = spec.resolver;
  target.transport = spec.transport;
  target.intervalSeconds = spec.intervalSeconds;
  target.hook = spec.hook;
  target.createdAt = spec.createdAt;
}

async function checkOne(spec: WatchSpec, deps: EngineDeps | undefined, manual: boolean): Promise<WatchEvent> {
  const lookupFn = deps?.lookupFn ?? lookup;
  const fireHookFn = deps?.fireHookFn ?? fireHook;
  const now = deps?.now ?? (() => new Date());
  const state = await loadState();
  let target = state.watchers.find((watcher) => watcher.name === spec.name);
  if (target === undefined) {
    target = { ...spec };
    state.watchers.push(target);
  } else {
    syncSpec(target, spec);
  }
  const checkedAt = now().toISOString();
  const result = await lookupFn(target.domain, target.type, {
    resolver: target.resolver,
    transport: target.transport,
  });
  const values = answerValues(result);
  const baseline = state.baselines[target.name] ?? null;
  const outcome = evaluateRule(target.rule, values, baseline);
  const previousMatched = state.matched[target.name] === true;
  const shouldFire = outcome.matched && (manual || !previousMatched);
  const event: WatchEvent = {
    watch: target.name,
    domain: target.domain,
    type: target.type,
    matched: outcome.matched,
    reason: outcome.reason,
    values,
    checkedAt,
    fired: false,
  };
  if (result.error !== undefined) {
    event.error = result.error;
  }
  if (shouldFire) {
    const hookResult: HookResult = await fireHookFn(target.hook, event);
    event.fired = hookResult.ok;
  }
  target.lastCheckedAt = checkedAt;
  if (outcome.matched) {
    target.lastMatchAt = checkedAt;
  }
  if (target.rule.kind === 'any-change') {
    state.baselines[target.name] = [...values].sort();
  }
  state.matched[target.name] = outcome.matched;
  await saveState(state);
  await appendEvent(event);
  return event;
}

export async function checkWatch(spec: WatchSpec, deps?: EngineDeps): Promise<WatchEvent> {
  return checkOne(spec, deps, false);
}

export async function checkWatchManual(spec: WatchSpec, deps?: EngineDeps): Promise<WatchEvent> {
  return checkOne(spec, deps, true);
}

export async function runWatches(names: string[] | undefined, deps?: EngineDeps): Promise<WatchEvent[]> {
  const state: WatcherState = await loadState();
  const targets = selectWatchers(state.watchers, names);
  const events: WatchEvent[] = [];
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
