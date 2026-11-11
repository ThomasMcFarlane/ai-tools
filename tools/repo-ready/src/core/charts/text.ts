import { areaMarks, formatTable, verdictText } from '../format.js';
import { levelRank } from '../model.js';
import type { ChartData, ChartKind } from '../stats.js';

const BLOCKS = '▁▂▃▄▅▆▇█';
const BAR_WIDTH = 20;
const EMPTY = 'No sessions yet.';

export const CHART_TITLES: Record<ChartKind, string> = {
  levels: 'Levels',
  accuracy: 'Accuracy',
  speed: 'Answer time',
  types: 'Question types',
  timeline: 'Timeline',
};

export function bar(fraction: number, width: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function sparkline(values: (number | null)[]): string {
  const present = values.filter((v): v is number => v !== null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  return values
    .map((v) => {
      if (v === null) return ' ';
      if (max === min) return BLOCKS[7] ?? '';
      return BLOCKS[Math.ceil(((v - min) / (max - min)) * 7 - 0.5)] ?? '';
    })
    .join('');
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${two(total % 60)}s`;
  return `${Math.floor(total / 3600)}h ${two(Math.floor((total % 3600) / 60))}m`;
}

export function percent(rate: number | null): string {
  return rate === null ? 'n/a' : `${Math.round(rate * 100)}%`;
}

export function shortTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

export function shortCommit(commit: string | null): string {
  return commit === null ? 'no commit' : commit.slice(0, 7);
}

export function renderText(data: ChartData): string {
  const title = CHART_TITLES[data.kind];
  switch (data.kind) {
    case 'levels': {
      const rows = data.areas.map((a) => [
        `${a.id} (${a.title})`,
        bar(levelRank(a.level) / 3, 6),
        a.label,
        a.key ? 'key' : '',
        areaMarks(a),
      ]);
      return [
        title,
        rows.length === 0 ? 'No areas.' : formatTable(rows),
        '',
        verdictText(data.verdict),
      ].join('\n');
    }
    case 'accuracy': {
      if (data.sessions.length === 0) return `${title}\n${EMPTY}`;
      const rows = data.sessions.map((s) => [
        s.sessionId,
        s.mode,
        shortTime(s.startedAt),
        `${bar(s.passRate ?? 0, BAR_WIDTH)} ${percent(s.passRate)}`,
        `${s.passed} of ${s.counted} passed`,
      ]);
      const areas = data.byArea.map((a) => [
        `${a.areaId} (${a.title})`,
        sparkline(a.points.map((p) => p.passRate)),
        a.points.map((p) => percent(p.passRate)).join(' '),
      ]);
      return [
        title,
        `Trend ${sparkline(data.sessions.map((s) => s.passRate))}`,
        formatTable(rows),
        '',
        'By area, oldest session first',
        formatTable(areas),
      ].join('\n');
    }
    case 'speed': {
      if (data.sessions.length === 0) return `${title}\n${EMPTY}`;
      const max = Math.max(...data.sessions.map((s) => s.medianMs ?? 0));
      const rows = data.sessions.map((s) => [
        s.sessionId,
        shortTime(s.startedAt),
        `${bar(max === 0 || s.medianMs === null ? 0 : s.medianMs / max, BAR_WIDTH)} ${
          s.medianMs === null ? 'n/a' : formatDuration(s.medianMs)
        }`,
        `mean ${s.meanMs === null ? 'n/a' : formatDuration(s.meanMs)}`,
        `${s.count} answered`,
      ]);
      return [
        title,
        `Median trend ${sparkline(data.sessions.map((s) => s.medianMs))}`,
        formatTable(rows),
      ].join('\n');
    }
    case 'types': {
      const rows = data.types.map((t) => [
        `${t.qtype} (${t.level})`,
        t.counted === 0 ? 'not asked' : `${bar(t.passRate ?? 0, BAR_WIDTH)} ${percent(t.passRate)}`,
        `${t.passed} of ${t.counted} passed`,
        `median ${t.medianMs === null ? 'n/a' : formatDuration(t.medianMs)}`,
      ]);
      return [title, formatTable(rows)].join('\n');
    }
    case 'timeline': {
      if (data.sessions.length === 0 && data.maps.length === 0) return `${title}\n${EMPTY}`;
      const lines = [title];
      if (data.sessions.length === 0) lines.push(EMPTY);
      else {
        lines.push(
          formatTable(
            data.sessions.map((s) => [
              s.sessionId,
              s.mode,
              shortTime(s.startedAt),
              s.endedAt === null ? 'still open' : `ended ${shortTime(s.endedAt)}`,
              `${s.branch ?? 'no branch'} @ ${shortCommit(s.commit)}${s.dirty ? ' (uncommitted changes)' : ''}`,
              `${s.passed} of ${s.asked} passed`,
            ]),
          ),
        );
      }
      for (const m of data.maps) {
        lines.push(
          `${shortTime(m.at)}  map set at ${shortCommit(m.commit)}${
            m.raised.length === 0 ? '' : `, raised ${m.raised.join(', ')}`
          }`,
        );
      }
      return lines.join('\n');
    }
  }
}
