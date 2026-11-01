import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GhClient, runDaemon, upsertWatcher, type GhWatchSpec } from '../src/index.js';

let root: string;
let previous: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gh-watcher-daemon-'));
  previous = process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
  process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = root;
});

afterEach(async () => {
  if (previous === undefined) {
    delete process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'];
  } else {
    process.env['AI_TOOLS_GH_WATCHER_STATE_DIR'] = previous;
  }
  await rm(root, { recursive: true, force: true });
});

describe('runDaemon stop', () => {
  it('ends a queued rate-limit wait promptly and releases locks', async () => {
    const spec: GhWatchSpec = {
      name: 'w',
      repo: 'o/r',
      target: { kind: 'branch', branch: 'main' },
      triggers: { failure: true, success: true },
      hook: { kind: 'none' },
      intervalSeconds: 1,
      createdAt: new Date().toISOString(),
    };
    await upsertWatcher(spec);
    const limited = { stdout: '', stderr: 'You have exceeded a secondary rate limit. (HTTP 403)', code: 1 };
    const { createQueuedExec } = await import('../src/core/queue.js');
    const client = new GhClient({ exec: createQueuedExec(async () => limited, { minSpacingMs: 0, log: () => undefined }) });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    await runDaemon(undefined, { pollSeconds: 3600, signal: controller.signal }, { client });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
