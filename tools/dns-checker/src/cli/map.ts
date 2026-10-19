import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { buildReport, summarise } from '../core/compare.js';
import { mapLimit, DEFAULT_CONCURRENCY } from '../core/pool.js';
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS, lookup } from '../core/resolver.js';
import type { LookupResult, RecordType, TransportPreference } from '../core/types.js';
import { generateHtml } from '../map/html.js';
import { serveHtml } from '../map/serve.js';
import { printJson } from './output.js';

export interface MapFlags {
  type?: string[];
  resolver?: string[];
  transport?: string;
  timeout?: string;
  retries?: string;
  expect?: string[];
  input?: string;
  output?: string;
  serve?: boolean;
  port?: string;
  json?: boolean;
}

export interface MapHelpers {
  parseTypes(raw: string[] | undefined): RecordType[];
  parseResolvers(raw: string[] | undefined): string[];
  parseTransport(raw: string | undefined): TransportPreference;
  parseTimeoutMs(raw: string | undefined): number;
  parseRetries(raw: string | undefined): number;
  splitList(values: string[]): string[];
}

async function readInput(path: string): Promise<LookupResult[]> {
  let text: string;
  if (path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    text = await readFile(path, 'utf8');
  }
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('input must be a non-empty JSON array from "dns-checker lookup --json"');
  }
  for (const item of data as Partial<LookupResult>[]) {
    if (
      typeof item?.domain !== 'string' ||
      typeof item.type !== 'string' ||
      typeof item.resolver !== 'string' ||
      !Array.isArray(item.answers)
    ) {
      throw new Error('input is not dns-checker lookup --json output');
    }
  }
  return data as LookupResult[];
}

function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? '8787');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port "${String(raw)}": use 0-65535`);
  }
  return port;
}

export async function mapAction(
  domain: string | undefined,
  flags: MapFlags,
  helpers: MapHelpers,
): Promise<void> {
  const port = parsePort(flags.port);
  let results: LookupResult[];
  if (flags.input !== undefined) {
    results = await readInput(flags.input);
  } else {
    if (domain === undefined) {
      throw new Error('give a domain, or --input <file> with lookup --json output');
    }
    const types = helpers.parseTypes(flags.type);
    const resolvers = helpers.parseResolvers(flags.resolver);
    const transport = helpers.parseTransport(flags.transport);
    const timeoutMs = helpers.parseTimeoutMs(flags.timeout);
    const retries = helpers.parseRetries(flags.retries);
    const pairs = types.flatMap((type) => resolvers.map((resolver) => ({ type, resolver })));
    results = await mapLimit(pairs, DEFAULT_CONCURRENCY, ({ type, resolver }) =>
      lookup(domain, type, { resolver, transport, timeoutMs, retries }),
    );
  }
  const expected = flags.expect === undefined ? undefined : helpers.splitList(flags.expect);
  const report = buildReport(results, expected);
  const html = generateHtml(report);
  const summaries = report.groups.map((group) => ({ type: group.type, ...summarise(group.rows) }));
  if (flags.serve === true) {
    const { url } = await serveHtml(html, port);
    if (flags.json) {
      printJson({ url, summaries });
    } else {
      console.log(`serving ${url} (Ctrl+C to stop)`);
    }
    await new Promise<void>((done) => {
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
    process.exit(0);
  }
  const output = resolve(flags.output ?? `dns-map-${report.domain || 'results'}.html`);
  await writeFile(output, html, 'utf8');
  if (flags.json) {
    printJson({ output, summaries });
  } else {
    console.log(`wrote ${output}`);
  }
}

export function registerMapCommand(program: Command, helpers: MapHelpers): void {
  program
    .command('map')
    .description('Render lookup results on an interactive world map (self-contained HTML)')
    .argument('[domain]', 'domain name to look up (omit with --input)')
    .option('-t, --type <types...>', 'record types, comma or space separated (default A)')
    .option(
      '-r, --resolver <names...>',
      'resolvers: system, a registry name, all, or a literal IP (default system)',
    )
    .option('--transport <mode>', 'transport: auto, udp, doh or system', 'auto')
    .option('--timeout <ms>', 'per-attempt timeout in milliseconds', String(DEFAULT_TIMEOUT_MS))
    .option('--retries <n>', 'retries per resolver on timeout, SERVFAIL or refused/reset connection (UDP)', String(DEFAULT_RETRIES))
    .option('--expect <values...>', 'expected value set; resolvers that differ are flagged')
    .option(
      '--input <file>',
      'read lookup --json output from a file, or - for stdin, instead of querying',
    )
    .option('-o, --output <file>', 'HTML file to write (default dns-map-<domain>.html)')
    .option('--serve', 'serve the page on localhost instead of writing a file', false)
    .option('--port <n>', 'port for --serve (0 picks a free port)', '8787')
    .option('--json', 'emit the output path or URL and summary as JSON', false)
    .action(async (domain, opts) => {
      await mapAction(domain as string | undefined, opts as MapFlags, helpers);
    });
}
