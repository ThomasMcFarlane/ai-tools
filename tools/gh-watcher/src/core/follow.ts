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

/** Follow a target through `waitForTerminal`, emitting one line per check. Jobs of finished runs are fetched once. */
export async function followTarget(options: WaitOptions, deps: FollowDeps): Promise<FollowResult> {
  const client = deps.client ?? new GhClient({ detailedRuns: true });
  const finished = new Map<number, GhJobInfo[]>();
  let last: FollowLine | undefined;

  const build = async (
    report: CheckReport,
    source: WaitSource,
    isFinal: boolean,
  ): Promise<FollowLine> => {
    const runs: FollowRun[] = [];
    for (const run of report.runs) {
      let jobs = finished.get(run.databaseId);
      if (jobs === undefined) {
        try {
          jobs = shapeJobs(await client.runJobs(report.repo, run.databaseId));
          if (run.status === 'completed') {
            finished.set(run.databaseId, jobs);
          }
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
