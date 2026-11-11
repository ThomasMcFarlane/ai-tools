import { LEVEL_LABELS, type AreaState, type Verdict } from './types.js';

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
