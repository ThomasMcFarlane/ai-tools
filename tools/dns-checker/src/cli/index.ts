#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { answerValues, lookup } from '../core/resolver.js';
import { evaluateRule } from '../core/matcher.js';
import { loadState, saveState } from '../core/store.js';
import { RESOLVERS, listResolverNames, resolveServer } from '../core/resolvers.js';
import {
  RECORD_TYPES,
  type LookupResult,
  type MatchOutcome,
  type MatchRule,
  type RecordType,
  type TransportPreference,
} from '../core/types.js';
import { formatDuration, parseDuration } from './duration.js';
import { printJson, printTable } from './output.js';
import { buildRule, type RuleFlags } from './rules.js';
import { registerWatchCommands } from './watch.js';

const TRANSPORTS: readonly string[] = ['auto', 'udp', 'doh', 'system'];
const MAX_WAIT_TIMEOUT_MS = 24 * 3_600_000;

interface LookupFlags {
  type?: string[];
  resolver?: string[];
  transport?: string;
  timeout?: string;
  strict?: boolean;
  json?: boolean;
}

interface CheckFlags extends RuleFlags {
  type?: string;
  resolver?: string;
  transport?: string;
  timeout?: string;
  json?: boolean;
}

interface WaitFlags extends RuleFlags {
  type?: string;
  resolver?: string;
  transport?: string;
  interval?: string;
  timeout?: string;
  json?: boolean;
}

interface Target {
  type: RecordType;
  resolver: string;
  transport: TransportPreference;
}

function splitList(values: string[]): string[] {
  return values.flatMap((value) => value.split(',')).filter((value) => value.length > 0);
}

function parseMultiTypes(raw: string[] | undefined): RecordType[] {
  const list = raw === undefined ? ['A'] : splitList(raw);
  if (list.length === 0) {
    throw new Error('no record types given');
  }
  for (const value of list) {
    if (!(RECORD_TYPES as readonly string[]).includes(value)) {
      throw new Error(`unsupported record type "${value}": supported types are ${RECORD_TYPES.join(', ')}`);
    }
  }
  return list as RecordType[];
}

function parseTarget(flags: {
  type?: string;
  resolver?: string;
  transport?: string;
}): Target {
  const resolver = flags.resolver ?? 'system';
  resolveServer(resolver);
  const type = flags.type ?? 'A';
  if (!(RECORD_TYPES as readonly string[]).includes(type)) {
    throw new Error(`unsupported record type "${type}": supported types are ${RECORD_TYPES.join(', ')}`);
  }
  return {
    type: type as RecordType,
    resolver,
    transport: parseTransport(flags.transport),
  };
}

function parseMultiResolvers(raw: string[] | undefined): string[] {
  const list = raw === undefined ? ['system'] : splitList(raw);
  if (list.length === 0) {
    throw new Error('no resolvers given');
  }
  const expanded: string[] = [];
  for (const value of list) {
    if (value === 'all') {
      expanded.push(...listResolverNames());
    } else {
      resolveServer(value);
      expanded.push(value);
    }
  }
  return expanded;
}

function parseTransport(raw: string | undefined): TransportPreference {
  const value = raw ?? 'auto';
  if (!TRANSPORTS.includes(value)) {
    throw new Error(`invalid transport "${value}": use auto, udp, doh or system`);
  }
  return value as TransportPreference;
}

function parseTimeoutMs(raw: string | undefined): number {
  const value = Number(raw ?? '5000');
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid timeout "${String(raw)}": use a positive number of milliseconds, e.g. 5000`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRuleOrExit(flags: RuleFlags): MatchRule {
  try {
    return buildRule(flags);
  } catch (error) {
    process.exitCode = 2;
    throw error;
  }
}

async function lookupAction(domain: string, flags: LookupFlags): Promise<void> {
  const types = parseMultiTypes(flags.type);
  const resolvers = parseMultiResolvers(flags.resolver);
  const transport = parseTransport(flags.transport);
  const timeoutMs = parseTimeoutMs(flags.timeout);
  const results: LookupResult[] = [];
  for (const type of types) {
    for (const resolver of resolvers) {
      results.push(await lookup(domain, type, { resolver, transport, timeoutMs }));
    }
  }
  if (flags.json) {
    printJson(results);
  } else {
    for (const result of results) {
      const label = `${result.domain} ${result.type} via ${result.resolver}`;
      console.log(label);
      if (result.error !== undefined) {
        console.error(`${label}: error: ${result.error}`);
      } else if (result.answers.length === 0) {
        console.log('  no records');
      } else {
        for (const answer of result.answers) {
          console.log(`  ${answer.value} (ttl ${answer.ttl})`);
        }
      }
    }
  }
  if (flags.strict === true && results.length > 0 && results.every((result) => result.error !== undefined)) {
    process.exitCode = 1;
  }
}

function finishCheck(outcome: MatchOutcome, values: string[], rule: MatchRule, json: boolean | undefined): void {
  if (json) {
    printJson({ matched: outcome.matched, reason: outcome.reason, values, rule });
  } else {
    console.log(`${outcome.matched ? 'matched' : 'not matched'}: ${outcome.reason}`);
  }
  process.exitCode = outcome.matched ? 0 : 1;
}

async function checkAction(domain: string, flags: CheckFlags): Promise<void> {
  const target = parseTarget(flags);
  const timeoutMs = parseTimeoutMs(flags.timeout);
  const rule = buildRuleOrExit(flags);
  const result = await lookup(domain, target.type, {
    resolver: target.resolver,
    transport: target.transport,
    timeoutMs,
  });
  const values = answerValues(result);
  if (result.error !== undefined) {
    if (flags.json) {
      printJson({ matched: false, reason: result.error, values, rule });
    } else {
      console.error(`error: ${result.error}`);
    }
    process.exitCode = 2;
    return;
  }
  const key = `${domain}|${target.type}|${target.resolver}`;
  if (rule.kind === 'any-change') {
    const state = await loadState();
    const baseline = state.baselines[key];
    if (baseline === undefined) {
      state.baselines[key] = values;
      await saveState(state);
      if (flags.json) {
        printJson({ matched: false, reason: 'baseline recorded', values, rule });
      } else {
        console.log('baseline recorded');
      }
      return;
    }
    finishCheck(evaluateRule(rule, values, baseline), values, rule, flags.json);
    return;
  }
  finishCheck(evaluateRule(rule, values), values, rule, flags.json);
}

async function waitAction(domain: string, flags: WaitFlags): Promise<void> {
  const target = parseTarget(flags);
  const rule = buildRuleOrExit(flags);
  const intervalMs = parseDuration(flags.interval ?? '30s');
  const timeoutMs = Math.min(parseDuration(flags.timeout ?? '30m'), MAX_WAIT_TIMEOUT_MS);
  const key = `${domain}|${target.type}|${target.resolver}`;
  let baseline: string[] | null | undefined;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await lookup(domain, target.type, {
      resolver: target.resolver,
      transport: target.transport,
    });
    if (result.error !== undefined) {
      if (flags.json) {
        printJson({ matched: false, reason: result.error, values: [], rule });
      } else {
        console.error(`error: ${result.error}`);
      }
      process.exitCode = 2;
      return;
    }
    const values = answerValues(result);
    if (rule.kind === 'any-change' && baseline === undefined) {
      const state = await loadState();
      const stored = state.baselines[key];
      if (stored === undefined) {
        state.baselines[key] = values;
        await saveState(state);
        baseline = null;
      } else {
        baseline = stored;
      }
    }
    const outcome = evaluateRule(rule, values, baseline);
    if (outcome.matched) {
      if (flags.json) {
        printJson({ matched: true, reason: outcome.reason, values, checkedAt: result.checkedAt });
      } else {
        process.stderr.write('\n');
        console.log(`matched: ${outcome.reason}`);
      }
      process.exitCode = 0;
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
    printJson({ matched: false, timedOut: true });
  } else {
    process.stderr.write('\n');
    console.error(`timed out after ${formatDuration(timeoutMs)}`);
  }
  process.exitCode = 124;
}

function buildProgram(): Command {
  const p = new Command();
  p.name('dns-checker').description('DNS lookup, checking and watching for AI agents');
  p.command('lookup')
    .description('Look up DNS records for a domain')
    .argument('<domain>', 'domain name to look up')
    .option('-t, --type <types...>', 'record types, comma or space separated (default A)')
    .option('-r, --resolver <names...>', 'resolvers: system, a registry name, all, or a literal IP (default system)')
    .option('--transport <mode>', 'transport: auto, udp, doh or system', 'auto')
    .option('--timeout <ms>', 'per-lookup timeout in milliseconds', '5000')
    .option('--strict', 'exit 1 when every lookup errors', false)
    .option('--json', 'emit results as JSON', false)
    .action(async (domain, opts) => {
      await lookupAction(domain as string, opts as LookupFlags);
    });
  p.command('check')
    .description('Check DNS records against a rule once')
    .argument('<domain>', 'domain name to check')
    .option('-t, --type <type>', 'record type', 'A')
    .option('-r, --resolver <name>', 'resolver: system, a registry name, or a literal IP', 'system')
    .option('--transport <mode>', 'transport: auto, udp, doh or system', 'auto')
    .option('--timeout <ms>', 'lookup timeout in milliseconds', '5000')
    .option('--expect <values...>', 'match when the value set equals this set')
    .option('--expect-absent <values...>', 'match when none of these values are present')
    .option('--contains <value>', 'match when any value contains this substring')
    .option('--regex <pattern>', 'match when any value matches this regular expression')
    .option('--absent', 'match when no records are returned', false)
    .option('--any-change', 'match when values differ from the recorded baseline', false)
    .option('--json', 'emit the outcome as JSON', false)
    .action(async (domain, opts) => {
      await checkAction(domain as string, opts as CheckFlags);
    });
  p.command('wait')
    .description('Poll DNS until a rule matches or the wait times out')
    .argument('<domain>', 'domain name to watch')
    .option('-t, --type <type>', 'record type', 'A')
    .option('-r, --resolver <name>', 'resolver: system, a registry name, or a literal IP', 'system')
    .option('--transport <mode>', 'transport: auto, udp, doh or system', 'auto')
    .option('--interval <duration>', 'poll interval', '30s')
    .option('--timeout <duration>', 'overall wait limit, capped at 24h', '30m')
    .option('--expect <values...>', 'match when the value set equals this set')
    .option('--expect-absent <values...>', 'match when none of these values are present')
    .option('--contains <value>', 'match when any value contains this substring')
    .option('--regex <pattern>', 'match when any value matches this regular expression')
    .option('--absent', 'match when no records are returned', false)
    .option('--any-change', 'match when values differ from the recorded baseline', false)
    .option('--json', 'emit the outcome as JSON', false)
    .action(async (domain, opts) => {
      await waitAction(domain as string, opts as WaitFlags);
    });
  p.command('resolvers')
    .description('List the built-in resolver presets')
    .option('--json', 'emit the resolver list as JSON', false)
    .action((opts) => {
      const defs = Object.values(RESOLVERS);
      if ((opts as { json?: boolean }).json) {
        printJson(defs);
        return;
      }
      printTable([
        ['name', 'label', 'ips', 'doh'],
        ...defs.map((def) => [def.name, def.label, def.ips.join(','), def.doh ?? '-']),
      ]);
    });
  p.command('mcp')
    .description('Run the MCP server')
    .action(async () => {
      try {
        const specifier = '../mcp/server.js';
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
