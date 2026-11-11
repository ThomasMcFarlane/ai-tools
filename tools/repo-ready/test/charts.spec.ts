import { describe, expect, it } from 'vitest';
import { renderHtml, escapeHtml } from '../src/core/charts/html.js';
import { bar, formatDuration, renderText, sparkline } from '../src/core/charts/text.js';
import { buildModel } from '../src/core/model.js';
import { chartData, type ChartData } from '../src/core/stats.js';
import { CHART_KINDS } from '../src/core/stats.js';
import type { LogEvent, MapInput } from '../src/core/types.js';
import { holdLevel, LogBuilder, sampleMap } from './helpers.js';

function allCharts(map: MapInput, events: LogEvent[] = []): ChartData[] {
  const model = buildModel(map, events);
  return CHART_KINDS.map((kind) => chartData(kind, map, model, events));
}

function mapWithTitle(title: string): MapInput {
  const base = sampleMap();
  return { areas: base.areas.map((a, i) => (i === 0 ? { ...a, title } : a)) };
}

function twoSessions(): LogBuilder {
  const log = new LogBuilder().session();
  log.q('a', 'read', 4, { durationMs: 40_000 });
  log.q('a', 'read', 1, { qtype: 'trace', durationMs: 60_000 });
  log.q('b', 'read', 'skip');
  log.endSession();
  log.raise('a');
  log.session('interview');
  log.q('a', 'read', 4, { durationMs: 20_000 });
  log.q('a', 'read', 4, { qtype: 'trace', durationMs: 30_000 });
  log.q('b', 'maintain', 1, { qtype: 'predict', durationMs: 50_000 });
  log.q('a', 'read', 'open');
  return log;
}

describe('text helpers', () => {
  it('bar fills in proportion', () => {
    expect(bar(0.5, 10)).toBe('█████░░░░░');
    expect(bar(0, 4)).toBe('░░░░');
    expect(bar(1.2, 4)).toBe('████');
  });

  it('sparkline scales to its range and shows a gap for null', () => {
    expect(sparkline([0, 0.5, 1])).toBe('▁▄█');
    expect(sparkline([1, null, 1])).toBe('█ █');
    expect(sparkline([])).toBe('');
  });

  it('formatDuration', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });
});

describe('chartData', () => {
  it('levels text names every area, level label and mark', () => {
    const log = new LogBuilder().session();
    holdLevel(log, 'a', 'maintain');
    holdLevel(log, 'b', 'read');
    log.raise('a');
    const map = sampleMap();
    const model = buildModel(map, log.events);
    const text = renderText(chartData('levels', map, model, log.events));
    for (const title of ['Area a', 'Area b', 'Area c']) expect(text).toContain(title);
    expect(text).toContain('Ready to be interviewed on it');
    expect(text).toContain('stale (was maintain: Ready to work on it)');
    expect(text).toContain('untested');
    expect(text).toContain(`Verdict: ${model.verdict.label}`);
  });

  it('accuracy, speed, types and timeline data match a two-session log', () => {
    const log = twoSessions();
    const map = sampleMap();
    const model = buildModel(map, log.events);
    const data = (kind: (typeof CHART_KINDS)[number]) => chartData(kind, map, model, log.events);

    const accuracy = data('accuracy');
    if (accuracy.kind !== 'accuracy') throw new Error('kind');
    expect(
      accuracy.sessions.map((s) => [s.sessionId, s.mode, s.counted, s.passed, s.passRate]),
    ).toEqual([
      ['s1', 'learn', 3, 1, 1 / 3],
      ['s2', 'interview', 3, 2, 2 / 3],
    ]);
    expect(accuracy.byArea.map((a) => [a.areaId, a.points.map((p) => p.passRate)])).toEqual([
      ['a', [0.5, 1]],
      ['b', [0, 0]],
      ['c', [null, null]],
    ]);

    const speed = data('speed');
    if (speed.kind !== 'speed') throw new Error('kind');
    expect(speed.sessions.map((s) => [s.sessionId, s.count, s.medianMs, s.meanMs])).toEqual([
      ['s1', 2, 50_000, 50_000],
      ['s2', 3, 30_000, 33_333],
    ]);

    const types = data('types');
    if (types.kind !== 'types') throw new Error('kind');
    expect(
      types.types.map((t) => [t.qtype, t.level, t.counted, t.passed, t.passRate, t.medianMs]),
    ).toEqual([
      ['explain', 'read', 2, 1, 0.5, 20_000],
      ['trace', 'read', 1, 1, 1, 30_000],
      ['predict', 'maintain', 1, 0, 0, 50_000],
      ['debug', 'maintain', 0, 0, null, null],
      ['change', 'maintain', 0, 0, null, null],
      ['rebuild', 'rebuild', 0, 0, null, null],
    ]);

    const timeline = data('timeline');
    if (timeline.kind !== 'timeline') throw new Error('kind');
    expect(
      timeline.sessions.map((s) => [
        s.sessionId,
        s.mode,
        s.branch,
        s.commit,
        s.dirty,
        s.asked,
        s.passed,
      ]),
    ).toEqual([
      ['s1', 'learn', 'main', 'c1', false, 3, 1],
      ['s2', 'interview', 'main', 'c1', false, 4, 2],
    ]);
    expect(timeline.sessions[0]?.endedAt).not.toBeNull();
    expect(timeline.sessions[1]?.endedAt).toBeNull();
    expect(timeline.maps).toHaveLength(1);
    expect(timeline.maps[0]).toMatchObject({ commit: 'c1', raised: ['a'] });
  });

  it('levels data covers non-retired areas with their summary', () => {
    const log = new LogBuilder().session();
    log.q('gone', 'read', 4);
    const map = sampleMap();
    const data = chartData('levels', map, buildModel(map, log.events), log.events);
    if (data.kind !== 'levels') throw new Error('kind');
    expect(data.areas.map((a) => [a.id, a.summary])).toEqual([
      ['a', 'What area a does.'],
      ['b', 'What area b does.'],
      ['c', 'What area c does.'],
    ]);
  });
});

describe('renderers', () => {
  it('every kind renders text for an empty history without throwing', () => {
    const charts = allCharts(sampleMap());
    expect(charts).toHaveLength(5);
    const texts = charts.map((c) => renderText(c));
    expect(texts[1]).toContain('No sessions yet.');
    expect(texts[2]).toContain('No sessions yet.');
    expect(texts[4]).toContain('No sessions yet.');
    expect(texts[3]).toContain('explain');
    for (const t of texts) expect(t.length).toBeGreaterThan(0);
    expect(renderHtml(charts, 'octo-org/hello-world')).toContain('No sessions yet.');
  });

  it('text charts show times, percentages and bars for a history', () => {
    const log = twoSessions();
    const text = allCharts(sampleMap(), log.events).map((c) => renderText(c));
    expect(text[1]).toContain('67%');
    expect(text[1]).toContain('33%');
    expect(text[2]).toContain('50s');
    expect(text[2]).toContain('30s');
    expect(text[3]).toContain('not asked');
    expect(text[3]).toContain('50%');
    expect(text[4]).toContain('raised a');
  });

  it('html is self-contained and escapes text', () => {
    const html = renderHtml(
      allCharts(mapWithTitle('<script>alert(1)</script>')),
      'octo-org/hello-world',
    );
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<svg');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label=');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<script|src=|href=|@import|url\(|https?:/i);
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html.match(/<section/g)).toHaveLength(5);
  });

  it('html writes stale and untested as words and tables hold the numbers', () => {
    const log = new LogBuilder().session();
    holdLevel(log, 'a', 'maintain');
    log.raise('a');
    const html = renderHtml(allCharts(sampleMap(), log.events), 'octo-org/hello-world');
    expect(html).toContain('stale (was maintain: Ready to work on it)');
    expect(html).toContain('untested');
    expect(html).toContain('<table');
  });

  it('html table shows the numbers of a history', () => {
    const html = renderHtml(allCharts(sampleMap(), twoSessions().events), 'octo-org/hello-world');
    for (const n of ['67%', '33%', '50s', '33s', '30s']) expect(html).toContain(n);
  });

  it('escapeHtml escapes the five characters', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;',
    );
  });
});
