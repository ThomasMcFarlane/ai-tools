import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli/index.js';
import { parseHookSpec } from '../src/cli/watch.js';
import { STATE_FILE } from '../src/core/store.js';

let stateRoot: string;
let previousStateDir: string | undefined;
let previousExitCode: string | number | undefined;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dns-checker-cli-watch-'));
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

async function readWatchers(): Promise<{ watchers: { name: string }[] }> {
  const raw = await readFile(join(stateRoot, STATE_FILE), 'utf8');
  return JSON.parse(raw) as { watchers: { name: string }[] };
}

describe('watch add', () => {
  it('saves the spec to the state file', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run([
      'node',
      'dns-checker',
      'watch',
      'add',
      'demo',
      '--domain',
      'example.com',
      '-t',
      'A',
      '--expect',
      '192.0.2.1',
      '--hook',
      'file:/dev/null',
    ]);
    log.mockRestore();
    const state = await readWatchers();
    expect(state.watchers).toHaveLength(1);
    expect(state.watchers[0]).toMatchObject({
      name: 'demo',
      domain: 'example.com',
      type: 'A',
      rule: { kind: 'equals', values: ['192.0.2.1'] },
      hook: { kind: 'file', path: '/dev/null' },
      intervalSeconds: 60,
    });
  });

  it('rejects a duplicate name with exit 1', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(['node', 'dns-checker', 'watch', 'add', 'demo', '--domain', 'example.com', '--absent']);
    await expect(
      run(['node', 'dns-checker', 'watch', 'add', 'demo', '--domain', 'example.com', '--absent']),
    ).rejects.toThrow(/already exists/);
    log.mockRestore();
    expect(process.exitCode).toBe(1);
  });

  it('rejects an invalid hook spec', async () => {
    await expect(
      run([
        'node',
        'dns-checker',
        'watch',
        'add',
        'demo',
        '--domain',
        'example.com',
        '--absent',
        '--hook',
        'smoke:test',
      ]),
    ).rejects.toThrow(/invalid hook spec/);
  });

  it('rejects zero and two rule flags', async () => {
    await expect(
      run(['node', 'dns-checker', 'watch', 'add', 'demo', '--domain', 'example.com']),
    ).rejects.toThrow(/no rule option given/);
    await expect(
      run([
        'node',
        'dns-checker',
        'watch',
        'add',
        'demo',
        '--domain',
        'example.com',
        '--expect',
        '192.0.2.1',
        '--absent',
      ]),
    ).rejects.toThrow(/multiple rule options given/);
    expect(process.exitCode).toBe(2);
  });

  it('rejects an unsupported record type', async () => {
    await expect(
      run(['node', 'dns-checker', 'watch', 'add', 'demo', '--domain', 'example.com', '-t', 'BOGUS', '--absent']),
    ).rejects.toThrow(/unsupported record type/);
  });
});

describe('watch list', () => {
  it('shows a row per saved watch', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(['node', 'dns-checker', 'watch', 'add', 'demo', '--domain', 'example.com', '--absent']);
    log.mockClear();
    await run(['node', 'dns-checker', 'watch', 'list']);
    const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    log.mockRestore();
    expect(output).toContain('demo');
    expect(output).toContain('example.com');
    expect(output).toContain('1m');
    expect(output).toContain('none');
  });
});

describe('watch show and remove', () => {
  it('roundtrips show then remove', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(['node', 'dns-checker', 'watch', 'add', 'demo', '--domain', 'example.com', '--absent']);
    log.mockClear();
    await run(['node', 'dns-checker', 'watch', 'show', 'demo']);
    const shown = JSON.parse(log.mock.calls[0]?.[0] as string) as { name: string };
    expect(shown.name).toBe('demo');
    await run(['node', 'dns-checker', 'watch', 'remove', 'demo']);
    const state = await readWatchers();
    expect(state.watchers).toHaveLength(0);
    log.mockRestore();
    await expect(run(['node', 'dns-checker', 'watch', 'show', 'demo'])).rejects.toThrow(/unknown watch "demo"/);
    expect(process.exitCode).toBe(1);
  });
});

describe('watch check', () => {
  it('rejects an unknown name with exit 2', async () => {
    await expect(run(['node', 'dns-checker', 'watch', 'check', 'nope'])).rejects.toThrow(
      /unknown watch "nope"/,
    );
    expect(process.exitCode).toBe(2);
  });
});

describe('parseHookSpec', () => {
  it('parses none', () => {
    expect(parseHookSpec('none')).toEqual({ kind: 'none' });
  });

  it('keeps colons and spaces in exec commands verbatim', () => {
    expect(parseHookSpec('exec:sh -c "echo a:b"')).toEqual({ kind: 'exec', command: 'sh -c "echo a:b"' });
  });

  it('parses notify hooks', () => {
    expect(parseHookSpec('notify:claude')).toEqual({ kind: 'notify', tool: 'claude' });
    expect(parseHookSpec('notify:codex')).toEqual({ kind: 'notify', tool: 'codex' });
    expect(parseHookSpec('notify:opencode')).toEqual({ kind: 'notify', tool: 'opencode' });
  });

  it('parses file and webhook hooks', () => {
    expect(parseHookSpec('file:/tmp/events.log')).toEqual({ kind: 'file', path: '/tmp/events.log' });
    expect(parseHookSpec('webhook:https://example.com/hook?x=1')).toEqual({
      kind: 'webhook',
      url: 'https://example.com/hook?x=1',
    });
  });

  it('rejects invalid specs', () => {
    expect(() => parseHookSpec('smoke:test')).toThrow(/invalid hook spec/);
    expect(() => parseHookSpec('notify:cursor')).toThrow(/invalid hook spec/);
    expect(() => parseHookSpec('exec:')).toThrow(/invalid hook spec/);
    expect(() => parseHookSpec('file:')).toThrow(/invalid hook spec/);
    expect(() => parseHookSpec('webhook:')).toThrow(/invalid hook spec/);
  });
});
