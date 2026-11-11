import type { SessionSummary } from '../core/stats.js';
import { LEVEL_LABELS, type AreaState, type Verdict } from '../core/types.js';

export function formatTable(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export function printJson(print: (text: string) => void, data: unknown): void {
  print(JSON.stringify(data, null, 2));
}

export function areaMarks(a: AreaState): string {
  return [
    a.retired ? 'retired' : '',
    a.stale
      ? `stale${a.staleFrom === null ? '' : ` (was ${a.staleFrom}: ${LEVEL_LABELS[a.staleFrom]})`}`
      : '',
    a.untested ? 'untested' : '',
  ]
    .filter((n) => n.length > 0)
    .join(', ');
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

export function verdictText(verdict: Verdict): string {
  const lines = [`Verdict: ${verdict.label}`];
  if (verdict.untestedKeyAreas.length > 0) {
    lines.push(`Untested key areas: ${verdict.untestedKeyAreas.join(', ')}`);
  }
  if (verdict.holdingBack.length > 0) lines.push(`Holding back: ${verdict.holdingBack.join(', ')}`);
  if (verdict.weakestTypes.length > 0) {
    lines.push(`Weakest question types: ${verdict.weakestTypes.join(', ')}`);
  }
  for (const gap of verdict.recurringGaps) lines.push(`Recurring gap: ${gap}`);
  return lines.join('\n');
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
