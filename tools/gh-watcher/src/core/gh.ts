import { spawn } from 'node:child_process';
import type { CheckState, FailedStep, GhJobInfo, GhRunInfo, GhStepInfo, WatchTarget } from './types.js';

const RUN_FIELDS = 'databaseId,workflowName,displayTitle,status,conclusion,url,headSha,createdAt';

export const FAILURE_CONCLUSIONS: readonly string[] = [
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
  'action_required',
];

export const SUCCESS_CONCLUSIONS: readonly string[] = ['success', 'neutral', 'skipped'];

export interface GhExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type GhExec = (args: string[]) => Promise<GhExecResult>;

export interface GhClientOptions {
  ghBin?: string;
  exec?: GhExec;
}

function defaultExec(ghBin: string): GhExec {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(ghBin, args, { shell: false });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        reject(error);
      });
      child.on('close', (code) => {
        resolve({ stdout, stderr, code: code ?? -1 });
      });
    });
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function assertOk(result: GhExecResult, context: string): void {
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new Error(detail.length > 0 ? `gh ${context} failed: ${detail}` : `gh ${context} failed with exit code ${result.code}`);
  }
}

function normaliseRun(raw: unknown): GhRunInfo {
  const record = (raw ?? {}) as Partial<GhRunInfo>;
  const run: GhRunInfo = {
    databaseId: Number(record.databaseId),
    workflowName: record.workflowName ?? '',
    displayTitle: record.displayTitle ?? '',
    status: record.status ?? '',
    conclusion: record.conclusion ?? null,
    url: record.url ?? '',
    headSha: record.headSha ?? '',
  };
  if (record.createdAt !== undefined) {
    run.createdAt = record.createdAt;
  }
  return run;
}

function normaliseStep(raw: unknown): GhStepInfo {
  const record = (raw ?? {}) as Partial<GhStepInfo>;
  return {
    name: record.name ?? '',
    number: Number(record.number),
    conclusion: record.conclusion ?? null,
  };
}

function normaliseJob(raw: unknown): GhJobInfo {
  const record = (raw ?? {}) as Partial<GhJobInfo>;
  const job: GhJobInfo = {
    name: record.name ?? '',
    status: record.status ?? '',
    conclusion: record.conclusion ?? null,
    steps: (record.steps ?? []).map((step) => normaliseStep(step)),
  };
  if (record.url !== undefined) {
    job.url = record.url;
  }
  return job;
}

function isFailureish(conclusion: string | null): boolean {
  return conclusion !== null && FAILURE_CONCLUSIONS.includes(conclusion);
}

export class GhClient {
  private readonly exec: GhExec;

  constructor(options?: GhClientOptions) {
    this.exec = options?.exec ?? defaultExec(options?.ghBin ?? 'gh');
  }

  async listRuns(repo: string, target: WatchTarget): Promise<GhRunInfo[]> {
    if (target.kind === 'run') {
      const result = await this.exec(['run', 'view', String(target.runId), '--repo', repo, '--json', RUN_FIELDS]);
      assertOk(result, `run view ${target.runId}`);
      return [normaliseRun(parseJson(result.stdout))];
    }
    if (target.kind === 'pr') {
      const prResult = await this.exec(['pr', 'view', String(target.number), '--repo', repo, '--json', 'headRefName']);
      assertOk(prResult, `pr view ${target.number}`);
      const parsed = parseJson<{ headRefName?: string }>(prResult.stdout);
      return this.listRunsBy(repo, '--branch', parsed.headRefName ?? '');
    }
    if (target.kind === 'branch') {
      return this.listRunsBy(repo, '--branch', target.branch);
    }
    return this.listRunsBy(repo, '--commit', target.sha);
  }

  private async listRunsBy(repo: string, flag: string, value: string): Promise<GhRunInfo[]> {
    const result = await this.exec(['run', 'list', '--repo', repo, flag, value, '--limit', '25', '--json', RUN_FIELDS]);
    assertOk(result, `run list ${value}`);
    const runs = parseJson<unknown[]>(result.stdout);
    return runs.map((run) => normaliseRun(run));
  }

  async runJobs(repo: string, runId: number): Promise<GhJobInfo[]> {
    const result = await this.exec(['run', 'view', String(runId), '--repo', repo, '--json', 'jobs']);
    assertOk(result, `run view ${runId}`);
    const parsed = parseJson<{ jobs?: unknown[] }>(result.stdout);
    return (parsed.jobs ?? []).map((job) => normaliseJob(job));
  }

  async collectFailures(repo: string, runs: GhRunInfo[]): Promise<FailedStep[]> {
    const failures: FailedStep[] = [];
    for (const run of runs) {
      if (!isFailureish(run.conclusion)) {
        continue;
      }
      const jobs = await this.runJobs(repo, run.databaseId);
      for (const job of jobs) {
        if (!isFailureish(job.conclusion)) {
          continue;
        }
        const steps = (job.steps ?? []).filter((step) => step.conclusion === 'failure');
        if (steps.length === 0) {
          failures.push({
            runId: run.databaseId,
            workflowName: run.workflowName,
            jobName: job.name,
            stepName: '',
            stepNumber: 0,
          });
          continue;
        }
        for (const step of steps) {
          failures.push({
            runId: run.databaseId,
            workflowName: run.workflowName,
            jobName: job.name,
            stepName: step.name,
            stepNumber: step.number,
          });
        }
      }
    }
    return failures;
  }
}

export function aggregateState(runs: GhRunInfo[]): CheckState {
  if (runs.length === 0) {
    return 'none';
  }
  if (runs.some((run) => run.status !== 'completed')) {
    return 'pending';
  }
  if (runs.some((run) => isFailureish(run.conclusion))) {
    return 'failure';
  }
  return 'success';
}

export function runsKey(runs: GhRunInfo[]): string {
  return runs
    .map((run) => run.databaseId)
    .sort((left, right) => left - right)
    .join(',');
}
