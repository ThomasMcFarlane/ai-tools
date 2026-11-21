import type { CheckState, ExternalCheck, FailedCheck, GhRunInfo } from './types.js';

export const FAILURE_CONCLUSIONS: readonly string[] = [
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
  'action_required',
];

export const SUCCESS_CONCLUSIONS: readonly string[] = ['success', 'neutral', 'skipped'];

export function isFailureish(conclusion: string | null): boolean {
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

/** True when a saved change key is the same edge: equal, or an old-format (run ids only) key matching the ids of the new one. */
export function sameRunsKey(saved: string, key: string): boolean {
  if (saved === key) {
    return true;
  }
  return !saved.includes('|') && key.includes('|') && key.slice(0, key.indexOf('|')) === saved;
}

function isGreenRun(run: GhRunInfo): boolean {
  return run.status === 'completed' && run.conclusion !== null && SUCCESS_CONCLUSIONS.includes(run.conclusion);
}

/** A run that is not finished, or finished without a conclusion yet: keep waiting. */
function isOpenRun(run: GhRunInfo): boolean {
  return run.status !== 'completed' || run.conclusion === null;
}

/**
 * `success` only when there is at least one item and every run, check run and status is finished
 * and green. Any open item is `pending`. Any finished item that is not green (including an
 * unrecognised conclusion) is `failure`, reported once nothing is open. No items is `none`.
 */
export function aggregateState(runs: GhRunInfo[], checks: ExternalCheck[] = []): CheckState {
  if (runs.length === 0 && checks.length === 0) {
    return 'none';
  }
  if (runs.some(isOpenRun) || checks.some((check) => check.status === 'pending')) {
    return 'pending';
  }
  if (runs.every(isGreenRun) && checks.every((check) => check.status === 'success')) {
    return 'success';
  }
  return 'failure';
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
