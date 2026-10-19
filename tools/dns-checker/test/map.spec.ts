import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli/index.js';
import { buildReport } from '../src/core/compare.js';
import { generateHtml } from '../src/map/html.js';
import { serveHtml } from '../src/map/serve.js';
import { LOCATED_RESULTS } from './fixtures/located-results.js';

describe('generateHtml', () => {
  const html = generateHtml(buildReport(LOCATED_RESULTS, ['203.0.113.10']));

  it('embeds the report data', () => {
    expect(html).toContain('198.51.100.7');
    expect(html).toContain('Berlin');
    expect(html).toContain('"referenceKind":"expected"');
    expect(html).toContain('id="markers"');
    expect(html).toContain('Anycast / no location');
  });

  it('is self-contained with no external URLs or resources', () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=/i);
    expect(html).not.toMatch(/@import|url\(/);
  });

  it('escapes markup in embedded data', () => {
    const evil = generateHtml(
      buildReport([{ ...LOCATED_RESULTS[0]!, answers: [{ value: '</script><b>x', ttl: 1 }] }]),
    );
    expect(evil).not.toContain('</script><b>');
    expect(evil).toContain('\\u003c/script\\u003e');
  });
});

describe('serveHtml', () => {
  it('serves the page on localhost only', async () => {
    const { server, url } = await serveHtml('<p>hi</p>', 0);
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const response = await fetch(url);
      expect(await response.text()).toBe('<p>hi</p>');
      expect((await fetch(`${url}nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('run map', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dns-checker-map-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes an HTML file from lookup --json input', async () => {
    const input = join(dir, 'in.json');
    const output = join(dir, 'out.html');
    await writeFile(input, JSON.stringify(LOCATED_RESULTS));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run([
      'node',
      'dns-checker',
      'map',
      '--input',
      input,
      '-o',
      output,
      '--expect',
      '203.0.113.10',
      '--json',
    ]);
    const written = await readFile(output, 'utf8');
    expect(written).toContain('Tokyo');
    const printed = JSON.parse(log.mock.calls[0]?.[0] as string) as {
      output: string;
      summaries: { match: number }[];
    };
    expect(printed.output).toBe(output);
    expect(printed.summaries[0]?.match).toBe(3);
  });

  it('rejects input that is not lookup output', async () => {
    const input = join(dir, 'bad.json');
    await writeFile(input, '[{"x":1}]');
    await expect(run(['node', 'dns-checker', 'map', '--input', input])).rejects.toThrow(
      /not dns-checker/,
    );
  });
});
