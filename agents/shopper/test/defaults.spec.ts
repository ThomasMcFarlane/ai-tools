import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  builtinDefaults,
  defaultsJsonSchema,
  parseInterval,
  shopperDefaultsSchema,
  unknownSiteWarnings,
} from '../src/core/defaults.js';

describe('defaults schema', () => {
  it('accepts the built-in defaults', () => {
    const parsed = shopperDefaultsSchema.parse(builtinDefaults(['a', 'b']));
    expect(parsed.currency).toBe('THB');
    expect(parsed.sites.preferred).toEqual(['a', 'b']);
    expect(parsed.browser.userBrowserSites).toEqual(['shopee-th', 'bnn']);
  });

  it('fills every default from a minimal file', () => {
    const parsed = shopperDefaultsSchema.parse({ version: 1 });
    expect(parsed.location.country).toBe('TH');
    expect(parsed.budget).toEqual({ style: 'cheapest', includeShipping: true });
    expect(parsed.report.limit).toBe(10);
    expect(parsed.notes).toEqual([]);
  });

  it('rejects bad values', () => {
    expect(() => shopperDefaultsSchema.parse({ version: 1, currency: 'baht' })).toThrow();
    expect(() => shopperDefaultsSchema.parse({ version: 1, extra: true })).toThrow();
    expect(() =>
      shopperDefaultsSchema.parse({
        version: 1,
        condition: { rules: [{ match: '(', allow: ['new'] }] },
      }),
    ).toThrow(/regular expression/);
    expect(() =>
      shopperDefaultsSchema.parse({ version: 1, condition: { default: ['broken'] } }),
    ).toThrow();
  });

  it('keeps the committed defaults.schema.json current', () => {
    const file = fileURLToPath(new URL('../defaults.schema.json', import.meta.url));
    const committed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    expect(committed).toEqual(JSON.parse(JSON.stringify(defaultsJsonSchema())));
  });
});

describe('condition.unmatched and report.timeZones', () => {
  it('defaults to use-default and UTC', () => {
    const parsed = shopperDefaultsSchema.parse({ version: 1 });
    expect(parsed.condition.unmatched).toBe('use-default');
    expect(parsed.report.timeZones).toEqual(['UTC']);
  });

  it('accepts ask and IANA zones, rejects the rest', () => {
    const parsed = shopperDefaultsSchema.parse({
      version: 1,
      condition: { unmatched: 'ask' },
      report: { timeZones: ['Asia/Bangkok', 'Europe/London'] },
    });
    expect(parsed.condition.unmatched).toBe('ask');
    expect(parsed.report.timeZones).toEqual(['Asia/Bangkok', 'Europe/London']);
    expect(() =>
      shopperDefaultsSchema.parse({ version: 1, condition: { unmatched: 'maybe' } }),
    ).toThrow();
    expect(() =>
      shopperDefaultsSchema.parse({ version: 1, report: { timeZones: ['Mars/Base'] } }),
    ).toThrow(/IANA/);
    expect(() => shopperDefaultsSchema.parse({ version: 1, report: { timeZones: [] } })).toThrow();
  });
});

describe('watch section', () => {
  it('has the documented defaults', () => {
    expect(shopperDefaultsSchema.parse({ version: 1 }).watch).toEqual({
      interval: '6h',
      notifyOn: ['new', 'price_drop', 'back_in_stock', 'threshold', 'scanner_failing'],
      minDropPercent: 0,
      notifyCommand: null,
      quietUnchanged: true,
    });
  });

  it('parses intervals in m, h and d', () => {
    expect(parseInterval('15m')).toBe(900_000);
    expect(parseInterval('6h')).toBe(21_600_000);
    expect(parseInterval('2d')).toBe(172_800_000);
    expect(parseInterval('6x')).toBeNull();
    expect(parseInterval('h')).toBeNull();
  });

  it('enforces the 15 minute minimum and the value ranges', () => {
    const watch = (value: unknown) => shopperDefaultsSchema.parse({ version: 1, watch: value });
    expect(watch({ interval: '15m' }).watch.interval).toBe('15m');
    expect(() => watch({ interval: '10m' })).toThrow(/15m/);
    expect(() => watch({ interval: 'often' })).toThrow();
    expect(() => watch({ minDropPercent: 101 })).toThrow();
    expect(() => watch({ minDropPercent: -1 })).toThrow();
    expect(() => watch({ notifyOn: ['sometimes'] })).toThrow();
    expect(
      watch({ notifyOn: ['new'], notifyCommand: 'notify-send', quietUnchanged: false }).watch,
    ).toMatchObject({
      notifyOn: ['new'],
      notifyCommand: 'notify-send',
      quietUnchanged: false,
    });
  });
});

describe('unknownSiteWarnings', () => {
  it('names unknown ids in every site list without failing validation', () => {
    const parsed = shopperDefaultsSchema.parse({
      version: 1,
      sites: { preferred: ['jib', 'facebook-marketplace'], blocked: ['ghost'] },
      browser: { userBrowserSites: ['shopee-th', 'facebook-marketplace'] },
    });
    expect(unknownSiteWarnings(parsed, ['jib', 'shopee-th'])).toEqual([
      "sites.preferred: unknown site 'facebook-marketplace' (no adapter yet)",
      "sites.blocked: unknown site 'ghost' (no adapter yet)",
      "browser.userBrowserSites: unknown site 'facebook-marketplace' (no adapter yet)",
    ]);
  });
});
