import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentStateDir, type PathOptions } from '@ai-tools/agent-kit';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  WATCH_EVENTS,
  conditionSchema,
  intervalSchema,
  regexString,
  type ShopperDefaults,
} from '../defaults.js';
import { ShopperError, type Condition } from '../types.js';

export const AGENT_NAME = 'shopper';
export const ID_PATTERN = /^[a-z0-9-]{1,40}$/;

const timestamp = z.string().datetime({ offset: true });

export const watchSchema = z
  .object({
    id: z
      .string()
      .regex(ID_PATTERN, 'use 1 to 40 characters from a-z, 0-9 and -')
      .describe('Unique watch id.'),
    query: z.string().min(1).describe('Search query sent to the shops.'),
    spec: z
      .object({
        include: z
          .array(regexString)
          .default([])
          .describe('Case-insensitive regexes. A title must match every one.'),
        exclude: z
          .array(regexString)
          .default([])
          .describe('Case-insensitive regexes. A title that matches any one is dropped.'),
      })
      .strict()
      .default({}),
    sites: z
      .array(z.string().min(1))
      .nullable()
      .default(null)
      .describe('Site ids. null uses the sites of the defaults.'),
    condition: z
      .array(conditionSchema)
      .nullable()
      .default(null)
      .describe('Allowed conditions. null uses the condition rules of the defaults.'),
    maxPrice: z
      .number()
      .positive()
      .nullable()
      .default(null)
      .describe('Price threshold in the watch currency.'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'use an ISO 4217 code such as THB')
      .nullable()
      .default(null)
      .describe('ISO 4217 code. null uses the currency of the defaults.'),
    interval: intervalSchema.default('6h'),
    notify: z
      .object({
        on: z.array(z.enum(WATCH_EVENTS)).default([...WATCH_EVENTS]),
        minDropPercent: z.number().min(0).max(100).default(0),
      })
      .strict()
      .default({}),
    enabled: z.boolean().default(true),
    createdAt: timestamp,
    updatedAt: timestamp,
    lastRunAt: timestamp.nullable().default(null),
    lastStatus: z.enum(['ok', 'changes', 'error', 'baseline']).nullable().default(null),
  })
  .strict();

export type Watch = z.output<typeof watchSchema>;

export const watchesFileSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1).describe('Schema version. Always 1.'),
    watches: z.array(watchSchema).default([]),
  })
  .strict()
  .superRefine((file, context) => {
    const seen = new Set<string>();
    file.watches.forEach((watch, index) => {
      if (seen.has(watch.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['watches', index, 'id'],
          message: `duplicate watch id '${watch.id}'`,
        });
      }
      seen.add(watch.id);
    });
  });

export type WatchesFile = z.output<typeof watchesFileSchema>;

export function watchesJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(watchesFileSchema, {
    name: 'ShopperWatches',
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;
  const definitions = schema.definitions as Record<string, Record<string, unknown>> | undefined;
  const body = definitions?.ShopperWatches;
  if (body === undefined) return schema;
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'ShopperWatches',
    ...body,
  };
}

export class WatchStoreError extends ShopperError {
  constructor(
    message: string,
    readonly file: string | null = null,
  ) {
    super(message);
    this.name = 'WatchStoreError';
  }
}

export interface WatchPaths {
  stateDir: string;
  watchesFile: string;
  historyDir: string;
  lockFile: string;
}

export function watchPaths(opts: PathOptions = {}): WatchPaths {
  const env = opts.env ?? process.env;
  const stateDir = agentStateDir(AGENT_NAME, opts);
  const override = env.SHOPPER_WATCHES_FILE;
  return {
    stateDir,
    watchesFile:
      override !== undefined && override !== '' ? override : join(stateDir, 'watches.json'),
    historyDir: join(stateDir, 'history'),
    lockFile: join(stateDir, 'watch.lock'),
  };
}

export function historyFile(paths: WatchPaths, id: string): string {
  return join(paths.historyDir, `${id}.jsonl`);
}

function issueText(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ');
}

export function readWatches(file: string): WatchesFile {
  if (!existsSync(file)) return { version: 1, watches: [] };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new WatchStoreError(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      file,
    );
  }
  const parsed = watchesFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new WatchStoreError(`${file} is invalid: ${issueText(parsed.error)}`, file);
  }
  return parsed.data;
}

export function writeWatches(file: string, data: WatchesFile): void {
  const checked = watchesFileSchema.parse(data);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(checked, null, 2)}\n`);
  renameSync(temp, file);
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug === '' ? 'watch' : slug;
}

export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 40 - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface WatchInput {
  query?: string;
  id?: string;
  include?: string[];
  exclude?: string[];
  sites?: string[] | null;
  condition?: Condition[] | null;
  maxPrice?: number | null;
  currency?: string | null;
  interval?: string;
  on?: string[];
  minDropPercent?: number;
  enabled?: boolean;
}

function validate(candidate: unknown): Watch {
  const parsed = watchSchema.safeParse(candidate);
  if (!parsed.success) throw new WatchStoreError(issueText(parsed.error));
  return parsed.data;
}

export function buildWatch(
  input: WatchInput & { query: string },
  defaults: Pick<ShopperDefaults, 'watch'>,
  now: Date,
  takenIds: ReadonlySet<string>,
): Watch {
  const query = input.query.trim();
  const stamp = now.toISOString();
  let id: string;
  if (input.id !== undefined) {
    if (takenIds.has(input.id)) throw new WatchStoreError(`watch '${input.id}' already exists`);
    id = input.id;
  } else {
    id = uniqueId(slugify(query), takenIds);
  }
  return validate({
    id,
    query,
    spec: { include: input.include ?? [], exclude: input.exclude ?? [] },
    sites: input.sites ?? null,
    condition: input.condition ?? null,
    maxPrice: input.maxPrice ?? null,
    currency: input.currency ?? null,
    interval: input.interval ?? defaults.watch.interval,
    notify: {
      on: input.on ?? [...defaults.watch.notifyOn],
      minDropPercent: input.minDropPercent ?? defaults.watch.minDropPercent,
    },
    enabled: input.enabled ?? true,
    createdAt: stamp,
    updatedAt: stamp,
    lastRunAt: null,
    lastStatus: null,
  });
}

export function applyEdit(watch: Watch, patch: WatchInput, now: Date): Watch {
  return validate({
    ...watch,
    query: patch.query === undefined ? watch.query : patch.query.trim(),
    spec: {
      include: patch.include ?? watch.spec.include,
      exclude: patch.exclude ?? watch.spec.exclude,
    },
    sites: patch.sites === undefined ? watch.sites : patch.sites,
    condition: patch.condition === undefined ? watch.condition : patch.condition,
    maxPrice: patch.maxPrice === undefined ? watch.maxPrice : patch.maxPrice,
    currency: patch.currency === undefined ? watch.currency : patch.currency,
    interval: patch.interval ?? watch.interval,
    notify: {
      on: patch.on ?? watch.notify.on,
      minDropPercent: patch.minDropPercent ?? watch.notify.minDropPercent,
    },
    enabled: patch.enabled ?? watch.enabled,
    updatedAt: now.toISOString(),
  });
}

export function specHash(
  watch: Pick<Watch, 'query' | 'spec' | 'sites' | 'condition' | 'currency'>,
): string {
  const text = JSON.stringify([
    watch.query,
    watch.spec.include,
    watch.spec.exclude,
    watch.sites,
    watch.condition,
    watch.currency,
  ]);
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function findWatch(data: WatchesFile, id: string): Watch {
  const found = data.watches.find((watch) => watch.id === id);
  if (found === undefined) throw new WatchStoreError(`no watch with id '${id}'`);
  return found;
}

export function addWatch(
  file: string,
  input: WatchInput & { query: string },
  defaults: Pick<ShopperDefaults, 'watch'>,
  now: Date,
): Watch {
  const data = readWatches(file);
  const watch = buildWatch(input, defaults, now, new Set(data.watches.map((entry) => entry.id)));
  writeWatches(file, { ...data, watches: [...data.watches, watch] });
  return watch;
}

export function editWatch(file: string, id: string, patch: WatchInput, now: Date): Watch {
  const data = readWatches(file);
  const updated = applyEdit(findWatch(data, id), patch, now);
  writeWatches(file, {
    ...data,
    watches: data.watches.map((entry) => (entry.id === id ? updated : entry)),
  });
  return updated;
}

export function removeWatch(file: string, id: string): Watch {
  const data = readWatches(file);
  const removed = findWatch(data, id);
  writeWatches(file, { ...data, watches: data.watches.filter((entry) => entry.id !== id) });
  return removed;
}

export function recordRun(
  file: string,
  id: string,
  ranAt: Date,
  status: NonNullable<Watch['lastStatus']>,
): void {
  const data = readWatches(file);
  if (!data.watches.some((entry) => entry.id === id)) return;
  writeWatches(file, {
    ...data,
    watches: data.watches.map((entry) =>
      entry.id === id ? { ...entry, lastRunAt: ranAt.toISOString(), lastStatus: status } : entry,
    ),
  });
}
