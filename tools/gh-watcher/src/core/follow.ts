import { GhClient } from './gh.js';
import { waitForTerminal, type WaitDeps, type WaitOptions, type WaitSource } from './wait.js';
import type { CheckReport, CheckState, ExternalCheck, FailedCheck, FailedStep, GhJobInfo, GhRunInfo } from './types.js';

export interface FollowRun extends GhRunInfo {
  jobs: GhJobInfo[];
}

export interface FollowLine {
  repo: string;
  targetKey: string;
  state: CheckState;
  runs: FollowRun[];
  checks: ExternalCheck[];
  failedSteps: FailedStep[];
  failedChecks: FailedCheck[];
  checksUnavailable?: string;
  source: WaitSource;
  checkedAt: string;
  isFinal: boolean;
  timedOut?: boolean;
}

export interface FollowDeps extends Omit<WaitDeps, 'onPending'> {
  emit: (line: FollowLine) => void;
}

export interface FollowResult {
  exitCode: 0 | 1 | 124;
}

function shapeJobs(jobs: GhJobInfo[]): GhJobInfo[] {
  return jobs.map((job) => ({
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    url: job.url,
    steps: (job.steps ?? []).map((step) => ({
      name: step.name,
      number: step.number,
      status: step.status,
      conclusion: step.conclusion,
    })),
  }));
}

/** Follow a target through `waitForTerminal`, emitting one line per check. Jobs of a run are fetched again only when its status, conclusion or updatedAt changed. */
export async function followTarget(options: WaitOptions, deps: FollowDeps): Promise<FollowResult> {
  const client = deps.client ?? new GhClient({ detailedRuns: true });
  /** Jobs per run, kept while the run's status, conclusion and updatedAt stay the same. */
  const fetched = new Map<number, { stamp: string; jobs: GhJobInfo[] }>();
  let last: FollowLine | undefined;

  const build = async (
    report: CheckReport,
    source: WaitSource,
    isFinal: boolean,
  ): Promise<FollowLine> => {
    const runs: FollowRun[] = [];
    for (const run of report.runs) {
      const stamp = `${run.status}|${run.conclusion ?? ''}|${run.updatedAt ?? ''}|${String(run.attempt ?? '')}`;
      const known = fetched.get(run.databaseId);
      let jobs: GhJobInfo[];
      if (known !== undefined && known.stamp === stamp && (run.updatedAt !== undefined || run.status === 'completed')) {
        jobs = known.jobs;
      } else {
        try {
          jobs = shapeJobs(await client.runJobs(report.repo, run.databaseId));
          fetched.set(run.databaseId, { stamp, jobs });
        } catch {
          jobs = [];
        }
      }
      runs.push({ ...run, jobs });
    }
    const line: FollowLine = {
      repo: report.repo,
      targetKey: report.targetKey,
      state: report.state,
      runs,
      checks: report.checks,
      failedSteps: report.failedSteps,
      failedChecks: report.failedChecks,
      source,
      checkedAt: report.checkedAt,
      isFinal,
    };
    if (report.checksUnavailable !== undefined) {
      line.checksUnavailable = report.checksUnavailable;
    }
    return line;
  };

  const send = (line: FollowLine): void => {
    last = line;
    deps.emit(line);
  };

  const result = await waitForTerminal(options, {
    ...deps,
    client,
    onPending: async (report, source) => {
      send(await build(report, source, false));
    },
  });
  if (result.kind === 'terminal') {
    send(await build(result.report, result.source, true));
    return { exitCode: result.report.state === 'success' ? 0 : 1 };
  }
  const base: FollowLine = last ?? {
    repo: options.repo,
    targetKey: '',
    state: 'pending',
    runs: [],
    checks: [],
    failedSteps: [],
    failedChecks: [],
    source: result.source,
    checkedAt: new Date().toISOString(),
    isFinal: false,
  };
  send({ ...base, source: result.source, isFinal: true, timedOut: true });
  return { exitCode: 124 };
}
