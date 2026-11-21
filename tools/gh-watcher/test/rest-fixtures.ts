/** Fixtures that turn the old `gh` JSON shapes into the REST bodies the client now reads. */

type Rec = Record<string, unknown>;

export function restRun(run: Rec): Rec {
  return {
    id: run['databaseId'],
    name: run['workflowName'],
    display_title: run['displayTitle'],
    status: run['status'],
    conclusion: run['conclusion'] ?? null,
    html_url: run['url'],
    head_sha: run['headSha'],
    created_at: run['createdAt'],
    run_started_at: run['startedAt'],
    updated_at: run['updatedAt'],
    run_attempt: run['attempt'],
  };
}

export function restRunsBody(runs: Rec[]): string {
  return JSON.stringify({ total_count: runs.length, workflow_runs: runs.map(restRun) });
}

export function restRunBody(run: Rec): string {
  return JSON.stringify(restRun(run));
}

export function restJobsBody(jobs: unknown[]): string {
  const mapped = jobs.map((job) => {
    const item = job as Rec;
    return { name: item['name'], status: item['status'], conclusion: item['conclusion'], html_url: item['url'], steps: item['steps'] };
  });
  return JSON.stringify({ total_count: mapped.length, jobs: mapped });
}

export function restCheckRunsBody(items: Rec[] | undefined): string {
  const list = (items ?? []).map((item) => ({
    id: item['id'],
    name: item['name'],
    status: item['status'],
    conclusion: item['conclusion'],
    html_url: item['url'],
    started_at: item['startedAt'],
    completed_at: item['completedAt'],
    app: { slug: item['app'] },
  }));
  return JSON.stringify({ total_count: list.length, check_runs: list });
}

export function restStatusBody(items: Rec[] | undefined): string {
  const list = (items ?? []).map((item) => ({
    id: item['id'],
    context: item['context'],
    state: item['state'],
    target_url: item['url'],
    updated_at: item['updatedAt'],
  }));
  return JSON.stringify({ total_count: list.length, statuses: list });
}

export const RUNS_LIST = /\/actions\/runs\?/;
export const RUN_ONE = /\/actions\/runs\/\d+$/;
export const RUN_JOBS = /\/actions\/runs\/\d+\/jobs/;
export const CHECK_RUNS = /\/commits\/[0-9a-f]{40}\/check-runs/;
export const COMMIT_STATUS = /\/commits\/[0-9a-f]{40}\/status/;
