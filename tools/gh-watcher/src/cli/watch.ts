import type { Command } from 'commander';
import { checkWatchManual, describeEvent, runDaemon } from '../core/engine.js';
import { getWatcher, loadState, readEvents, removeWatcher, upsertWatcher } from '../core/store.js';
import { PR_EVENT_KINDS } from '../core/types.js';
import { isPrEventKind } from '../core/pr.js';
import {
  targetKey,
  type GhEvent,
  type GhWatchSpec,
  type GhWatcherState,
  type HookConfig,
  type PrEventKind,
  type WatchTarget,
} from '../core/types.js';
import { formatDuration, parseDuration } from './duration.js';
import { printJson, printTable } from './output.js';
import { parseNumberOption, parseTargetFlagsOrExit } from './target.js';

const HOOK_USAGE =
  'use none, exec:<command>, webhook:<url>, file:<path>, notify:claude, notify:codex or notify:opencode';

interface AddFlags {
  repo: string;
  pr?: number;
  branch?: string;
  commit?: string;
  run?: number;
  on?: string;
  interval?: string;
  hook?: string;
  json?: boolean;
}

interface ListFlags {
  json?: boolean;
}

interface CheckFlags {
  json?: boolean;
}

interface EventsFlags {
  tail?: string;
  json?: boolean;
}

export function parseHookSpec(spec: string): HookConfig {
  if (spec === 'none') {
    return { kind: 'none' };
  }
  const colon = spec.indexOf(':');
  const scheme = colon < 0 ? undefined : spec.slice(0, colon);
  const rest = colon < 0 ? undefined : spec.slice(colon + 1);
  switch (scheme) {
    case 'exec':
      if (rest === undefined || rest.length === 0) {
        throw new Error(`invalid hook spec "${spec}": exec needs a command: ${HOOK_USAGE}`);
      }
      return { kind: 'exec', command: rest };
    case 'webhook':
      if (rest === undefined || rest.length === 0) {
        throw new Error(`invalid hook spec "${spec}": webhook needs a url: ${HOOK_USAGE}`);
      }
      return { kind: 'webhook', url: rest };
    case 'file':
      if (rest === undefined || rest.length === 0) {
        throw new Error(`invalid hook spec "${spec}": file needs a path: ${HOOK_USAGE}`);
      }
      return { kind: 'file', path: rest };
    case 'notify':
      if (rest === 'claude' || rest === 'codex' || rest === 'opencode') {
        return { kind: 'notify', tool: rest };
      }
      throw new Error(`invalid hook spec "${spec}": notify needs claude, codex or opencode: ${HOOK_USAGE}`);
    default:
      throw new Error(`invalid hook spec "${spec}": ${HOOK_USAGE}`);
  }
}

function describeHook(hook: HookConfig): string {
  switch (hook.kind) {
    case 'none':
      return 'none';
    case 'exec':
      return `exec:${hook.command}`;
    case 'webhook':
      return `webhook:${hook.url}`;
    case 'file':
      return `file:${hook.path}`;
    case 'notify':
      return `notify:${hook.tool}`;
  }
}

export interface ParsedOn {
  triggers: { failure: boolean; success: boolean };
  prEvents?: PrEventKind[];
}

/** Parse a comma-separated `--on` list mixing CI triggers and pull request event kinds. */
export function parseOn(on: string, target: WatchTarget): ParsedOn {
  const usage = `use failure, success, complete, any or pull request kinds (${PR_EVENT_KINDS.join(', ')}), comma-separated`;
  const tokens = on
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    throw new Error(`invalid value "${on}" for --on: ${usage}`);
  }
  const triggers = { failure: false, success: false };
  const prEvents: PrEventKind[] = [];
  for (const token of tokens) {
    if (token === 'failure') {
      triggers.failure = true;
    } else if (token === 'success') {
      triggers.success = true;
    } else if (token === 'complete') {
      triggers.failure = true;
      triggers.success = true;
    } else if (token === 'any') {
      prEvents.push(...PR_EVENT_KINDS.filter((kind) => !prEvents.includes(kind)));
    } else if (isPrEventKind(token)) {
      if (!prEvents.includes(token)) {
        prEvents.push(token);
      }
    } else {
      throw new Error(`invalid value "${token}" for --on: ${usage}`);
    }
  }
  if (prEvents.length === 0) {
    return { triggers };
  }
  if (target.kind !== 'pr' && target.kind !== 'branch') {
    throw new Error('pull request events in --on need a --pr or --branch target');
  }
  return { triggers, prEvents };
}

function describeTriggers(spec: GhWatchSpec): string {
  const parts: string[] = [];
  if (spec.triggers.failure) {
    parts.push('failure');
  }
  if (spec.triggers.success) {
    parts.push('success');
  }
  const kinds = spec.prEvents ?? [];
  if (kinds.length > 0) {
    parts.push(`pr:${kinds.length === PR_EVENT_KINDS.length ? 'any' : kinds.join(',')}`);
  }
  return parts.length > 0 ? parts.join('+') : 'none';
}

function requireKnownNames(state: GhWatcherState, names: string[]): void {
  for (const name of names) {
    if (!state.watchers.some((entry) => entry.name === name)) {
      process.exitCode = 2;
      throw new Error(`unknown watch "${name}"`);
    }
  }
}

function selectedNames(state: GhWatcherState, names: string[]): string[] {
  if (names.length === 0) {
    return state.watchers.map((entry) => entry.name);
  }
  const wanted = new Set(names);
  return state.watchers.map((entry) => entry.name).filter((name) => wanted.has(name));
}

async function addAction(name: string, flags: AddFlags): Promise<void> {
  const target = parseTargetFlagsOrExit(flags);
  let parsedOn: ParsedOn;
  try {
    parsedOn = parseOn(flags.on ?? 'complete', target);
  } catch (error) {
    process.exitCode = 2;
    throw error;
  }
  const hook = parseHookSpec(flags.hook ?? 'none');
  const intervalMs = parseDuration(flags.interval ?? '60s');
  if (intervalMs <= 0) {
    throw new Error(`invalid interval "${String(flags.interval)}": use a positive duration`);
  }
  const state = await loadState();
  if (state.watchers.some((entry) => entry.name === name)) {
    process.exitCode = 1;
    throw new Error(`watch "${name}" already exists: remove it first or pick another name`);
  }
  const spec: GhWatchSpec = {
    name,
    repo: flags.repo,
    target,
    triggers: parsedOn.triggers,
    hook,
    intervalSeconds: intervalMs / 1000,
    createdAt: new Date().toISOString(),
  };
  if (parsedOn.prEvents !== undefined) {
    spec.prEvents = parsedOn.prEvents;
  }
  await upsertWatcher(spec);
  if (flags.json) {
    printJson(spec);
    return;
  }
  printTable([
    ['field', 'value'],
    ['name', spec.name],
    ['repo', spec.repo],
    ['target', targetKey(spec.target)],
    ['triggers', describeTriggers(spec)],
    ['interval', formatDuration(spec.intervalSeconds * 1000)],
    ['hook', describeHook(spec.hook)],
  ]);
}

async function listAction(flags: ListFlags): Promise<void> {
  const state = await loadState();
  if (flags.json) {
    printJson(state.watchers);
    return;
  }
  printTable([
    ['name', 'repo', 'target', 'triggers', 'interval', 'hook', 'lastCheckedAt', 'lastState'],
    ...state.watchers.map((spec) => [
      spec.name,
      spec.repo,
      targetKey(spec.target),
      describeTriggers(spec),
      formatDuration(spec.intervalSeconds * 1000),
      describeHook(spec.hook),
      spec.lastCheckedAt ?? '-',
      spec.lastState ?? '-',
    ]),
  ]);
}

async function showAction(name: string): Promise<void> {
  const spec = await getWatcher(name);
  if (spec === undefined) {
    process.exitCode = 1;
    throw new Error(`unknown watch "${name}"`);
  }
  printJson(spec);
}

async function removeAction(name: string): Promise<void> {
  const removed = await removeWatcher(name);
  if (!removed) {
    process.exitCode = 1;
    throw new Error(`unknown watch "${name}"`);
  }
  console.log(`removed watch "${name}"`);
}

async function checkAction(names: string[], flags: CheckFlags): Promise<void> {
  const state = await loadState();
  requireKnownNames(state, names);
  const wanted = names.length > 0 ? new Set(names) : undefined;
  const events: GhEvent[] = [];
  for (const spec of state.watchers) {
    if (wanted === undefined || wanted.has(spec.name)) {
      events.push(await checkWatchManual(spec));
    }
  }
  if (flags.json) {
    printJson(events);
    return;
  }
  for (const event of events) {
    console.log(`${describeEvent(event)}${event.fired ? ' (hook fired)' : ''}`);
  }
  process.exitCode = events.some((event) => event.fired) ? 0 : 1;
}

async function runAction(names: string[]): Promise<void> {
  const state = await loadState();
  requireKnownNames(state, names);
  process.stderr.write(`watching: ${selectedNames(state, names).join(', ')}\n`);
  await runDaemon(names.length > 0 ? names : undefined, { pollSeconds: 5 });
}

async function eventsAction(flags: EventsFlags): Promise<void> {
  const tail = flags.tail === undefined ? 20 : Number(flags.tail);
  if (!Number.isInteger(tail) || tail <= 0) {
    throw new Error(`invalid tail "${String(flags.tail)}": use a positive integer`);
  }
  const events = await readEvents(tail);
  if (flags.json) {
    printJson(events);
    return;
  }
  if (events.length === 0) {
    console.log('no events');
    return;
  }
  printTable([
    ['watch', 'repo', 'target', 'state', 'fired', 'checkedAt'],
    ...events.map((event) => [
      event.watch,
      event.repo,
      event.targetKey,
      event.state,
      String(event.fired),
      event.checkedAt,
    ]),
  ]);
}

export function registerWatchCommands(program: Command): void {
  const watch = program.command('watch').description('Manage persistent GitHub watches');
  watch
    .command('add')
    .description('Add a new watch')
    .argument('<name>', 'watch name')
    .requiredOption('--repo <owner/name>', 'repository in OWNER/NAME form')
    .option('--pr <number>', 'watch runs for this pull request', parseNumberOption)
    .option('--branch <name>', 'watch runs for this branch')
    .option('--commit <sha>', 'watch runs for this commit')
    .option('--run <id>', 'watch this run', parseNumberOption)
    .option('--on <event>', 'comma-separated: failure, success, complete (any terminal state), any, or pull request kinds (opened, reopened, closed, merged, draft, ready, comment, review, review_comment, push, review_decision); pull request kinds need --pr or --branch', 'complete')
    .option('--interval <duration>', 'poll interval', '60s')
    .option('--hook <spec>', `hook: ${HOOK_USAGE}`, 'none')
    .option('--json', 'emit the saved spec as JSON', false)
    .action(async (name, opts) => {
      await addAction(name as string, opts as AddFlags);
    });
  watch
    .command('list')
    .description('List saved watches')
    .option('--json', 'emit the watch list as JSON', false)
    .action(async (opts) => {
      await listAction(opts as ListFlags);
    });
  watch
    .command('show')
    .description('Show the full spec of a watch')
    .argument('<name>', 'watch name')
    .action(async (name) => {
      await showAction(name as string);
    });
  watch
    .command('remove')
    .description('Remove a watch')
    .argument('<name>', 'watch name')
    .action(async (name) => {
      await removeAction(name as string);
    });
  watch
    .command('check')
    .description('Check watches once and fire hooks on every trigger')
    .argument('[names...]', 'watch names, all when omitted')
    .option('--json', 'emit the events as a JSON array', false)
    .action(async (names, opts) => {
      await checkAction(names as string[], opts as CheckFlags);
    });
  watch
    .command('run')
    .description('Run the watch daemon until interrupted')
    .argument('[names...]', 'watch names, all when omitted')
    .action(async (names) => {
      await runAction(names as string[]);
    });
  watch
    .command('events')
    .description('Show recent watch events')
    .option('--tail <n>', 'number of events to show', '20')
    .option('--json', 'emit the events as a JSON array', false)
    .action(async (opts) => {
      await eventsAction(opts as EventsFlags);
    });
}
