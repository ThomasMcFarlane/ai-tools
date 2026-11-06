#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { collectReport } from '../core/engine.js';
import { resolveEventsUrl } from '../core/events.js';
import { GhClient } from '../core/gh.js';
import { RateLimitTimeoutError } from '../core/queue.js';
import { followTarget } from '../core/follow.js';
import { waitForTerminal, type WaitResult, type WaitSource } from '../core/wait.js';
import type { CheckReport, CheckState, FailedCheck, FailedStep, GhWatchSpec, WatchTarget } from '../core/types.js';
import { formatDuration, parseDuration } from './duration.js';
import { printJson, printTable } from './output.js';
import { parseNumberOption, parseTargetFlagsOrExit, type TargetFlags } from './target.js';
import { registerPrCommands } from './pr.js';
import { registerWatchCommands } from './watch.js';

const MAX_WAIT_TIMEOUT_MS = 24 * 3_600_000;

interface RepoTargetFlags extends TargetFlags {
  repo?: string;
  json?: boolean;
  timeout?: string;
}

interface WaitFlags extends RepoTargetFlags {
  interval?: string;
  timeout?: string;
  fallbackInterval?: string;
  source?: string;
  eventsUrl?: string;
}

interface WaitOutcome {
  state: CheckState;
  runsCount: number;
  checksCount: number;
  failedChecks?: FailedCheck[];
  checksUnavailable?: string;
  checkedAt: string;
  failedSteps?: FailedStep[];
  source?: WaitSource;
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

function describeFailedChecks(failedChecks: FailedCheck[]): void {
  for (const check of failedChecks) {
    console.log(`check '${check.name}' failed${check.url.length > 0 ? ` (${check.url})` : ''}`);
  }
}

async function statusAction(flags: RepoTargetFlags): Promise<void> {
  const repo = resolveRepo(flags.repo);
  const target = parseTargetFlagsOrExit(flags);
  const timeoutMs = Math.min(parseDuration(flags.timeout ?? '10m'), MAX_WAIT_TIMEOUT_MS);
  const client = new GhClient();
  client.setDeadline(Date.now() + timeoutMs);
  let report: CheckReport;
  try {
    report = await collectReport(adhocSpec(repo, target), { client });
  } catch (error) {
    if (error instanceof RateLimitTimeoutError) {
      console.error(`error: GitHub rate limit not lifted within ${formatDuration(timeoutMs)}`);
      process.exitCode = 124;
      return;
    }
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
    console.log(report.checks.length === 0 ? 'no runs or checks' : 'no runs');
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
  if (report.checks.length > 0) {
    printTable([
      ['check', 'kind', 'source', 'status', 'result', 'url'],
      ...report.checks.map((check) => [
        check.name,
        check.kind,
        check.source === '' ? '-' : check.source,
        check.status,
        check.conclusion ?? '-',
        check.url === '' ? '-' : check.url,
      ]),
    ]);
  }
  describeFailedSteps(report.failedSteps);
  describeFailedChecks(report.failedChecks);
}

function emitWaitOutcome(outcome: WaitOutcome, json: boolean | undefined): void {
  if (json) {
    printJson(outcome);
    return;
  }
  process.stderr.write('\n');
  console.log(
    `${outcome.state}: ${outcome.runsCount} run(s) and ${outcome.checksCount} other check(s) checked at ${outcome.checkedAt}`,
  );
  describeFailedSteps(outcome.failedSteps ?? []);
  describeFailedChecks(outcome.failedChecks ?? []);
}

async function waitAction(flags: WaitFlags): Promise<void> {
  const repo = resolveRepo(flags.repo);
  const target = parseTargetFlagsOrExit(flags);
  const intervalMs = parseDuration(flags.interval ?? '30s');
  const timeoutMs = Math.min(parseDuration(flags.timeout ?? '30m'), MAX_WAIT_TIMEOUT_MS);
  const fallbackMs = parseDuration(flags.fallbackInterval ?? '5m');
  const source = flags.source ?? 'auto';
  if (source !== 'auto' && source !== 'events' && source !== 'poll') {
    process.exitCode = 2;
    throw new Error(`invalid --source "${source}": use auto, events or poll`);
  }
  let result: WaitResult;
  let seen = new Map<string, string>();
  try {
    result = await waitForTerminal(
      { repo, target, intervalMs, timeoutMs, fallbackMs, source, eventsUrl: resolveEventsUrl(flags.eventsUrl) },
      {
        onPending: (report) => {
          if (flags.json) {
            return;
          }
          // Report every status change of a non-Actions check; otherwise just show liveness.
          const next = new Map(report.checks.map((check) => [`${check.kind}:${check.source}:${check.name}`, check.status]));
          let changed = false;
          for (const check of report.checks) {
            const key = `${check.kind}:${check.source}:${check.name}`;
            if (seen.get(key) !== check.status) {
              process.stderr.write(`\ncheck '${check.name}' is ${check.status}\n`);
              changed = true;
            }
          }
          seen = next;
          if (!changed) {
            process.stderr.write('.');
          }
        },
      },
    );
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }
  if (result.kind === 'timeout') {
    if (flags.json) {
      printJson({ state: 'pending', timedOut: true, source: result.source });
    } else {
      process.stderr.write('\n');
      console.error(`timed out after ${formatDuration(timeoutMs)}`);
    }
    process.exitCode = 124;
    return;
  }
  const { report } = result;
  const outcome: WaitOutcome = {
    state: report.state,
    runsCount: report.runs.length,
    checksCount: report.checks.length,
    checkedAt: report.checkedAt,
    source: result.source,
  };
  if (report.checksUnavailable !== undefined) {
    outcome.checksUnavailable = report.checksUnavailable;
  }
  if (report.state === 'failure') {
    outcome.failedSteps = report.failedSteps;
    outcome.failedChecks = report.failedChecks;
  }
  emitWaitOutcome(outcome, flags.json);
  process.exitCode = report.state === 'success' ? 0 : 1;
}

async function followAction(flags: WaitFlags): Promise<void> {
  const repo = resolveRepo(flags.repo);
  const target = parseTargetFlagsOrExit(flags);
  const intervalMs = parseDuration(flags.interval ?? '30s');
  const timeoutMs = Math.min(parseDuration(flags.timeout ?? '30m'), MAX_WAIT_TIMEOUT_MS);
  const fallbackMs = parseDuration(flags.fallbackInterval ?? '5m');
  const source = flags.source ?? 'auto';
  if (source !== 'auto' && source !== 'events' && source !== 'poll') {
    process.exitCode = 2;
    throw new Error(`invalid --source "${source}": use auto, events or poll`);
  }
  try {
    const { exitCode } = await followTarget(
      { repo, target, intervalMs, timeoutMs, fallbackMs, source, eventsUrl: resolveEventsUrl(flags.eventsUrl) },
      { emit: (line) => process.stdout.write(`${JSON.stringify(line)}\n`) },
    );
    process.exitCode = exitCode;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

function buildProgram(): Command {
  const p = new Command();
  p.name('gh-watcher').description('Watch every check on a commit (Actions runs, check runs, commit statuses), fire hooks on step failure or full success');
  p.command('status')
    .description('Check the current state of runs for a target once')
    .option('--repo <owner/name>', 'repository in OWNER/NAME form (defaults to GH_REPO)')
    .option('--pr <number>', 'pull request number', parseNumberOption)
    .option('--branch <name>', 'branch name')
    .option('--commit <sha>', 'commit sha')
    .option('--run <id>', 'run id', parseNumberOption)
    .option('--timeout <duration>', 'longest wait for a GitHub rate limit to lift, capped at 24h', '10m')
    .option('--json', 'emit the check report as JSON', false)
    .action(async (opts) => {
      await statusAction(opts as RepoTargetFlags);
    });
  p.command('wait')
    .description('Wait until runs for a target succeed or fail (event mode when a relay is configured, else polling)')
    .option('--repo <owner/name>', 'repository in OWNER/NAME form (defaults to GH_REPO)')
    .option('--pr <number>', 'pull request number', parseNumberOption)
    .option('--branch <name>', 'branch name')
    .option('--commit <sha>', 'commit sha')
    .option('--run <id>', 'run id', parseNumberOption)
    .option('--interval <duration>', 'poll interval', '30s')
    .option('--timeout <duration>', 'overall wait limit, capped at 24h', '30m')
    .option('--source <mode>', 'auto, events or poll (auto uses events when a relay is configured and usable)', 'auto')
    .option('--events-url <url>', 'event relay base URL (defaults to GH_WATCHER_EVENTS_URL)')
    .option('--fallback-interval <duration>', 'event mode: safety-net gh re-check interval', '5m')
    .option('--json', 'emit the outcome as JSON', false)
    .action(async (opts) => {
      await waitAction(opts as WaitFlags);
    });
  p.command('follow')
    .description('Like wait, but print one JSON line per check (runs, jobs, steps) until the runs finish')
    .option('--repo <owner/name>', 'repository in OWNER/NAME form (defaults to GH_REPO)')
    .option('--pr <number>', 'pull request number', parseNumberOption)
    .option('--branch <name>', 'branch name')
    .option('--commit <sha>', 'commit sha')
    .option('--run <id>', 'run id', parseNumberOption)
    .option('--interval <duration>', 'poll interval', '30s')
    .option('--timeout <duration>', 'overall follow limit, capped at 24h', '30m')
    .option('--source <mode>', 'auto, events or poll (auto uses events when a relay is configured and usable)', 'auto')
    .option('--events-url <url>', 'event relay base URL (defaults to GH_WATCHER_EVENTS_URL)')
    .option('--fallback-interval <duration>', 'event mode: safety-net gh re-check interval', '5m')
    .action(async (opts) => {
      await followAction(opts as WaitFlags);
    });
  registerPrCommands(p);
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
  main();
}
