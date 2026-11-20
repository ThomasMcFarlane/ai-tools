import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { SearchHit } from '../types.js';
import {
  mergeEvents,
  siteFailed,
  siteSucceeded,
  type PreviousState,
  type SiteOutcome,
  type WatchEvent,
} from './diff.js';

export const MAX_HISTORY_BYTES = 8 * 1024 * 1024;

export interface HistoryLine {
  v: 1;
  ts: string;
  watchId: string;
  hits: SearchHit[];
  sites: Record<string, SiteOutcome>;
  errors: Array<{ site: string; message: string }>;
  events: WatchEvent[];
  notified: boolean;
}

function isHistoryLine(value: unknown): value is HistoryLine {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Record<string, unknown>;
  return (
    line.v === 1 &&
    typeof line.ts === 'string' &&
    typeof line.watchId === 'string' &&
    Array.isArray(line.hits) &&
    typeof line.sites === 'object' &&
    line.sites !== null &&
    Array.isArray(line.events)
  );
}

export function parseHistory(text: string): HistoryLine[] {
  const lines: HistoryLine[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isHistoryLine(parsed)) {
        const notified = (parsed as { notified?: unknown }).notified;
        lines.push({ ...parsed, notified: typeof notified === 'boolean' ? notified : true });
      }
    } catch {
      continue;
    }
  }
  return lines;
}

export function readHistory(file: string, limit?: number): HistoryLine[] {
  if (!existsSync(file)) return [];
  const lines = parseHistory(readFileSync(file, 'utf8'));
  if (limit === undefined) return lines;
  return limit <= 0 ? [] : lines.slice(-limit);
}

export function appendHistory(file: string, line: HistoryLine, maxBytes = MAX_HISTORY_BYTES): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  if (statSync(file).size <= maxBytes) return;
  const lines = parseHistory(readFileSync(file, 'utf8'));
  const kept = lines.slice(Math.ceil(lines.length / 2));
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  renameSync(temp, file);
}

export function lastSuccessfulHits(lines: HistoryLine[]): Record<string, SearchHit[]> {
  const bySite: Record<string, SearchHit[]> = {};
  for (const line of lines) {
    for (const [site, outcome] of Object.entries(line.sites)) {
      if (!siteSucceeded(outcome.status)) continue;
      bySite[site] = line.hits.filter((hit) => hit.site === site);
    }
  }
  return bySite;
}

export function consecutiveFailures(lines: HistoryLine[]): Record<string, number> {
  const failures: Record<string, number> = {};
  for (const line of lines) {
    for (const [site, outcome] of Object.entries(line.sites)) {
      if (siteFailed(outcome.status)) failures[site] = (failures[site] ?? 0) + 1;
      else if (siteSucceeded(outcome.status)) failures[site] = 0;
    }
  }
  return failures;
}

export function previousState(lines: HistoryLine[]): PreviousState {
  return {
    hasHistory: lines.length > 0,
    bySite: lastSuccessfulHits(lines),
    failures: consecutiveFailures(lines),
  };
}

export function pendingEvents(lines: HistoryLine[]): WatchEvent[] {
  let start = lines.length;
  while (start > 0 && lines[start - 1]?.notified === false) start -= 1;
  return mergeEvents(
    [],
    lines.slice(start).flatMap((line) => line.events),
  );
}
