import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireHook, type WatchEvent } from '../src/index.js';

let workDir: string;
let previousEnv: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'dns-checker-hooks-'));
  previousEnv = process.env['AI_TOOLS_DNS_STATE_DIR'];
  process.env['AI_TOOLS_DNS_STATE_DIR'] = join(workDir, 'state');
});

afterEach(async () => {
  if (previousEnv === undefined) {
    delete process.env['AI_TOOLS_DNS_STATE_DIR'];
  } else {
    process.env['AI_TOOLS_DNS_STATE_DIR'] = previousEnv;
  }
  await rm(workDir, { recursive: true, force: true });
});

function sampleEvent(): WatchEvent {
  return {
    watch: 'example-watch',
    domain: 'example.com',
    type: 'A',
    matched: true,
    reason: 'values equal [192.0.2.1]',
    values: ['192.0.2.1'],
    checkedAt: '2026-01-01T00:00:00.000Z',
    fired: false,
  };
}

describe('fireHook', () => {
  it('none hook succeeds without side effects', async () => {
    const result = await fireHook({ kind: 'none' }, sampleEvent());
    expect(result).toEqual({ ok: true });
  });

  it('exec hook receives the event on stdin', async () => {
    const result = await fireHook({ kind: 'exec', command: 'cat > /dev/null && exit 0' }, sampleEvent());
    expect(result.ok).toBe(true);
  });

  it('exec hook exposes the event through environment variables', async () => {
    const command =
      'node -e "if (process.env.DNS_EVENT && process.env.DNS_WATCH_NAME && process.env.DNS_DOMAIN && process.env.DNS_TYPE && process.env.DNS_MATCHED && process.env.DNS_REASON && process.env.DNS_VALUES) { process.exit(0); } process.exit(1);"';
    const result = await fireHook({ kind: 'exec', command }, sampleEvent());
    expect(result.ok).toBe(true);
  });

  it('exec hook reports failure for a non-zero exit', async () => {
    const result = await fireHook(
      { kind: 'exec', command: 'cat > /dev/null && echo boom >&2 && exit 3' },
      sampleEvent(),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('3');
    expect(result.detail).toContain('boom');
  });

  it('file hook appends the event as a JSON line', async () => {
    const path = join(workDir, 'events', 'hook.jsonl');
    const result = await fireHook({ kind: 'file', path }, sampleEvent());
    expect(result.ok).toBe(true);
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      watch: 'example-watch',
      domain: 'example.com',
      type: 'A',
    });
  });

  it('file hook creates missing parent directories', async () => {
    const path = join(workDir, 'missing-dir', 'sub', 'hook.jsonl');
    const result = await fireHook({ kind: 'file', path }, sampleEvent());
    expect(result.ok).toBe(true);
  });
});
