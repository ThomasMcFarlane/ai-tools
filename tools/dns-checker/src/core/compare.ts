import { answerValues } from './resolver.js';
import { resolveServer, type ResolverLocation } from './resolvers.js';
import type { DnsAnswer, LookupResult, RecordType } from './types.js';

export type CompareStatus = 'match' | 'differ' | 'error';

export interface CompareRow {
  resolver: string;
  ips: string[];
  location?: ResolverLocation;
  transport: string;
  status: CompareStatus;
  answers: DnsAnswer[];
  error?: string;
}

export interface CompareGroup {
  domain: string;
  type: RecordType;
  expected?: string[];
  reference: string[];
  referenceKind: 'expected' | 'majority';
  rows: CompareRow[];
}

export interface CompareReport {
  domain: string;
  generatedAt: string;
  groups: CompareGroup[];
}

export interface CompareSummary {
  match: number;
  differ: number;
  error: number;
  total: number;
  byCountry: { countryCode: string; match: number; total: number }[];
}

function setKey(values: string[]): string {
  return JSON.stringify([...values].sort());
}

function majority(sets: string[][]): string[] {
  const counts = new Map<string, { values: string[]; count: number }>();
  for (const values of sets) {
    const key = setKey(values);
    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(key, { values, count: 1 });
    }
  }
  let best: { values: string[]; count: number } | undefined;
  for (const entry of counts.values()) {
    if (best === undefined || entry.count > best.count) {
      best = entry;
    }
  }
  return best?.values ?? [];
}

function ipsFor(resolver: string): string[] {
  try {
    return resolveServer(resolver).ips ?? [];
  } catch {
    return [];
  }
}

export function buildGroup(results: LookupResult[], expected?: string[]): CompareGroup {
  const first = results[0];
  if (first === undefined) {
    throw new Error('cannot compare an empty result list');
  }
  const reference =
    expected !== undefined
      ? expected
      : majority(
          results
            .filter((result) => result.error === undefined)
            .map((result) => answerValues(result)),
        );
  const referenceKey = setKey(reference);
  const rows = results.map((result): CompareRow => {
    const status: CompareStatus =
      result.error !== undefined
        ? 'error'
        : setKey(answerValues(result)) === referenceKey
          ? 'match'
          : 'differ';
    return {
      resolver: result.resolver,
      ips: ipsFor(result.resolver),
      ...(result.location ? { location: result.location } : {}),
      transport: result.transport,
      status,
      answers: result.answers,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  });
  return {
    domain: first.domain,
    type: first.type,
    ...(expected !== undefined ? { expected } : {}),
    reference,
    referenceKind: expected !== undefined ? 'expected' : 'majority',
    rows,
  };
}

export function buildReport(results: LookupResult[], expected?: string[]): CompareReport {
  const byKey = new Map<string, LookupResult[]>();
  for (const result of results) {
    const key = `${result.domain}|${result.type}`;
    const list = byKey.get(key);
    if (list) {
      list.push(result);
    } else {
      byKey.set(key, [result]);
    }
  }
  const groups = [...byKey.values()].map((list) => buildGroup(list, expected));
  return {
    domain: groups[0]?.domain ?? '',
    generatedAt: new Date().toISOString(),
    groups,
  };
}

export function summarise(rows: CompareRow[]): CompareSummary {
  const summary: CompareSummary = {
    match: 0,
    differ: 0,
    error: 0,
    total: rows.length,
    byCountry: [],
  };
  const countries = new Map<string, { match: number; total: number }>();
  for (const row of rows) {
    summary[row.status] += 1;
    if (row.location) {
      const entry = countries.get(row.location.countryCode) ?? { match: 0, total: 0 };
      entry.total += 1;
      if (row.status === 'match') {
        entry.match += 1;
      }
      countries.set(row.location.countryCode, entry);
    }
  }
  summary.byCountry = [...countries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([countryCode, value]) => ({ countryCode, ...value }));
  return summary;
}
