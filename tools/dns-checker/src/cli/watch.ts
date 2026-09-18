import type { Command } from 'commander';
import { checkWatchManual, runDaemon } from '../core/engine.js';
import { describeRule } from '../core/matcher.js';
import { loadState, readEvents, saveState } from '../core/store.js';
import {
  RECORD_TYPES,
  type HookConfig,
  type RecordType,
  type TransportPreference,
  type WatchEvent,
  type WatchSpec,
  type WatcherState,
} from '../core/types.js';
import { formatDuration, parseDuration } from './duration.js';
import { printJson, printTable } from './output.js';
import { buildRule, type RuleFlags } from './rules.js';

const TRANSPORTS: readonly string[] = ['auto', 'udp', 'doh', 'system'];
const HOOK_USAGE =
  'use none, exec:<command>, webhook:<url>, file:<path>, notify:claude, notify:codex or notify:opencode';

interface AddFlags extends RuleFlags {
  domain: string;
  type?: string;
  resolver?: string;
  transport?: string;
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

function parseTransport(raw: string | undefined): TransportPreference {
  const value = raw ?? 'auto';
  if (!TRANSPORTS.includes(value)) {
    throw new Error(`invalid transport "${value}": use auto, udp, doh or system`);
  }
  return value as TransportPreference;
}

function buildRuleOrExit(flags: RuleFlags): ReturnType<typeof buildRule> {
  try {
    return buildRule(flags);
  } catch (error) {
    process.exitCode = 2;
    throw error;
  }
}

function requireWatcher(state: WatcherState, name: string): WatchSpec {
  const watcher = state.watchers.find((entry) => entry.name === name);
  if (watcher === undefined) {
    process.exitCode = 1;
    throw new Error(`unknown watch "${name}"`);
  }
  return watcher;
}

function requireKnownNames(state: WatcherState, names: string[]): void {
  for (const name of names) {
    if (!state.watchers.some((entry) => entry.name === name)) {
      process.exitCode = 2;
      throw new Error(`unknown watch "${name}"`);
    }
  }
}

function selectedNames(state: WatcherState, names: string[]): string[] {
  if (names.length === 0) {
    return state.watchers.map((entry) => entry.name);
  }
  const wanted = new Set(names);
  return state.watchers.map((entry) => entry.name).filter((name) => wanted.has(name));
}

async function addAction(name: string, flags: AddFlags): Promise<void> {
  const type = flags.type ?? 'A';
  if (!(RECORD_TYPES as readonly string[]).includes(type)) {
    throw new Error(`unsupported record type "${type}": supported types are ${RECORD_TYPES.join(', ')}`);
  }
  const rule = buildRuleOrExit(flags);
  const hook = parseHookSpec(flags.hook ?? 'none');
  const intervalMs = parseDuration(flags.interval ?? '60s');
  if (intervalMs <= 0) {
    throw new Error(`invalid interval "${String(flags.interval)}": use a positive duration`);
  }
  const transport = parseTransport(flags.transport);
  const state = await loadState();
  if (state.watchers.some((entry) => entry.name === name)) {
    process.exitCode = 1;
    throw new Error(`watch "${name}" already exists: remove it first or pick another name`);
  }
  const spec: WatchSpec = {
    name,
    domain: flags.domain,
    type: type as RecordType,
    rule,
    transport,
    intervalSeconds: intervalMs / 1000,
    hook,
    createdAt: new Date().toISOString(),
    resolver: flags.resolver,
  };
  state.watchers.push(spec);
  await saveState(state);
  if (flags.json) {
    printJson(spec);
    return;
  }
  printTable([
    ['field', 'value'],
    ['name', spec.name],
    ['domain', spec.domain],
    ['type', spec.type],
    ['rule', describeRule(spec.rule)],
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
    ['name', 'domain', 'type', 'rule', 'interval', 'hook', 'lastCheckedAt', 'lastMatchAt'],
    ...state.watchers.map((spec) => [
      spec.name,
      spec.domain,
      spec.type,
      describeRule(spec.rule),
      formatDuration(spec.intervalSeconds * 1000),
      describeHook(spec.hook),
      spec.lastCheckedAt ?? '-',
      spec.lastMatchAt ?? '-',
    ]),
  ]);
}

async function showAction(name: string): Promise<void> {
  const state = await loadState();
  printJson(requireWatcher(state, name));
}

async function removeAction(name: string): Promise<void> {
  const state = await loadState();
  requireWatcher(state, name);
  state.watchers = state.watchers.filter((entry) => entry.name !== name);
  delete state.baselines[name];
  delete state.matched[name];
  await saveState(state);
  console.log(`removed watch "${name}"`);
}

async function checkAction(names: string[], flags: CheckFlags): Promise<void> {
  const state = await loadState();
  requireKnownNames(state, names);
  const wanted = names.length > 0 ? new Set(names) : undefined;
  const events: WatchEvent[] = [];
  for (const spec of state.watchers) {
    if (wanted === undefined || wanted.has(spec.name)) {
      events.push(await checkWatchManual(spec));
    }
  }
  if (flags.json) {
    printJson(events);
  } else {
    for (const event of events) {
      const fired = event.fired ? ' (hook fired)' : '';
      console.log(`${event.watch}: ${event.matched ? 'matched' : 'not matched'}: ${event.reason}${fired}`);
    }
  }
  process.exitCode = events.some((event) => event.matched) ? 0 : 1;
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
    ['watch', 'domain', 'type', 'matched', 'fired', 'reason', 'checkedAt'],
    ...events.map((event) => [
      event.watch,
      event.domain,
      event.type,
      String(event.matched),
      String(event.fired),
      event.reason,
      event.checkedAt,
    ]),
  ]);
}

export function registerWatchCommands(program: Command): void {
  const watch = program.command('watch').description('Manage persistent DNS watches');
  watch
    .command('add')
    .description('Add a new watch')
    .argument('<name>', 'watch name')
    .requiredOption('--domain <d>', 'domain name to watch')
    .option('-t, --type <type>', 'record type', 'A')
    .option('--expect <values...>', 'match when the value set equals this set')
    .option('--expect-absent <values...>', 'match when none of these values are present')
    .option('--contains <value>', 'match when any value contains this substring')
    .option('--regex <pattern>', 'match when any value matches this regular expression')
    .option('--absent', 'match when no records are returned', false)
    .option('--any-change', 'match when values differ from the recorded baseline', false)
    .option('--interval <duration>', 'poll interval', '60s')
    .option('-r, --resolver <name>', 'resolver: system, a registry name, or a literal IP')
    .option('--transport <mode>', 'transport: auto, udp, doh or system', 'auto')
    .option(
      '--hook <spec>',
      `hook: ${HOOK_USAGE}`,
      'none',
    )
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
    .description('Check watches once and fire hooks on every match')
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
