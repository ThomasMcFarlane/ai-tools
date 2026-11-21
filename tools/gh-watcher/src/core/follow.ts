import { jobsByRun, type StatusResponse } from './relay.js';
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
  source: WaitSource;
  relaySource?: 'webhook' | 'relay-poll';
  warning?: string;
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

/** Follow a target through `waitForTerminal`, emitting one line per change (runs, jobs, steps) as the relay reports it. */
export async function followTarget(options: WaitOptions, deps: FollowDeps): Promise<FollowResult> {
  let last: FollowLine | undefined;

  const build = (report: CheckReport, snapshot: StatusResponse, isFinal: boolean): FollowLine => {
    const jobs = jobsByRun(snapshot);
    const runs: FollowRun[] = report.runs.map((run) => ({ ...run, jobs: shapeJobs(jobs.get(run.databaseId) ?? []) }));
    const line: FollowLine = {
      repo: report.repo,
      targetKey: report.targetKey,
      state: report.state,
      runs,
      checks: report.checks,
      failedSteps: report.failedSteps,
      failedChecks: report.failedChecks,
      source: 'relay',
      checkedAt: report.checkedAt,
      isFinal,
    };
    if (report.relaySource !== undefined) {
      line.relaySource = report.relaySource;
    }
    if (report.warning !== undefined) {
      line.warning = report.warning;
    }
    return line;
  };

  const send = (line: FollowLine): void => {
    last = line;
    deps.emit(line);
  };

  const result = await waitForTerminal(
    { ...options, jobs: true },
    {
      ...deps,
      onPending: (report, snapshot) => {
        send(build(report, snapshot, false));
      },
    },
  );
  if (result.kind === 'terminal') {
    send(build(result.report, result.snapshot, true));
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
    source: 'relay',
    checkedAt: new Date().toISOString(),
    isFinal: false,
  };
  send({ ...base, isFinal: true, timedOut: true });
  return { exitCode: 124 };
}
