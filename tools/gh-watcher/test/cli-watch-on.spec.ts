import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli/index.js';
import { parseOn } from '../src/cli/watch.js';
import { PR_EVENT_KINDS, STATE_FILE, type GhWatchSpec } from '../src/index.js';

let stateRoot: string;
let previousStateDir: string | undefined;
let previousExitCode: string | number | undefined;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'gh-watcher-cli-on-'));
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

const PR_TARGET = { kind: 'pr', number: 5 } as const;

describe('parseOn', () => {
  it('keeps the old values', () => {
    expect(parseOn('failure', PR_TARGET)).toEqual({ triggers: { failure: true, success: false } });
    expect(parseOn('success', PR_TARGET)).toEqual({ triggers: { failure: false, success: true } });
    expect(parseOn('complete', { kind: 'run', runId: 1 })).toEqual({ triggers: { failure: true, success: true } });
  });

  it('mixes CI triggers with pull request kinds', () => {
    expect(parseOn('failure,merged,ready', PR_TARGET)).toEqual({
      triggers: { failure: true, success: false },
      prEvents: ['merged', 'ready'],
    });
  });

  it('turns only pull request kinds into a watch without CI triggers', () => {
    expect(parseOn('merged', { kind: 'branch', branch: 'main' })).toEqual({
      triggers: { failure: false, success: false },
      prEvents: ['merged'],
    });
  });

  it('expands any to every pull request kind', () => {
    expect(parseOn('any', PR_TARGET).prEvents).toEqual([...PR_EVENT_KINDS]);
  });

  it('rejects unknown values and pull request kinds on other targets', () => {
    expect(() => parseOn('bogus', PR_TARGET)).toThrow(/invalid value "bogus"/);
    expect(() => parseOn('merged', { kind: 'commit', sha: 'abcd' })).toThrow(/need a --pr or --branch/);
    expect(() => parseOn('success,comment', { kind: 'run', runId: 1 })).toThrow(/need a --pr or --branch/);
  });
});

describe('watch add --on with pull request kinds', () => {
  it('saves prEvents and shows them in the list', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run([
      'node', 'gh-watcher', 'watch', 'add', 'demo', '--repo', 'octo-org/hello-world', '--pr', '5',
      '--on', 'merged,closed,failure',
    ]);
    const watchers = await readWatchers();
    expect(watchers[0]?.prEvents).toEqual(['merged', 'closed']);
    expect(watchers[0]?.triggers).toEqual({ failure: true, success: false });
    log.mockClear();
    await run(['node', 'gh-watcher', 'watch', 'list']);
    const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    log.mockRestore();
    expect(output).toContain('failure+pr:merged,closed');
  });

  it('does not save prEvents for the old values', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(['node', 'gh-watcher', 'watch', 'add', 'demo', '--repo', 'octo-org/hello-world', '--pr', '5']);
    log.mockRestore();
    expect((await readWatchers())[0]?.prEvents).toBeUndefined();
  });

  it('exits 2 for pull request kinds on a commit target', async () => {
    await expect(
      run([
        'node', 'gh-watcher', 'watch', 'add', 'demo', '--repo', 'octo-org/hello-world', '--commit', 'abcd',
        '--on', 'merged',
      ]),
    ).rejects.toThrow(/need a --pr or --branch/);
    expect(process.exitCode).toBe(2);
  });

  it('exits 2 for an unknown value', async () => {
    await expect(
      run(['node', 'gh-watcher', 'watch', 'add', 'demo', '--repo', 'octo-org/hello-world', '--pr', '5', '--on', 'bogus']),
    ).rejects.toThrow(/invalid value/);
    expect(process.exitCode).toBe(2);
  });
});

describe('pr commands', () => {
  it('exits 2 for an unknown kind', async () => {
    await expect(
      run(['node', 'gh-watcher', 'pr', 'wait', '--repo', 'octo-org/hello-world', '--pr', '5', '--on', 'bogus']),
    ).rejects.toThrow(/invalid event kind "bogus"/);
    expect(process.exitCode).toBe(2);
  });

  it('exits 2 without a target', async () => {
    await expect(run(['node', 'gh-watcher', 'pr', 'status', '--repo', 'octo-org/hello-world'])).rejects.toThrow(
      /--pr and --branch/,
    );
    expect(process.exitCode).toBe(2);
  });

  it('exits 2 for an invalid --since', async () => {
    await expect(
      run(['node', 'gh-watcher', 'pr', 'wait', '--repo', 'octo-org/hello-world', '--pr', '5', '--since', 'later']),
    ).rejects.toThrow(/invalid --since/);
    expect(process.exitCode).toBe(2);
  });
});
