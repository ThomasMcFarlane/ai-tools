import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkWatchManual } from '../core/engine.js';
import { evaluateRule, isMatchRule } from '../core/matcher.js';
import { answerValues, lookup } from '../core/resolver.js';
import { loadState, readEvents, saveState } from '../core/store.js';
import {
  RECORD_TYPES,
  type HookConfig,
  type LookupResult,
  type MatchRule,
  type RecordType,
  type TransportPreference,
  type WatchEvent,
  type WatchSpec,
} from '../core/types.js';

const MAX_WAIT_SECONDS = 900;
const TRANSPORTS = ['auto', 'udp', 'doh', 'system'] as const;

const recordTypeSchema = z.enum(RECORD_TYPES as [RecordType, ...RecordType[]]);
const transportSchema = z.enum(TRANSPORTS);

const hookSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('exec'), command: z.string().min(1) }),
  z.object({ kind: z.literal('webhook'), url: z.string().min(1) }),
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  z.object({ kind: z.literal('notify'), tool: z.enum(['claude', 'codex', 'opencode']) }),
]);

const ruleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('equals'), values: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('excludes'), values: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('contains'), value: z.string().min(1) }),
  z.object({ kind: z.literal('regex'), value: z.string().min(1) }),
  z.object({ kind: z.literal('absent') }),
  z.object({ kind: z.literal('any-change') }),
]);

type ToolRule = z.infer<typeof ruleSchema>;

export interface ToolDeps {
  lookupFn?: typeof lookup;
  now?: () => Date;
}

export type ToolResponse = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const lookupSchema = z.object({
  domain: z.string().min(1),
  types: z.array(recordTypeSchema).min(1).default(['A']),
  resolver: z.string().min(1).default('system'),
  transport: transportSchema.default('auto'),
});

const checkSchema = z.object({
  domain: z.string().min(1),
  type: recordTypeSchema,
  resolver: z.string().min(1).default('system'),
  transport: transportSchema.default('auto'),
  rule: ruleSchema,
});

const waitSchema = z.object({
  domain: z.string().min(1),
  type: recordTypeSchema,
  resolver: z.string().min(1).default('system'),
  transport: transportSchema.default('auto'),
  rule: ruleSchema,
  intervalSeconds: z.number().positive().default(30),
  timeoutSeconds: z.number().positive().default(600),
});

const watchAddSchema = z.object({
  name: z.string().min(1),
  domain: z.string().min(1),
  type: recordTypeSchema.default('A'),
  rule: ruleSchema,
  intervalSeconds: z.number().positive().default(60),
  resolver: z.string().min(1).optional(),
  transport: transportSchema.default('auto'),
  hook: hookSchema.default({ kind: 'none' }),
});

const watchListSchema = z.object({});

const watchRemoveSchema = z.object({
  name: z.string().min(1),
});

const watchCheckSchema = z.object({
  name: z.string().min(1).optional(),
});

const eventsSchema = z.object({
  tail: z.number().int().positive().default(20),
});

export const toolSchemas: Record<string, z.AnyZodObject> = {
  dns_lookup: lookupSchema,
  dns_check: checkSchema,
  dns_wait: waitSchema,
  dns_watch_add: watchAddSchema,
  dns_watch_list: watchListSchema,
  dns_watch_remove: watchRemoveSchema,
  dns_watch_check: watchCheckSchema,
  dns_events: eventsSchema,
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
  dns_lookup: 'Look up DNS records for a domain across one or more record types',
  dns_check: 'Check DNS records for a domain against a rule once',
  dns_wait: 'Poll DNS records until a rule matches or the wait times out (capped at 900 seconds)',
  dns_watch_add: 'Create a persistent named DNS watch with an optional notification hook',
  dns_watch_list: 'List saved DNS watches',
  dns_watch_remove: 'Remove a saved DNS watch by name',
  dns_watch_check: 'Run saved DNS watches once, optionally limited to one name, and return the events',
  dns_events: 'Show recent watch events, newest last',
};

function toMatchRule(rule: ToolRule): MatchRule {
  switch (rule.kind) {
    case 'equals':
      return { kind: 'equals', values: rule.values };
    case 'excludes':
      return { kind: 'excludes', values: rule.values };
    case 'contains':
      return { kind: 'contains', value: rule.value };
    case 'regex':
      return { kind: 'regex', pattern: rule.value };
    case 'absent':
      return { kind: 'absent' };
    case 'any-change':
      return { kind: 'any-change' };
  }
}

function validatedRule(rule: ToolRule): MatchRule {
  const mapped = toMatchRule(rule);
  if (!isMatchRule(mapped)) {
    throw new Error(`invalid rule: ${JSON.stringify(rule)}`);
  }
  return mapped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createToolHandlers(deps?: ToolDeps): Record<string, (args: unknown) => Promise<ToolResponse>> {
  const lookupFn = deps?.lookupFn ?? lookup;
  const now = deps?.now ?? ((): Date => new Date());

  const text = (payload: unknown): ToolResponse => ({
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  });
  const failure = (error: unknown): ToolResponse => {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
      isError: true,
    };
  };
  const wrap = (
    schema: z.AnyZodObject,
    run: (args: unknown) => Promise<unknown>,
  ): ((args: unknown) => Promise<ToolResponse>) =>
    async (rawArgs) => {
      try {
        return text(await run(schema.parse(rawArgs ?? {})));
      } catch (error) {
        return failure(error);
      }
    };

  const checkOutcome = async (rawArgs: unknown): Promise<unknown> => {
    const args = rawArgs as {
      domain: string;
      type: RecordType;
      resolver: string;
      transport: TransportPreference;
      rule: ToolRule;
    };
    const rule = validatedRule(args.rule);
    const result = await lookupFn(args.domain, args.type, {
      resolver: args.resolver,
      transport: args.transport,
    });
    const values = answerValues(result);
    if (result.error !== undefined) {
      return { matched: false, reason: result.error, values, rule };
    }
    if (rule.kind === 'any-change') {
      const key = `${args.domain}|${args.type}|${args.resolver}`;
      const state = await loadState();
      const baseline = state.baselines[key];
      if (baseline === undefined) {
        state.baselines[key] = values;
        await saveState(state);
        return { matched: false, reason: 'baseline recorded', values, rule };
      }
      const outcome = evaluateRule(rule, values, baseline);
      return { matched: outcome.matched, reason: outcome.reason, values, rule };
    }
    const outcome = evaluateRule(rule, values);
    return { matched: outcome.matched, reason: outcome.reason, values, rule };
  };

  const waitOutcome = async (rawArgs: unknown): Promise<unknown> => {
    const args = rawArgs as {
      domain: string;
      type: RecordType;
      resolver: string;
      transport: TransportPreference;
      rule: ToolRule;
      intervalSeconds: number;
      timeoutSeconds: number;
    };
    const rule = validatedRule(args.rule);
    const intervalMs = args.intervalSeconds * 1000;
    const timeoutMs = Math.min(args.timeoutSeconds, MAX_WAIT_SECONDS) * 1000;
    const deadline = Date.now() + timeoutMs;
    let baseline: string[] | null | undefined;
    for (;;) {
      const result = await lookupFn(args.domain, args.type, {
        resolver: args.resolver,
        transport: args.transport,
      });
      if (result.error !== undefined) {
        return { matched: false, reason: result.error, values: [], timedOut: false };
      }
      const values = answerValues(result);
      if (rule.kind === 'any-change' && baseline === undefined) {
        const key = `${args.domain}|${args.type}|${args.resolver}`;
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
        return { matched: true, reason: outcome.reason, values, timedOut: false };
      }
      if (Date.now() >= deadline) {
        break;
      }
      await sleep(Math.min(intervalMs, deadline - Date.now()));
    }
    return { matched: false, reason: `timed out after ${timeoutMs}ms`, values: [], timedOut: true };
  };

  return {
    dns_lookup: wrap(lookupSchema, async (rawArgs) => {
      const args = rawArgs as {
        domain: string;
        types: RecordType[];
        resolver: string;
        transport: TransportPreference;
      };
      const results: LookupResult[] = [];
      for (const type of args.types) {
        results.push(await lookupFn(args.domain, type, { resolver: args.resolver, transport: args.transport }));
      }
      return results;
    }),
    dns_check: wrap(checkSchema, checkOutcome),
    dns_wait: wrap(waitSchema, waitOutcome),
    dns_watch_add: wrap(watchAddSchema, async (rawArgs) => {
      const args = rawArgs as {
        name: string;
        domain: string;
        type: RecordType;
        rule: ToolRule;
        intervalSeconds: number;
        resolver?: string;
        transport: TransportPreference;
        hook: HookConfig;
      };
      const rule = validatedRule(args.rule);
      const state = await loadState();
      if (state.watchers.some((watcher) => watcher.name === args.name)) {
        throw new Error(`watch "${args.name}" already exists: remove it first or pick another name`);
      }
      const spec: WatchSpec = {
        name: args.name,
        domain: args.domain,
        type: args.type,
        rule,
        transport: args.transport,
        intervalSeconds: args.intervalSeconds,
        hook: args.hook,
        createdAt: now().toISOString(),
        resolver: args.resolver,
      };
      state.watchers.push(spec);
      await saveState(state);
      return spec;
    }),
    dns_watch_list: wrap(watchListSchema, async () => {
      const state = await loadState();
      return state.watchers;
    }),
    dns_watch_remove: wrap(watchRemoveSchema, async (rawArgs) => {
      const args = rawArgs as { name: string };
      const state = await loadState();
      if (!state.watchers.some((watcher) => watcher.name === args.name)) {
        throw new Error(`unknown watch "${args.name}"`);
      }
      state.watchers = state.watchers.filter((watcher) => watcher.name !== args.name);
      delete state.baselines[args.name];
      delete state.matched[args.name];
      await saveState(state);
      return { removed: true };
    }),
    dns_watch_check: wrap(watchCheckSchema, async (rawArgs) => {
      const args = rawArgs as { name?: string };
      const state = await loadState();
      if (args.name !== undefined && !state.watchers.some((watcher) => watcher.name === args.name)) {
        throw new Error(`unknown watch "${args.name}"`);
      }
      const wanted = args.name === undefined ? undefined : new Set([args.name]);
      const events: WatchEvent[] = [];
      for (const spec of state.watchers) {
        if (wanted === undefined || wanted.has(spec.name)) {
          events.push(await checkWatchManual(spec, { lookupFn, now }));
        }
      }
      return events;
    }),
    dns_events: wrap(eventsSchema, async (rawArgs) => {
      const args = rawArgs as { tail: number };
      return readEvents(args.tail);
    }),
  };
}

export async function startMcp(deps?: ToolDeps): Promise<void> {
  const loadPackage = createRequire(import.meta.url);
  const pkg = loadPackage('../../package.json') as { version?: string };
  const server = new McpServer({ name: 'dns-checker', version: pkg.version ?? '0.0.0' });
  const handlers = createToolHandlers(deps);
  for (const [name, handler] of Object.entries(handlers)) {
    const schema = toolSchemas[name];
    if (schema === undefined) {
      continue;
    }
    server.registerTool(
      name,
      {
        description: TOOL_DESCRIPTIONS[name] ?? name,
        inputSchema: schema.shape as Record<string, z.ZodTypeAny>,
      },
      async (args: Record<string, unknown>) => handler(args),
    );
  }
  await server.connect(new StdioServerTransport());
  process.stderr.write('[dns-checker] mcp server ready on stdio\n');
}
