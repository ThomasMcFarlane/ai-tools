import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listGlobalResolverNames,
  listWorldResolverNames,
  resolveServer,
  type LookupResult,
  type RecordType,
} from '../src/index.js';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock('../src/core/resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/resolver.js')>();
  return { ...actual, lookup: lookupMock };
});

const { run } = await import('../src/cli/index.js');

function fakeLookup(
  domain: string,
  type: RecordType,
  opts: { resolver?: string } = {},
): LookupResult {
  const server = resolveServer(opts.resolver ?? 'system');
  const result: LookupResult = {
    domain,
    type,
    resolver: server.name,
    transport: 'udp',
    answers: [{ value: '192.0.2.1', ttl: 60 }],
    checkedAt: '2026-01-01T00:00:00.000Z',
  };
  if (server.location !== undefined) {
    result.location = server.location;
  }
  return result;
}

let stateRoot: string;
let previousStateDir: string | undefined;
let previousExitCode: string | number | undefined;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dns-checker-world-'));
  previousStateDir = process.env['AI_TOOLS_DNS_STATE_DIR'];
  process.env['AI_TOOLS_DNS_STATE_DIR'] = stateRoot;
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  lookupMock.mockReset();
  lookupMock.mockImplementation(
    async (domain: string, type: RecordType, opts: { resolver?: string }) =>
      fakeLookup(domain, type, opts),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousStateDir === undefined) {
    delete process.env['AI_TOOLS_DNS_STATE_DIR'];
  } else {
    process.env['AI_TOOLS_DNS_STATE_DIR'] = previousStateDir;
  }
  process.exitCode = previousExitCode;
  await rm(stateRoot, { recursive: true, force: true });
});

function resolversQueried(): string[] {
  return lookupMock.mock.calls.map((call) => (call[2] as { resolver: string }).resolver);
}

describe('lookup -r world', () => {
  it('queries every location-tagged resolver and nothing else', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(['node', 'dns-checker', 'lookup', 'example.com', '-r', 'world', '--json']);
    expect(resolversQueried()).toEqual(listWorldResolverNames());
  });

  it('keeps all meaning the global presets only', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(['node', 'dns-checker', 'lookup', 'example.com', '-r', 'all', '--json']);
    expect(resolversQueried()).toEqual(listGlobalResolverNames());
  });

  it('combines world with other resolvers', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(['node', 'dns-checker', 'lookup', 'example.com', '-r', 'world,cloudflare', '--json']);
    expect(resolversQueried()).toEqual([...listWorldResolverNames(), 'cloudflare']);
  });

  it('puts location on every world result in JSON and omits it for anycast presets', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(['node', 'dns-checker', 'lookup', 'example.com', '-r', 'world,cloudflare', '--json']);
    const output = JSON.parse(log.mock.calls[0]?.[0] as string) as Record<string, unknown>[];
    const world = output.filter((entry) => entry['resolver'] !== 'cloudflare');
    expect(world).toHaveLength(listWorldResolverNames().length);
    for (const entry of world) {
      expect(entry['location']).toEqual(
        expect.objectContaining({
          city: expect.any(String),
          country: expect.any(String),
          countryCode: expect.stringMatching(/^[A-Z]{2}$/),
          lat: expect.any(Number),
          lon: expect.any(Number),
        }),
      );
    }
    const cloudflare = output.find((entry) => entry['resolver'] === 'cloudflare');
    expect(cloudflare).not.toHaveProperty('location');
  });

  it('shows city and country code once in the comparison table', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(['node', 'dns-checker', 'lookup', 'example.com', '-r', 'nic-cz,cloudflare']);
    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output.match(/Prague, CZ/g)).toHaveLength(1);
    expect(output).not.toMatch(/cloudflare \(/);
  });

  it('rejects world for single-resolver commands', async () => {
    await expect(
      run(['node', 'dns-checker', 'check', 'example.com', '-r', 'world', '--absent']),
    ).rejects.toThrow(/unknown resolver "world"/);
  });
});

describe('check and wait JSON location', () => {
  it('carries location in check --json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run([
      'node',
      'dns-checker',
      'check',
      'example.com',
      '-r',
      'nic-cz',
      '--expect',
      '192.0.2.1',
      '--json',
    ]);
    const output = JSON.parse(log.mock.calls[0]?.[0] as string) as {
      matched: boolean;
      location?: { city: string };
    };
    expect(output.matched).toBe(true);
    expect(output.location?.city).toBe('Prague');
  });

  it('carries location in wait --json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run([
      'node',
      'dns-checker',
      'wait',
      'example.com',
      '-r',
      'nic-cz',
      '--expect',
      '192.0.2.1',
      '--json',
    ]);
    const output = JSON.parse(log.mock.calls[0]?.[0] as string) as {
      matched: boolean;
      location?: { countryCode: string };
    };
    expect(output.matched).toBe(true);
    expect(output.location?.countryCode).toBe('CZ');
  });

  it('omits location for a literal IP', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run([
      'node',
      'dns-checker',
      'check',
      'example.com',
      '-r',
      '192.0.2.53',
      '--expect',
      '192.0.2.1',
      '--json',
    ]);
    const output = JSON.parse(log.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(output).not.toHaveProperty('location');
  });
});
