import { areaMarks, formatTable, verdictText } from '../core/format.js';

export { formatTable, verdictText };
import type { SessionSummary } from '../core/stats.js';
import { LEVEL_LABELS, type AreaState } from '../core/types.js';

export function printJson(print: (text: string) => void, data: unknown): void {
  print(JSON.stringify(data, null, 2));
}

export function areasText(areas: AreaState[], opts: { lastTested?: boolean } = {}): string {
  if (areas.length === 0) return 'No areas.';
  const lastTested = opts.lastTested === true;
  return formatTable([
    ['AREA', 'LEVEL', 'KEY', 'NOTES', ...(lastTested ? ['LAST TESTED'] : [])],
    ...areas.map((a) => [
      a.id,
      a.label,
      a.key ? 'key' : '',
      areaMarks(a),
      ...(lastTested ? [a.lastTestedAt ?? 'never'] : []),
    ]),
  ]);
}

export function summaryText(summary: SessionSummary): string {
  const rate = summary.passRate === null ? 'n/a' : `${Math.round(summary.passRate * 100)}%`;
  const median = summary.medianMs === null ? 'n/a' : `${Math.round(summary.medianMs / 1000)}s`;
  const lines = [
    `Session ${summary.sessionId} (${summary.mode})`,
    formatTable([
      ['Started', summary.startedAt],
      ['Ended', summary.endedAt ?? 'still open'],
      ['Asked', String(summary.asked)],
      ['Graded', String(summary.graded)],
      ['Passed', `${summary.passed} (${rate})`],
      ['Skipped', String(summary.skips)],
      ['Hints', String(summary.hints)],
      ['Median time', median],
    ]),
  ];
  for (const e of summary.byArea) {
    lines.push(
      `  ${e.areaId} at ${e.level} (${LEVEL_LABELS[e.level]}): ${e.passed} of ${e.asked} passed`,
    );
  }
  return lines.join('\n');
}
