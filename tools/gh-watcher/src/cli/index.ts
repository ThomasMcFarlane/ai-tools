#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { collectReport } from '../core/engine.js';
import type { CheckReport, CheckState, FailedStep, GhWatchSpec, WatchTarget } from '../core/types.js';
import { formatDuration, parseDuration } from './duration.js';
import { printJson, printTable } from './output.js';
import { parseNumberOption, parseTargetFlagsOrExit, type TargetFlags } from './target.js';
import { registerWatchCommands } from './watch.js';

const MAX_WAIT_TIMEOUT_MS = 24 * 3_600_000;

interface RepoTargetFlags extends TargetFlags {
  repo?: string;
  json?: boolean;
}

interface WaitFlags extends RepoTargetFlags {
  interval?: string;
  timeout?: string;
}

interface WaitOutcome {
  state: CheckState;
  runsCount: number;
  checkedAt: string;
  failedSteps?: FailedStep[];
}

function resolveRepo(repo: string | undefined): string {
  const value = repo ?? process.env['GH_REPO'];
  if (value === undefined || value.trim().length === 0) {
    throw new Error('no repository specified (use --repo OWNER/NAME or set GH_REPO)');
  }
  return value;
}

function adhocSpec(repo: string, target: WatchTarget): GhWatchSpec {
  return {
    name: '',
    repo,
    target,
    triggers: { failure: false, success: false },
    hook: { kind: 'none' },
    intervalSeconds: 0,
    createdAt: new Date().toISOString(),
  };
}

function describeFailedSteps(failedSteps: FailedStep[]): void {
  for (const step of failedSteps) {
    console.log(`step ${step.stepNumber} '${step.stepName}' failed in job '${step.jobName}' (run ${step.runId})`);
  }
}

async function statusAction(flags: RepoTargetFlags): Promise<void> {
  const repo = resolveRepo(flags.repo);
  const target = parseTargetFlagsOrExit(flags);
  let report: CheckReport;
  try {
    report = await collectReport(adhocSpec(repo, target));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }
  if (flags.json) {
    printJson(report);
    return;
  }
  console.log(`${report.repo} ${report.targetKey} is ${report.state} (checked ${report.checkedAt})`);
  if (report.runs.length === 0) {
    console.log('no runs');
  } else {
    printTable([
      ['id', 'workflow', 'title', 'status', 'conclusion'],
      ...report.runs.map((run) => [
        String(run.databaseId),
        run.workflowName,
        run.displayTitle,
        run.status,
        run.conclusion ?? '-',
      ]),
    ]);
  }
  describeFailedSteps(report.failedSteps);
}

function emitWaitOutcome(outcome: WaitOutcome, json: boolean | undefined): void {
  if (json) {
    printJson(outcome);
    return;
  }
  process.stderr.write('\n');
  console.log(`${outcome.state}: ${outcome.runsCount} run(s) checked at ${outcome.checkedAt}`);
  describeFailedSteps(outcome.failedSteps ?? []);
}

async function waitAction(flags: WaitFlags): Promise<void> {
  const repo = resolveRepo(flags.repo);
  const target = parseTargetFlagsOrExit(flags);
  const intervalMs = parseDuration(flags.interval ?? '30s');
  const timeoutMs = Math.min(parseDuration(flags.timeout ?? '30m'), MAX_WAIT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let report: CheckReport;
    try {
      report = await collectReport(adhocSpec(repo, target));
    } catch (error) {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
      return;
    }
    if (report.state === 'success') {
      emitWaitOutcome(
        { state: report.state, runsCount: report.runs.length, checkedAt: report.checkedAt },
        flags.json,
      );
      process.exitCode = 0;
      return;
    }
    if (report.state === 'failure') {
      emitWaitOutcome(
        {
          state: report.state,
          runsCount: report.runs.length,
          checkedAt: report.checkedAt,
          failedSteps: report.failedSteps,
        },
        flags.json,
      );
      process.exitCode = 1;
      return;
    }
    if (!flags.json) {
      process.stderr.write('.');
    }
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(Math.min(intervalMs, deadline - Date.now()));
  }
  if (flags.json) {
    printJson({ state: 'pending', timedOut: true });
  } else {
    process.stderr.write('\n');
    console.error(`timed out after ${formatDuration(timeoutMs)}`);
  }
  process.exitCode = 124;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildProgram(): Command {
  const p = new Command();
  p.name('gh-watcher').description('Watch GitHub Actions runs and checks, fire hooks on step failure or full success');
  p.command('status')
    .description('Check the current state of runs for a target once')
    .option('--repo <owner/name>', 'repository in OWNER/NAME form (defaults to GH_REPO)')
    .option('--pr <number>', 'pull request number', parseNumberOption)
    .option('--branch <name>', 'branch name')
    .option('--commit <sha>', 'commit sha')
    .option('--run <id>', 'run id', parseNumberOption)
    .option('--json', 'emit the check report as JSON', false)
    .action(async (opts) => {
      await statusAction(opts as RepoTargetFlags);
    });
  p.command('wait')
    .description('Poll until runs for a target succeed or fail')
    .option('--repo <owner/name>', 'repository in OWNER/NAME form (defaults to GH_REPO)')
    .option('--pr <number>', 'pull request number', parseNumberOption)
    .option('--branch <name>', 'branch name')
    .option('--commit <sha>', 'commit sha')
    .option('--run <id>', 'run id', parseNumberOption)
    .option('--interval <duration>', 'poll interval', '30s')
    .option('--timeout <duration>', 'overall wait limit, capped at 24h', '30m')
    .option('--json', 'emit the outcome as JSON', false)
    .action(async (opts) => {
      await waitAction(opts as WaitFlags);
    });
  p.command('mcp')
    .description('Run the MCP server')
    .action(async () => {
      try {
        const specifier: string = '../mcp/server.js';
        const server = (await import(specifier)) as { startMcp: () => Promise<void> };
        await server.startMcp();
      } catch {
        console.error('MCP server not available in this build');
        process.exitCode = 1;
      }
    });
  registerWatchCommands(p);
  return p;
}

export const program = buildProgram();

export async function run(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}

export function isEntryModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  const selfPath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(entry) === realpathSync(selfPath);
  } catch {
    return selfPath === entry;
  }
}

export async function main(): Promise<void> {
  await run(process.argv).catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    if (process.exitCode === undefined) {
      process.exitCode = 1;
    }
  });
}

if (isEntryModule(import.meta.url)) {
  await main();
}
