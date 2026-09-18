import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli/index.js';

let stateRoot: string;
let previousStateDir: string | undefined;
let previousExitCode: string | number | undefined;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dns-checker-cli-'));
  previousStateDir = process.env['AI_TOOLS_DNS_STATE_DIR'];
  process.env['AI_TOOLS_DNS_STATE_DIR'] = stateRoot;
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env['AI_TOOLS_DNS_STATE_DIR'];
  } else {
    process.env['AI_TOOLS_DNS_STATE_DIR'] = previousStateDir;
  }
  process.exitCode = previousExitCode;
  await rm(stateRoot, { recursive: true, force: true });
});

describe('run lookup', () => {
  it('rejects unsupported record types before touching the network', async () => {
    await expect(
      run(['node', 'dns-checker', 'lookup', 'example.com', '--type', 'BOGUS']),
    ).rejects.toThrow(/unsupported record type "BOGUS"/);
  });

  it('rejects unsupported record types in comma lists before touching the network', async () => {
    await expect(
      run(['node', 'dns-checker', 'lookup', 'example.com', '--type', 'A,BOGUS']),
    ).rejects.toThrow(/unsupported record type "BOGUS"/);
  });

  it('rejects unknown resolver names before touching the network', async () => {
    await expect(
      run(['node', 'dns-checker', 'lookup', 'example.com', '--resolver', 'nope']),
    ).rejects.toThrow(/unknown resolver "nope"/);
  });

  it('rejects invalid transport values before touching the network', async () => {
    await expect(
      run(['node', 'dns-checker', 'lookup', 'example.com', '--transport', 'carrier-pigeon']),
    ).rejects.toThrow(/invalid transport/);
  });

  it('rejects invalid timeouts before touching the network', async () => {
    await expect(
      run(['node', 'dns-checker', 'lookup', 'example.com', '--timeout', 'soon']),
    ).rejects.toThrow(/invalid timeout/);
  });
});

describe('run check', () => {
  it('rejects when no rule flag is given', async () => {
    await expect(run(['node', 'dns-checker', 'check', 'example.com'])).rejects.toThrow(
      /no rule option given/,
    );
    expect(process.exitCode).toBe(2);
  });

  it('rejects when two rule flags are given', async () => {
    await expect(
      run(['node', 'dns-checker', 'check', 'example.com', '--expect', '192.0.2.1', '--absent']),
    ).rejects.toThrow(/multiple rule options given/);
    expect(process.exitCode).toBe(2);
  });

  it('rejects an unsupported type before touching the network', async () => {
    await expect(
      run(['node', 'dns-checker', 'check', 'example.com', '--type', 'BOGUS', '--absent']),
    ).rejects.toThrow(/unsupported record type/);
  });
});

describe('run wait', () => {
  it('rejects invalid interval durations before touching the network', async () => {
    await expect(
      run(['node', 'dns-checker', 'wait', 'example.com', '--interval', 'fortnight', '--absent']),
    ).rejects.toThrow(/invalid duration/);
  });

  it('rejects rule flag combinations before touching the network', async () => {
    await expect(
      run(['node', 'dns-checker', 'wait', 'example.com', '--contains', 'a', '--regex', 'b']),
    ).rejects.toThrow(/multiple rule options given/);
  });
});

describe('run resolvers', () => {
  it('lists the built-in resolver presets without touching the network', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(['node', 'dns-checker', 'resolvers', '--json']);
    const output = JSON.parse(log.mock.calls[0]?.[0] as string) as { name: string }[];
    expect(output.map((entry) => entry.name)).toContain('cloudflare');
  });
});
