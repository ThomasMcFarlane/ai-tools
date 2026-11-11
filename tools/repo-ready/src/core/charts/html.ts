import { areaMarks } from '../../cli/output.js';
import type { ChartData } from '../stats.js';
import { CHART_TITLES, formatDuration, percent, shortCommit, shortTime } from './text.js';

const STYLE = `:root{--bg:#ffffff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--track:#e6eaee;--bar:#1f6feb;--bar-flag:#9a6700}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--track:#21262d;--bar:#58a6ff;--bar-flag:#d29922}}
body{margin:0 auto;max-width:56rem;padding:1.5rem;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
h1{font-size:1.5rem}h2{font-size:1.2rem;margin-top:2rem}
section{border-top:1px solid var(--line)}
svg{width:100%;height:auto;display:block}
svg text{fill:var(--fg);font:12px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.track{fill:var(--track)}.bar{fill:var(--bar)}.flag{fill:var(--bar-flag)}
table{border-collapse:collapse;width:100%;margin:.5rem 0}
th,td{border:1px solid var(--line);padding:.25rem .5rem;text-align:left;vertical-align:top}
th{font-weight:600}
.muted{color:var(--muted)}`;

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

interface BarRow {
  label: string;
  fraction: number;
  value: string;
  flagged?: boolean;
}

const LABEL_WIDTH = 260;
const TRACK_WIDTH = 300;
const ROW_HEIGHT = 26;

function barsSvg(label: string, rows: BarRow[]): string {
  const height = Math.max(rows.length, 1) * ROW_HEIGHT;
  const body = rows
    .map((r, i) => {
      const y = i * ROW_HEIGHT;
      const width = Math.round(Math.min(1, Math.max(0, r.fraction)) * TRACK_WIDTH);
      return [
        `<text x="0" y="${y + 17}">${escapeHtml(r.label)}</text>`,
        `<rect class="track" x="${LABEL_WIDTH}" y="${y + 4}" width="${TRACK_WIDTH}" height="16"></rect>`,
        `<rect class="${r.flagged === true ? 'flag' : 'bar'}" x="${LABEL_WIDTH}" y="${y + 4}" width="${width}" height="16"></rect>`,
        `<text x="${LABEL_WIDTH + TRACK_WIDTH + 8}" y="${y + 17}">${escapeHtml(r.value)}</text>`,
      ].join('');
    })
    .join('');
  return `<svg role="img" aria-label="${escapeHtml(label)}" viewBox="0 0 ${LABEL_WIDTH + TRACK_WIDTH + 200} ${height}"><title>${escapeHtml(label)}</title>${body}</svg>`;
}

function table(head: string[], rows: string[][]): string {
  const cells = (tag: string, row: string[]): string =>
    `<tr>${row.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join('')}</tr>`;
  return `<table><thead>${cells('th', head)}</thead><tbody>${rows.map((r) => cells('td', r)).join('')}</tbody></table>`;
}

const RANK = { none: 0, read: 1, maintain: 2, rebuild: 3 } as const;
const NO_SESSIONS = '<p>No sessions yet.</p>';

function chartBody(data: ChartData): string {
  const label = `${CHART_TITLES[data.kind]} chart`;
  switch (data.kind) {
    case 'levels': {
      const marks = (a: (typeof data.areas)[number]): string => areaMarks(a);
      const rows = data.areas.map((a) => ({
        label: `${a.id} (${a.title})`,
        fraction: RANK[a.level] / 3,
        value: [a.label, marks(a)].filter((v) => v.length > 0).join(', '),
        flagged: a.stale || a.untested,
      }));
      const verdict = [
        `Verdict: ${data.verdict.label}`,
        ...(data.verdict.untestedKeyAreas.length > 0
          ? [`Untested key areas: ${data.verdict.untestedKeyAreas.join(', ')}`]
          : []),
        ...(data.verdict.holdingBack.length > 0
          ? [`Holding back: ${data.verdict.holdingBack.join(', ')}`]
          : []),
      ];
      return [
        data.areas.length === 0 ? '<p>No areas.</p>' : barsSvg(label, rows),
        table(
          ['Area', 'Title', 'Level', 'Key', 'Notes', 'Last tested'],
          data.areas.map((a) => [
            a.id,
            a.title,
            a.label,
            a.key ? 'key' : '',
            marks(a),
            a.lastTestedAt ?? 'never',
          ]),
        ),
        `<ul>${verdict.map((v) => `<li>${escapeHtml(v)}</li>`).join('')}</ul>`,
      ].join('');
    }
    case 'accuracy': {
      if (data.sessions.length === 0) return NO_SESSIONS;
      return [
        barsSvg(
          label,
          data.sessions.map((s) => ({
            label: `${s.sessionId} (${s.mode})`,
            fraction: s.passRate ?? 0,
            value: `${percent(s.passRate)} (${s.passed} of ${s.counted})`,
          })),
        ),
        table(
          ['Session', 'Mode', 'Started', 'Counted', 'Passed', 'Pass rate'],
          data.sessions.map((s) => [
            s.sessionId,
            s.mode,
            shortTime(s.startedAt),
            String(s.counted),
            String(s.passed),
            percent(s.passRate),
          ]),
        ),
        table(
          ['Area', ...data.sessions.map((s) => s.sessionId)],
          data.byArea.map((a) => [
            `${a.areaId} (${a.title})`,
            ...a.points.map((p) => percent(p.passRate)),
          ]),
        ),
      ].join('');
    }
    case 'speed': {
      if (data.sessions.length === 0) return NO_SESSIONS;
      const max = Math.max(...data.sessions.map((s) => s.medianMs ?? 0));
      const time = (ms: number | null): string => (ms === null ? 'n/a' : formatDuration(ms));
      return [
        barsSvg(
          label,
          data.sessions.map((s) => ({
            label: s.sessionId,
            fraction: max === 0 || s.medianMs === null ? 0 : s.medianMs / max,
            value: `median ${time(s.medianMs)}`,
          })),
        ),
        table(
          ['Session', 'Started', 'Answered', 'Median', 'Mean'],
          data.sessions.map((s) => [
            s.sessionId,
            shortTime(s.startedAt),
            String(s.count),
            time(s.medianMs),
            time(s.meanMs),
          ]),
        ),
      ].join('');
    }
    case 'types':
      return [
        barsSvg(
          label,
          data.types.map((t) => ({
            label: `${t.qtype} (${t.level})`,
            fraction: t.passRate ?? 0,
            value:
              t.counted === 0
                ? 'not asked'
                : `${percent(t.passRate)} (${t.passed} of ${t.counted})`,
            flagged: t.counted === 0,
          })),
        ),
        table(
          ['Type', 'Level', 'Counted', 'Passed', 'Pass rate', 'Median time'],
          data.types.map((t) => [
            t.qtype,
            t.level,
            String(t.counted),
            String(t.passed),
            t.counted === 0 ? 'not asked' : percent(t.passRate),
            t.medianMs === null ? 'n/a' : formatDuration(t.medianMs),
          ]),
        ),
      ].join('');
    case 'timeline': {
      if (data.sessions.length === 0 && data.maps.length === 0) return NO_SESSIONS;
      const max = Math.max(1, ...data.sessions.map((s) => s.asked));
      return [
        data.sessions.length === 0
          ? NO_SESSIONS
          : barsSvg(
              label,
              data.sessions.map((s) => ({
                label: `${s.sessionId} (${s.mode})`,
                fraction: s.asked / max,
                value: `${s.passed} of ${s.asked} passed`,
              })),
            ),
        table(
          [
            'Session',
            'Mode',
            'Started',
            'Ended',
            'Branch',
            'Commit',
            'Uncommitted changes',
            'Asked',
            'Passed',
          ],
          data.sessions.map((s) => [
            s.sessionId,
            s.mode,
            shortTime(s.startedAt),
            s.endedAt === null ? 'still open' : shortTime(s.endedAt),
            s.branch ?? 'no branch',
            shortCommit(s.commit),
            s.dirty ? 'yes' : 'no',
            String(s.asked),
            String(s.passed),
          ]),
        ),
        table(
          ['Map set', 'Commit', 'Raised'],
          data.maps.map((m) => [
            shortTime(m.at),
            shortCommit(m.commit),
            m.raised.length === 0 ? 'none' : m.raised.join(', '),
          ]),
        ),
      ].join('');
    }
  }
}

export function renderHtml(charts: ChartData[], title: string): string {
  const sections = charts
    .map((c) => `<section><h2>${escapeHtml(CHART_TITLES[c.kind])}</h2>${chartBody(c)}</section>`)
    .join('\n');
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${sections}
</body>
</html>
`;
}
