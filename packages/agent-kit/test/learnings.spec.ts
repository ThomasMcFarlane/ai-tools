import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FlushError,
  appendLearning,
  effectiveLearnings,
  flushLearnings,
  foldLearnings,
  liveBlock,
  parseExpiry,
  parseLearningLines,
  readLearnings,
  type Learning,
} from '../src/index.js';
import { tempDir } from './helpers.js';

function entry(partial: Partial<Learning>): Learning {
  return {
    v: 1,
    ts: '2026-11-21T00:00:00.000Z',
    agent: 'demo',
    kind: 'selector',
    site: 'a',
    key: 'k',
    value: 1,
    expires: null,
    evidence: null,
    ...partial,
  };
}

function setup(extraEnv: Record<string, string> = {}) {
  const mem = tempDir();
  const state = tempDir();
  const clock = { now: new Date('2026-11-21T10:00:00.000Z') };
  const opts = {
    memoryDir: mem,
    stateDir: state,
    env: { ...extraEnv },
    now: () => clock.now,
  };
  return { mem, state, clock, opts };
}

describe('parseExpiry', () => {
  const now = new Date('2026-11-21T10:00:00.000Z');
  it('adds relative durations', () => {
    expect(parseExpiry('24h', now)).toBe('2026-11-22T10:00:00.000Z');
    expect(parseExpiry('30m', now)).toBe('2026-11-21T10:30:00.000Z');
    expect(parseExpiry('7d', now)).toBe('2026-11-28T10:00:00.000Z');
  });
  it('accepts ISO and rejects junk', () => {
    expect(parseExpiry('2026-12-01T00:00:00Z', now)).toBe('2026-12-01T00:00:00.000Z');
    expect(() => parseExpiry('soon', now)).toThrow(/invalid expiry/);
  });
});

describe('foldLearnings', () => {
  const now = new Date('2026-11-21T10:00:00.000Z');
  it('drops expired entries', () => {
    const out = foldLearnings([entry({ expires: '2026-11-21T09:00:00.000Z' })], now);
    expect(out).toEqual([]);
  });
  it('keeps the latest per kind, site and key', () => {
    const out = foldLearnings(
      [
        entry({ ts: '2026-11-20T00:00:00.000Z', value: 'old' }),
        entry({ ts: '2026-11-21T00:00:00.000Z', value: 'new' }),
        entry({ site: 'b', value: 'other' }),
      ],
      now,
    );
    expect(out.map((e) => e.value).sort()).toEqual(['new', 'other']);
  });
  it('keeps every note and correction, newest first', () => {
    const out = foldLearnings(
      [
        entry({ kind: 'note', ts: '2026-11-19T00:00:00.000Z', value: 'a' }),
        entry({ kind: 'note', ts: '2026-11-20T00:00:00.000Z', value: 'b' }),
        entry({ kind: 'correction', ts: '2026-11-21T00:00:00.000Z', value: 'c' }),
        entry({ kind: 'note', ts: '2026-11-19T00:00:00.000Z', value: 'a' }),
      ],
      now,
    );
    expect(out.map((e) => e.value)).toEqual(['c', 'b', 'a']);
  });
});

describe('journal', () => {
  it('appends to the local and pending files and reads them back', () => {
    const { opts, state } = setup();
    const saved = appendLearning(
      'demo',
      { kind: 'method', site: 'a', key: 'fetch', value: 'headless' },
      opts,
    );
    expect(saved.ts).toBe('2026-11-21T10:00:00.000Z');
    expect(readFileSync(join(state, 'demo', 'pending.jsonl'), 'utf8')).toContain('"fetch"');
    expect(readLearnings('demo', opts)).toHaveLength(1);
    expect(effectiveLearnings('demo', opts)[0]?.value).toBe('headless');
  });

  it('merges durable and local files and skips bad lines', () => {
    const { opts, mem } = setup();
    mkdirSync(join(mem, 'demo'));
    writeFileSync(
      join(mem, 'demo', 'learnings.jsonl'),
      `not json\n${JSON.stringify(entry({ value: 'durable' }))}\n{"v":2}\n`,
    );
    appendLearning(
      'demo',
      { kind: 'selector', site: 'a', key: 'k', value: 'local' },
      {
        ...opts,
        now: () => new Date('2026-11-21T11:00:00.000Z'),
      },
    );
    const out = effectiveLearnings('demo', {
      ...opts,
      now: () => new Date('2026-11-21T12:00:00.000Z'),
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.value).toBe('local');
  });

  it('finds a live block and ignores an expired one', () => {
    const { opts, clock } = setup();
    appendLearning(
      'demo',
      {
        kind: 'block',
        site: 'a',
        key: 'search',
        value: 'captcha',
        expires: '2026-11-22T10:00:00.000Z',
      },
      opts,
    );
    const all = readLearnings('demo', opts);
    expect(liveBlock(all, 'a', clock.now)?.value).toBe('captcha');
    expect(liveBlock(all, 'b', clock.now)).toBeNull();
    expect(liveBlock(all, 'a', new Date('2026-11-23T00:00:00.000Z'))).toBeNull();
  });

  it('parses lines tolerantly', () => {
    expect(parseLearningLines('\n  \nxx\n')).toEqual([]);
  });
});

describe('flushLearnings', () => {
  it('does nothing when nothing is pending', () => {
    const { opts } = setup();
    expect(flushLearnings('demo', opts).status).toBe('empty');
  });

  it('runs AGENTS_MEMORY_PERSIST with placeholders and truncates pending', () => {
    const sink = join(tempDir(), 'sink.txt');
    const { opts, state } = setup({
      AGENTS_MEMORY_PERSIST: `cat {file} >> ${sink}; echo {agent} >> ${sink}`,
    });
    appendLearning('demo', { kind: 'note', key: 'n', value: 'hello' }, opts);
    const result = flushLearnings('demo', opts);
    expect(result).toMatchObject({ status: 'persisted', lines: 1, method: 'command' });
    const text = readFileSync(sink, 'utf8');
    expect(text).toContain('"hello"');
    expect(text.trim().endsWith('demo')).toBe(true);
    expect(readFileSync(join(state, 'demo', 'pending.jsonl'), 'utf8')).toBe('');
  });

  it('keeps pending when the persist command fails', () => {
    const { opts, state } = setup({ AGENTS_MEMORY_PERSIST: 'exit 3' });
    appendLearning('demo', { kind: 'note', key: 'n', value: 'x' }, opts);
    expect(() => flushLearnings('demo', opts)).toThrow(FlushError);
    expect(readFileSync(join(state, 'demo', 'pending.jsonl'), 'utf8')).not.toBe('');
  });

  it('appends to the durable file when no command is set', () => {
    const { opts, mem, state } = setup();
    appendLearning('demo', { kind: 'note', key: 'n', value: 'x' }, opts);
    const result = flushLearnings('demo', opts);
    expect(result.method).toBe('append');
    expect(readFileSync(join(mem, 'demo', 'learnings.jsonl'), 'utf8')).toContain('"note"');
    expect(readFileSync(join(state, 'demo', 'pending.jsonl'), 'utf8')).toBe('');
  });

  it('fails with a hint when the durable directory is not writable', () => {
    const { opts, state } = setup();
    const blocker = join(tempDir(), 'file');
    writeFileSync(blocker, 'x');
    const bad = { ...opts, memoryDir: join(blocker, 'sub') };
    appendLearning('demo', { kind: 'note', key: 'n', value: 'x' }, bad);
    expect(() => flushLearnings('demo', bad)).toThrow(/AGENTS_MEMORY_PERSIST/);
    expect(readFileSync(join(state, 'demo', 'pending.jsonl'), 'utf8')).not.toBe('');
  });
});
