import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli/index.js';
import { parseHookSpec } from '../src/cli/watch.js';
import { STATE_FILE } from '../src/core/store.js';
import type { GhWatchSpec } from '../src/core/types.js';

let stateRoot: string;
let previousStateDir: string | undefined;
let previousExitCode: string | number | undefined;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'gh-watcher-cli-watch-'));
  previousStateDir = process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
  process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = stateRoot;
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
  } else {
    process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = previousStateDir;
  }
  process.exitCode = previousExitCode;
  await rm(stateRoot, { recursive: true, force: true });
});

async function readWatchers(): Promise<GhWatchSpec[]> {
  const raw = await readFile(join(stateRoot, STATE_FILE), 'utf8');
  return (JSON.parse(raw) as { watchers: GhWatchSpec[] }).watchers;
}

describe('watch add', () => {
  it('saves the spec with complete triggers by default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run([
      'node',
      'gh-watcher',
      'watch',
      'add',
      'demo',
      '--repo',
      'octo-org/hello-world',
      '--branch',
      'main',
      '--hook',
      'file:/dev/null',
    ]);
    log.mockRestore();
    const watchers = await readWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0]).toMatchObject({
      name: 'demo',
      repo: 'octo-org/hello-world',
      target: { kind: 'branch', branch: 'main' },
      triggers: { failure: true, success: true },
      hook: { kind: 'file', path: '/dev/null' },
      intervalSeconds: 60,
    });
  });

  it.each([
    ['failure', { failure: true, success: false }],
    ['success', { failure: false, success: true }],
    ['complete', { failure: true, success: true }],
  ] as const)('maps --on %s to triggers', async (on, triggers) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run([
      'node',
      'gh-watcher',
      'watch',
      'add',
      'demo',
      '--repo',
      'octo-org/hello-world',
      '--pr',
      '5',
      '--on',
      on,
    ]);
    log.mockRestore();
    const watchers = await readWatchers();
    expect(watchers[0]?.triggers).toEqual(triggers);
    expect(watchers[0]?.target).toEqual({ kind: 'pr', number: 5 });
  });

  it('rejects a duplicate name with exit 1', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run([
      'node',
      'gh-watcher',
      'watch',
      'add',
      'demo',
      '--repo',
      'octo-org/hello-world',
      '--branch',
      'main',
    ]);
    await expect(
      run(['node', 'gh-watcher', 'watch', 'add', 'demo', '--repo', 'octo-org/hello-world', '--branch', 'main']),
    ).rejects.toThrow(/already exists/);
    log.mockRestore();
    expect(process.exitCode).toBe(1);
  });

  it('rejects an invalid hook spec', async () => {
    await expect(
      run([
        'node',
        'gh-watcher',
        'watch',
        'add',
        'demo',
        '--repo',
        'octo-org/hello-world',
        '--branch',
        'main',
        '--hook',
        'smoke:test',
      ]),
    ).rejects.toThrow(/invalid hook spec/);
  });

  it('rejects a watch add without a target', async () => {
    await expect(
      run(['node', 'gh-watcher', 'watch', 'add', 'demo', '--repo', 'octo-org/hello-world']),
    ).rejects.toThrow(/no target option given/);
    expect(process.exitCode).toBe(2);
  });
});

describe('watch list', () => {
  it('shows a row per saved watch', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run([
      'node',
      'gh-watcher',
      'watch',
      'add',
      'demo',
      '--repo',
      'octo-org/hello-world',
      '--branch',
      'main',
      '--on',
      'failure',
    ]);
    log.mockClear();
    await run(['node', 'gh-watcher', 'watch', 'list']);
    const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    log.mockRestore();
    expect(output).toContain('demo');
    expect(output).toContain('octo-org/hello-world');
    expect(output).toContain('branch:main');
    expect(output).toContain('failure');
    expect(output).toContain('1m');
    expect(output).toContain('none');
  });
});

describe('watch show and remove', () => {
  it('roundtrips show then remove', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run([
      'node',
      'gh-watcher',
      'watch',
      'add',
      'demo',
      '--repo',
      'octo-org/hello-world',
      '--branch',
      'main',
    ]);
    log.mockClear();
    await run(['node', 'gh-watcher', 'watch', 'show', 'demo']);
    const shown = JSON.parse(log.mock.calls[0]?.[0] as string) as { name: string };
    expect(shown.name).toBe('demo');
    await run(['node', 'gh-watcher', 'watch', 'remove', 'demo']);
    const watchers = await readWatchers();
    expect(watchers).toHaveLength(0);
    log.mockRestore();
    await expect(run(['node', 'gh-watcher', 'watch', 'show', 'demo'])).rejects.toThrow(/unknown watch "demo"/);
    expect(process.exitCode).toBe(1);
  });
});

describe('watch check', () => {
  it('rejects an unknown name with exit 2', async () => {
    await expect(run(['node', 'gh-watcher', 'watch', 'check', 'nope'])).rejects.toThrow(
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
