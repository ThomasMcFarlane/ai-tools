import type { RunEvent } from './events.js';
import type { GhRunInfo, WatchTarget } from './types.js';

export interface ApplyResult {
  runs: GhRunInfo[];
  /** At least one run was inserted or changed. */
  changed: boolean;
  /** An event could not be mapped to a run, so the caller must ask gh. */
  unmappable: boolean;
}

function isMappable(event: RunEvent): event is RunEvent & { run_id: number; workflow_name: string; status: string } {
  return (
    typeof event.run_id === 'number' &&
    typeof event.workflow_name === 'string' &&
    event.workflow_name.length > 0 &&
    typeof event.status === 'string'
  );
}

/**
 * Apply relay `workflow_run` events for the watched commit to the known runs. Grouping follows the
 * gh path: one run per workflow name, a newer run (higher run id) supersedes an older one, and a
 * re-run attempt updates its run in place while stale attempts are ignored.
 */
export function applyRunEvents(runs: GhRunInfo[], events: RunEvent[], target: WatchTarget): ApplyResult {
  let next = [...runs];
  let changed = false;
  let unmappable = false;
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (typeof event.run_id === 'number' && target.kind === 'run' && event.run_id !== target.runId) {
      continue;
    }
    if (!isMappable(event)) {
      unmappable = true;
      continue;
    }
    const existing = next.find((run) => run.databaseId === event.run_id);
    if (existing !== undefined) {
      if (event.run_attempt !== undefined && existing.attempt !== undefined && event.run_attempt < existing.attempt) {
        continue;
      }
      if (event.updated_at !== undefined && existing.updatedAt !== undefined && event.updated_at < existing.updatedAt) {
        continue;
      }
      const updated: GhRunInfo = {
        ...existing,
        status: event.status,
        conclusion: event.conclusion ?? null,
        url: event.html_url ?? existing.url,
      };
      if (event.run_attempt !== undefined) {
        updated.attempt = event.run_attempt;
      }
      if (event.updated_at !== undefined) {
        updated.updatedAt = event.updated_at;
      }
      if (
        updated.status !== existing.status ||
        updated.conclusion !== existing.conclusion ||
        updated.url !== existing.url ||
        updated.attempt !== existing.attempt ||
        updated.updatedAt !== existing.updatedAt
      ) {
        next = next.map((run) => (run === existing ? updated : run));
        changed = true;
      }
      continue;
    }
    const sameWorkflow = next.find((run) => run.workflowName === event.workflow_name);
    if (sameWorkflow !== undefined && sameWorkflow.databaseId > event.run_id) {
      continue; // an older run of a workflow that already has a newer one
    }
    const created: GhRunInfo = {
      databaseId: event.run_id,
      workflowName: event.workflow_name,
      displayTitle: '',
      status: event.status,
      conclusion: event.conclusion ?? null,
      url: event.html_url ?? '',
      headSha: event.head_sha,
    };
    if (event.run_attempt !== undefined) {
      created.attempt = event.run_attempt;
    }
    if (event.updated_at !== undefined) {
      created.updatedAt = event.updated_at;
    }
    next = [...next.filter((run) => run !== sameWorkflow), created];
    changed = true;
  }
  return { runs: next, changed, unmappable };
}
