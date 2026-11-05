import type { Command } from 'commander';
import { resolveEventsUrl } from '../core/events.js';
import { GhClient } from '../core/gh.js';
import { followPrEvents, waitForPrEvent, type PrTarget, type PrWaitOptions, type PrWaitResult } from '../core/pr-wait.js';
import { latestReviewPerAuthor, parseEventKinds } from '../core/pr.js';
import { RateLimitTimeoutError } from '../core/queue.js';
import type { PrSnapshot } from '../core/types.js';
import { formatDuration, parseDuration } from './duration.js';
import { printJson } from './output.js';
import { parseNumberOption, parseTargetFlags } from './target.js';

const MAX_WAIT_TIMEOUT_MS = 24 * 3_600_000;

interface PrTargetFlags {
  repo?: string;
  pr?: number;
  branch?: string;
  json?: boolean;
  timeout?: string;
}

interface PrWaitFlags extends PrTargetFlags {
  on?: string;
  interval?: string;
  since?: string;
  changesOnly?: boolean;
  source?: string;
  eventsUrl?: string;
  fallbackInterval?: string;
}

function fail(message: string): never {
  process.exitCode = 2;
  throw new Error(message);
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function resolveRepo(repo: string | undefined): string {
  const value = repo ?? process.env['GH_REPO'];
  if (value === undefined || value.trim().length === 0) {
    return fail('no repository specified (use --repo OWNER/NAME or set GH_REPO)');
  }
  if (!REPO_PATTERN.test(value) || value.split('/').some((part) => part === '.' || part === '..')) {
    return fail(`invalid repository "${value}": use OWNER/NAME`);
  }
  return value;
}

/** Run option parsing so any failure, including a bad duration, exits 2. */
function parsing<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    process.exitCode = 2;
    throw error;
  }
}

function parsePrTarget(flags: PrTargetFlags): PrTarget {
  if (flags.pr === undefined && flags.branch === undefined) {
    return fail('no target option given: use exactly one of --pr and --branch');
  }
  try {
    const target = parseTargetFlags({ pr: flags.pr, branch: flags.branch });
    if (target.kind === 'pr' || target.kind === 'branch') {
      return target;
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  return fail('use exactly one of --pr and --branch');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rateLimited(timeoutMs: number): void {
  console.error(`error: GitHub rate limit not lifted within ${formatDuration(timeoutMs)}`);
  process.exitCode = 124;
}

function printSnapshot(snapshot: PrSnapshot, repo: string): void {
  const draft = snapshot.isDraft ? ' (draft)' : '';
  const decision = snapshot.reviewDecision ?? 'none';
  console.log(
    `${repo} #${snapshot.number} is ${snapshot.state}${draft}: ${snapshot.title} [head ${snapshot.headSha.slice(0, 7)}, review decision ${decision}]`,
  );
  console.log(
    `${snapshot.comments.length} comment(s), ${snapshot.reviews.length} review(s), ${snapshot.reviewComments.length} inline comment(s)`,
  );
  for (const review of latestReviewPerAuthor(snapshot.reviews)) {
    console.log(`latest review by ${review.author}: ${review.state} at ${review.submittedAt}`);
  }
}

async function statusAction(flags: PrTargetFlags): Promise<void> {
  const { repo, target, timeoutMs } = parsing(() => ({
    repo: resolveRepo(flags.repo),
    target: parsePrTarget(flags),
    timeoutMs: Math.min(parseDuration(flags.timeout ?? '10m'), MAX_WAIT_TIMEOUT_MS),
  }));
  const client = new GhClient();
  client.setDeadline(Date.now() + timeoutMs);
  let snapshot: PrSnapshot | undefined;
  try {
    const number = target.kind === 'pr' ? target.number : await client.findPrForBranch(repo, target.branch);
    snapshot = number === undefined ? undefined : await client.prSnapshot(repo, number);
  } catch (error) {
    if (error instanceof RateLimitTimeoutError) {
      rateLimited(timeoutMs);
      return;
    }
    console.error(`error: ${describeError(error)}`);
    process.exitCode = 2;
    return;
  }
  if (snapshot === undefined) {
    if (flags.json) {
      printJson({ state: 'none' });
    } else {
      console.log(`no pull request for branch ${target.kind === 'branch' ? target.branch : ''} in ${repo}`);
    }
    return;
  }
  if (flags.json) {
    printJson(snapshot);
    return;
  }
  printSnapshot(snapshot, repo);
}

function buildWaitOptions(flags: PrWaitFlags): { options: PrWaitOptions; timeoutMs: number } {
  return parsing(() => parseWaitOptions(flags));
}

function parseWaitOptions(flags: PrWaitFlags): { options: PrWaitOptions; timeoutMs: number } {
  const repo = resolveRepo(flags.repo);
  const target = parsePrTarget(flags);
  let parsed;
  try {
    parsed = parseEventKinds(flags.on ?? 'any');
  } catch (error) {
    return fail(describeError(error));
  }
  const intervalMs = parseDuration(flags.interval ?? '60s');
  if (intervalMs <= 0) {
    return fail(`invalid interval "${String(flags.interval)}": use a positive duration`);
  }
  const timeoutMs = Math.min(parseDuration(flags.timeout ?? '30m'), MAX_WAIT_TIMEOUT_MS);
  if (flags.since !== undefined && Number.isNaN(Date.parse(flags.since))) {
    return fail(`invalid --since "${flags.since}": use an ISO 8601 timestamp`);
  }
  const source = flags.source ?? 'auto';
  if (source !== 'auto' && source !== 'events' && source !== 'poll') {
    return fail(`invalid --source "${source}": use auto, events or poll`);
  }
  const fallbackMs = parseDuration(flags.fallbackInterval ?? '5m');
  if (fallbackMs <= 0) {
    return fail(`invalid fallback interval "${String(flags.fallbackInterval)}": use a positive duration`);
  }
  return {
    timeoutMs,
    options: {
      repo,
      target,
      kinds: parsed.kinds,
      any: parsed.any,
      intervalMs,
      timeoutMs,
      since: flags.since,
      changesOnly: flags.changesOnly === true,
      source,
      eventsUrl: resolveEventsUrl(flags.eventsUrl),
      fallbackMs,
    },
  };
}

async function waitAction(flags: PrWaitFlags): Promise<void> {
  const { options, timeoutMs } = buildWaitOptions(flags);
  const onPoll = (): void => {
    if (flags.json !== true) {
      process.stderr.write('.');
    }
  };
  let result: PrWaitResult;
  try {
    result = await waitForPrEvent(options, { onPoll });
  } catch (error) {
    console.error(`error: ${describeError(error)}`);
    process.exitCode = 2;
    return;
  }
  if (result.kind === 'timeout') {
    if (flags.json) {
      printJson({ matched: false, timedOut: true, events: result.events, source: result.source });
    } else {
      process.stderr.write('\n');
      console.error(`timed out after ${formatDuration(timeoutMs)}`);
    }
    process.exitCode = 124;
    return;
  }
  if (flags.json) {
    printJson({ matched: true, events: result.events, pr: result.pr, source: result.source });
    return;
  }
  process.stderr.write('\n');
  console.log(`matched ${result.events.map((event) => event.kind).join(', ')} on #${result.pr.number} (${result.pr.state})`);
}

async function followAction(flags: PrWaitFlags): Promise<void> {
  const { options } = buildWaitOptions(flags);
  let result: PrWaitResult;
  try {
    result = await followPrEvents(options, {
      onEvent: (event, pr) => {
        process.stdout.write(`${JSON.stringify({ repo: options.repo, pr: pr.number, ...event })}\n`);
      },
    });
  } catch (error) {
    console.error(`error: ${describeError(error)}`);
    process.exitCode = 2;
    return;
  }
  if (result.kind === 'timeout') {
    process.stdout.write(`${JSON.stringify({ repo: options.repo, timedOut: true, source: result.source })}\n`);
    process.exitCode = 124;
  }
}

function addTargetOptions(command: Command): Command {
  return command
    .option('--repo <owner/name>', 'repository in OWNER/NAME form (defaults to GH_REPO)')
    .option('--pr <number>', 'pull request number', parseNumberOption)
    .option('--branch <name>', 'branch name; the newest pull request with this head branch');
}

function addWaitOptions(command: Command): Command {
  return addTargetOptions(command)
    .option('--on <kinds>', 'comma-separated event kinds, or any', 'any')
    .option('--interval <duration>', 'poll interval', '60s')
    .option('--timeout <duration>', 'overall limit, capped at 24h', '30m')
    .option('--since <time>', 'ISO time: comments and reviews after it count as new even if already present')
    .option('--changes-only', 'do not match a state the pull request is already in', false)
    .option('--source <mode>', 'auto, events or poll (auto uses the relay when configured and usable)', 'auto')
    .option('--events-url <url>', 'event relay base URL (defaults to GH_WATCHER_EVENTS_URL)')
    .option('--fallback-interval <duration>', 'event mode: safety-net gh re-check interval', '5m');
}

export function registerPrCommands(program: Command): void {
  const pr = program.command('pr').description('Watch pull request events (event relay when configured, else polling through gh)');
  addTargetOptions(pr.command('status'))
    .description('Show the current state, comments and reviews of a pull request once')
    .option('--timeout <duration>', 'longest wait for a GitHub rate limit to lift, capped at 24h', '10m')
    .option('--json', 'emit the snapshot as JSON', false)
    .action(async (opts) => {
      await statusAction(opts as PrTargetFlags);
    });
  addWaitOptions(pr.command('wait'))
    .description('Wait until a wanted pull request event happens')
    .option('--json', 'emit the outcome as JSON', false)
    .action(async (opts) => {
      await waitAction(opts as PrWaitFlags);
    });
  addWaitOptions(pr.command('follow'))
    .description('Print one JSON line per wanted event until the pull request is merged or closed')
    .action(async (opts) => {
      await followAction(opts as PrWaitFlags);
    });
}
