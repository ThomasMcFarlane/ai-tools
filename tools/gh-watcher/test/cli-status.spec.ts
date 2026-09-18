import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/index.js';

let stateRoot: string;
let previousStateDir: string | undefined;
let previousRepo: string | undefined;
let previousExitCode: string | number | undefined;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'gh-watcher-cli-status-'));
  previousStateDir = process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
  process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = stateRoot;
  previousRepo = process.env['GH_REPO'];
  delete process.env['GH_REPO'];
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
  } else {
    process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = previousStateDir;
  }
  if (previousRepo === undefined) {
    delete process.env['GH_REPO'];
  } else {
    process.env['GH_REPO'] = previousRepo;
  }
  process.exitCode = previousExitCode;
  await rm(stateRoot, { recursive: true, force: true });
});

describe('status pre-flight validation', () => {
  it('errors before any gh call with no target and no GH_REPO', async () => {
    await expect(run(['node', 'gh-watcher', 'status'])).rejects.toThrow(/no repository specified/);
  });

  it('errors when no target flag is given', async () => {
    await expect(
      run(['node', 'gh-watcher', 'status', '--repo', 'octo-org/hello-world']),
    ).rejects.toThrow(/no target option given/);
    expect(process.exitCode).toBe(2);
  });

  it('errors when multiple target flags are given', async () => {
    await expect(
      run([
        'node',
        'gh-watcher',
        'status',
        '--repo',
        'octo-org/hello-world',
        '--branch',
        'main',
        '--pr',
        '1',
      ]),
    ).rejects.toThrow(/multiple target options given/);
    expect(process.exitCode).toBe(2);
  });

  it('rejects a bad commit sha before any gh call', async () => {
    await expect(
      run(['node', 'gh-watcher', 'status', '--repo', 'octo-org/hello-world', '--commit', 'nope']),
    ).rejects.toThrow(/invalid commit/);
    expect(process.exitCode).toBe(2);
  });

  it('rejects a non-positive run id before any gh call', async () => {
    await expect(
      run(['node', 'gh-watcher', 'status', '--repo', 'octo-org/hello-world', '--run', '0']),
    ).rejects.toThrow(/invalid --run/);
  });
});

describe('wait pre-flight validation', () => {
  it('errors with no repo and no GH_REPO', async () => {
    await expect(run(['node', 'gh-watcher', 'wait', '--branch', 'main'])).rejects.toThrow(
      /no repository specified/,
    );
  });

  it('rejects an invalid interval', async () => {
    await expect(
      run([
        'node',
        'gh-watcher',
        'wait',
        '--repo',
        'octo-org/hello-world',
        '--branch',
        'main',
        '--interval',
        'fortnight',
      ]),
    ).rejects.toThrow(/invalid duration/);
  });
});
