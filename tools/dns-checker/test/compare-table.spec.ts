import { describe, expect, it } from 'vitest';
import { buildGroup, buildReport, summarise } from '../src/core/compare.js';
import { createPainter, colourEnabled, formatComparison } from '../src/cli/output.js';
import { LOCATED_RESULTS } from './fixtures/located-results.js';

const plain = createPainter(false);
const ESC = String.fromCharCode(27);

describe('buildGroup', () => {
  it('compares against the majority answer set without --expect', () => {
    const group = buildGroup(LOCATED_RESULTS);
    expect(group.referenceKind).toBe('majority');
    expect(group.reference).toEqual(['203.0.113.10']);
    expect(group.rows.map((row) => row.status)).toEqual([
      'match',
      'match',
      'differ',
      'error',
      'match',
    ]);
  });

  it('compares against the expected set when given', () => {
    const group = buildGroup(LOCATED_RESULTS, ['198.51.100.7']);
    expect(group.rows.map((row) => row.status)).toEqual([
      'differ',
      'differ',
      'match',
      'error',
      'differ',
    ]);
  });

  it('is order insensitive', () => {
    const [first] = LOCATED_RESULTS;
    const group = buildGroup(
      [
        {
          ...first!,
          answers: [
            { value: 'b', ttl: 1 },
            { value: 'a', ttl: 1 },
          ],
        },
      ],
      ['a', 'b'],
    );
    expect(group.rows[0]?.status).toBe('match');
  });
});

describe('summarise', () => {
  it('counts statuses and per-country matches', () => {
    const summary = summarise(buildGroup(LOCATED_RESULTS).rows);
    expect(summary).toMatchObject({ match: 3, differ: 1, error: 1, total: 5 });
    expect(summary.byCountry).toEqual([
      { countryCode: 'DE', match: 0, total: 1 },
      { countryCode: 'JP', match: 0, total: 1 },
      { countryCode: 'US', match: 2, total: 2 },
    ]);
  });
});

describe('formatComparison', () => {
  it('renders grouped plain output with summary', () => {
    const text = formatComparison(buildGroup(LOCATED_RESULTS, ['203.0.113.10']), plain);
    expect(text).not.toContain(ESC);
    expect(text).toContain('example.com A  expected 203.0.113.10');
    expect(text).toContain('-- DE Germany');
    expect(text).toContain('-- US United States');
    expect(text).toContain('-- Anycast / unlocated');
    expect(text).toMatch(/9\.9\.9\.9 \(Berlin, DE\)\s+198\.51\.100\.7\s+differ\s+300/);
    expect(text).toMatch(/77\.88\.8\.8 \(Tokyo, JP\)\s+timed out after 5000ms\s+error\s+-/);
    expect(text).toContain(
      'summary: 3 match, 1 differ, 1 error  by country: DE 0/1, JP 0/1, US 2/2',
    );
    expect(text.indexOf('-- DE')).toBeLessThan(text.indexOf('-- US'));
    expect(text.indexOf('-- US')).toBeLessThan(text.indexOf('-- Anycast'));
  });

  it('omits grouping and country summary when nothing is located', () => {
    const text = formatComparison(buildGroup([LOCATED_RESULTS[4]!]), plain);
    expect(text).not.toContain('--');
    expect(text).not.toContain('by country');
    expect(text).toContain('majority 203.0.113.10');
  });

  it('colours statuses distinctly when enabled', () => {
    const text = formatComparison(
      buildGroup(LOCATED_RESULTS, ['203.0.113.10']),
      createPainter(true),
    );
    expect(text).toContain(`${ESC}[32mmatch${ESC}[39m`);
    expect(text).toContain(`${ESC}[31mdiffer${ESC}[39m`);
    expect(text).toContain(`${ESC}[35merror${ESC}[39m`);
  });

  it('keeps columns aligned when colour is on', () => {
    const strip = (value: string): string =>
      value
        .split(ESC)
        .map((part, i) => (i === 0 ? part : part.replace(/^\[\d+m/, '')))
        .join('');
    const group = buildGroup(LOCATED_RESULTS, ['203.0.113.10']);
    expect(strip(formatComparison(group, createPainter(true)))).toBe(
      formatComparison(group, plain),
    );
  });
});

describe('colourEnabled', () => {
  it('respects NO_COLOR and non-TTY output', () => {
    expect(colourEnabled({ NO_COLOR: '1' }, true)).toBe(false);
    expect(colourEnabled({}, false)).toBe(false);
    expect(colourEnabled({ TERM: 'dumb' }, true)).toBe(false);
    expect(colourEnabled({}, true)).toBe(true);
    expect(colourEnabled({ FORCE_COLOR: '1' }, false)).toBe(true);
    expect(colourEnabled({ FORCE_COLOR: '1', NO_COLOR: '1' }, true)).toBe(false);
  });
});

describe('buildReport', () => {
  it('groups results by domain and type', () => {
    const report = buildReport([...LOCATED_RESULTS, { ...LOCATED_RESULTS[0]!, type: 'AAAA' }]);
    expect(report.groups.map((group) => group.type)).toEqual(['A', 'AAAA']);
  });
});
