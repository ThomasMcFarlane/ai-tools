import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CONDITIONS, FETCH_MODES } from './types.js';

export const regexString = z.string().refine(
  (value) => {
    try {
      new RegExp(value, 'i');
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be a valid regular expression' },
);

export const conditionSchema = z.enum(CONDITIONS as unknown as [string, ...string[]]);

export const WATCH_EVENTS = [
  'new',
  'price_drop',
  'back_in_stock',
  'threshold',
  'scanner_failing',
] as const;

export const MIN_WATCH_INTERVAL_MS = 15 * 60_000;

const INTERVAL_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseInterval(text: string): number | null {
  const match = /^(\d+)([mhd])$/.exec(text.trim());
  if (match === null) return null;
  return Number(match[1]) * (INTERVAL_UNITS[match[2] as string] as number);
}

export const intervalSchema = z
  .string()
  .refine((value) => parseInterval(value) !== null, {
    message: 'use a number and a unit: 15m, 6h or 1d',
  })
  .refine(
    (value) => {
      const ms = parseInterval(value);
      return ms === null || ms >= MIN_WATCH_INTERVAL_MS;
    },
    { message: 'the shortest interval is 15m' },
  );

const timeZoneSchema = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be an IANA time zone such as Asia/Bangkok or UTC' },
);

export const shopperDefaultsSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1).describe('Schema version. Always 1.'),
    location: z
      .object({
        country: z
          .string()
          .regex(/^[A-Z]{2}$/, 'use an ISO 3166 alpha-2 code such as TH')
          .default('TH'),
        city: z.string().optional(),
        postcode: z.string().optional(),
      })
      .default({}),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'use an ISO 4217 code such as THB')
      .default('THB'),
    language: z.string().default('en'),
    sites: z
      .object({
        preferred: z
          .array(z.string())
          .default([])
          .describe(
            'Site ids to search. Empty means every adapter. Sites that need the user browser are reported, never fetched.',
          ),
        blocked: z.array(z.string()).default([]).describe('Site ids never to search.'),
      })
      .default({}),
    condition: z
      .object({
        default: z.array(conditionSchema).default(['new']),
        rules: z
          .array(
            z.object({
              match: regexString.describe('Case-insensitive regex tested against the query.'),
              allow: z.array(conditionSchema),
              note: z.string().optional(),
            }),
          )
          .default([]),
        unmatched: z
          .enum(['use-default', 'ask'])
          .default('use-default')
          .describe(
            'What to do when no rule matches the query. ask keeps every condition and flags the result so the model asks the user.',
          ),
      })
      .default({}),
    budget: z
      .object({
        style: z.enum(['cheapest', 'value', 'premium']).default('cheapest'),
        max: z.number().positive().optional(),
        includeShipping: z.boolean().default(true),
      })
      .default({}),
    report: z
      .object({
        limit: z.number().int().positive().default(10),
        onlySeen: z.literal(true).default(true),
        showStock: z.boolean().default(true),
        showShop: z.boolean().default(true),
        timeZones: z
          .array(timeZoneSchema)
          .min(1)
          .default(['UTC'])
          .describe('IANA time zones for printed timestamps. The first zone comes first.'),
      })
      .default({}),
    browser: z
      .object({
        userBrowserSites: z
          .array(z.string())
          .default(['shopee-th', 'bnn', 'facebook-marketplace'])
          .describe('Sites the CLI never fetches. The user supplies the page from an open tab.'),
      })
      .default({}),
    watch: z
      .object({
        interval: intervalSchema.default('6h'),
        notifyOn: z.array(z.enum(WATCH_EVENTS)).default([...WATCH_EVENTS]),
        minDropPercent: z.number().min(0).max(100).default(0),
        notifyCommand: z
          .string()
          .nullable()
          .default(null)
          .describe(
            'Shell command that gets the message on stdin. SHOPPER_NOTIFY_CMD overrides it.',
          ),
        quietUnchanged: z.boolean().default(true).describe('Send no message when nothing changed.'),
      })
      .default({}),
    notes: z.array(z.string()).default([]).describe('Free text rules for the model.'),
  })
  .strict();

export type ShopperDefaults = z.output<typeof shopperDefaultsSchema>;

export function builtinDefaults(adapterIds: string[]): Record<string, unknown> {
  return {
    version: 1,
    location: { country: 'TH' },
    currency: 'THB',
    language: 'en',
    sites: { preferred: adapterIds, blocked: [] },
    condition: { default: ['new'], rules: [], unmatched: 'use-default' },
    budget: { style: 'cheapest', includeShipping: true },
    report: {
      limit: 10,
      onlySeen: true,
      showStock: true,
      showShop: true,
      timeZones: ['UTC'],
    },
    browser: { userBrowserSites: ['shopee-th', 'bnn', 'facebook-marketplace'] },
    watch: {
      interval: '6h',
      notifyOn: [...WATCH_EVENTS],
      minDropPercent: 0,
      notifyCommand: null,
      quietUnchanged: true,
    },
    notes: [],
  };
}

export function defaultsJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(shopperDefaultsSchema, {
    name: 'ShopperDefaults',
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;
  const definitions = schema.definitions as Record<string, Record<string, unknown>> | undefined;
  const body = definitions?.ShopperDefaults;
  if (body === undefined) return schema;
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'ShopperDefaults',
    ...body,
  };
}

export function unknownSiteWarnings(defaults: ShopperDefaults, knownIds: string[]): string[] {
  const known = new Set(knownIds);
  const warnings: string[] = [];
  const groups: Array<[string, string[]]> = [
    ['sites.preferred', defaults.sites.preferred],
    ['sites.blocked', defaults.sites.blocked],
    ['browser.userBrowserSites', defaults.browser.userBrowserSites],
  ];
  for (const [path, ids] of groups) {
    for (const id of ids) {
      if (!known.has(id)) warnings.push(`${path}: unknown site '${id}' (no adapter yet)`);
    }
  }
  return warnings;
}

export { FETCH_MODES };
