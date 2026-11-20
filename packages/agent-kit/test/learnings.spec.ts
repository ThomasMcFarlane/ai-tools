import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const pendingOf = (state: string) => join(state, 'demo', 'pending.jsonl');
  const flushing = (state: string) =>
    existsSync(join(state, 'demo'))
      ? readdirSync(join(state, 'demo')).filter((n) => n.endsWith('.flushing'))
      : [];

  it('does nothing when nothing is pending', () => {
    const { opts } = setup();
    expect(flushLearnings('demo', opts).status).toBe('empty');
  });

  it('runs AGENTS_MEMORY_PERSIST on a claimed file with placeholders and removes it', () => {
    const sink = join(tempDir(), 'sink.txt');
    const { opts, state } = setup({
      AGENTS_MEMORY_PERSIST: `cat {file} >> ${sink}; echo {agent} {file} >> ${sink}`,
    });
    appendLearning('demo', { kind: 'note', key: 'n', value: 'hello' }, opts);
    const result = flushLearnings('demo', opts);
    expect(result).toMatchObject({ status: 'persisted', lines: 1, method: 'command' });
    const text = readFileSync(sink, 'utf8');
    expect(text).toContain('"hello"');
    expect(text).toMatch(/demo .*pending\.\d+\.\d+.*\.flushing/);
    expect(existsSync(pendingOf(state))).toBe(false);
    expect(flushing(state)).toEqual([]);
  });

  it('keeps lines appended during a flush for the next flush', () => {
    const sink = join(tempDir(), 'sink.txt');
    const { opts, state } = setup();
    const env = {
      AGENTS_MEMORY_PERSIST: `cat {file} >> ${sink}; echo '${JSON.stringify(entry({ key: 'late', value: 'late' }))}' >> ${pendingOf(state)}`,
    };
    appendLearning('demo', { kind: 'note', key: 'first', value: 'first' }, { ...opts, env });
    flushLearnings('demo', { ...opts, env });
    expect(readFileSync(sink, 'utf8')).not.toContain('late');
    expect(readFileSync(pendingOf(state), 'utf8')).toContain('"late"');
    const again = flushLearnings('demo', {
      ...opts,
      env: { AGENTS_MEMORY_PERSIST: `cat {file} >> ${sink}` },
    });
    expect(again.lines).toBe(1);
    expect(readFileSync(sink, 'utf8')).toContain('"late"');
  });

  it('restores the claimed lines in front of new ones when the command fails', () => {
    const { opts, state } = setup();
    const env = {
      AGENTS_MEMORY_PERSIST: `echo '${JSON.stringify(entry({ key: 'late', value: 'late' }))}' >> ${pendingOf(state)}; exit 3`,
    };
    appendLearning('demo', { kind: 'note', key: 'n', value: 'x' }, { ...opts, env });
    expect(() => flushLearnings('demo', { ...opts, env })).toThrow(FlushError);
    const text = readFileSync(pendingOf(state), 'utf8');
    expect(text).toContain('"x"');
    expect(text).toContain('"late"');
    expect(flushing(state)).toEqual([]);
  });

  it('picks up leftover files from a crashed run', () => {
    const sink = join(tempDir(), 'sink.txt');
    const { opts, state } = setup({ AGENTS_MEMORY_PERSIST: `cat {file} >> ${sink}` });
    mkdirSync(join(state, 'demo'), { recursive: true });
    writeFileSync(
      join(state, 'demo', 'pending.999999999.1.flushing'),
      `${JSON.stringify(entry({ value: 'old' }))}\n`,
    );
    appendLearning('demo', { kind: 'note', key: 'n', value: 'fresh' }, opts);
    const result = flushLearnings('demo', opts);
    expect(result.lines).toBe(2);
    const text = readFileSync(sink, 'utf8');
    expect(text).toContain('"old"');
    expect(text).toContain('"fresh"');
    expect(flushing(state)).toEqual([]);
  });

  it('leaves a leftover file of a live process alone', () => {
    const { opts, state } = setup();
    mkdirSync(join(state, 'demo'), { recursive: true });
    const other = join(state, 'demo', `pending.${process.ppid}.1.flushing`);
    writeFileSync(other, `${JSON.stringify(entry({}))}\n`);
    expect(flushLearnings('demo', opts).status).toBe('empty');
    expect(existsSync(other)).toBe(true);
  });

  it('appends to the durable file when no command is set', () => {
    const { opts, mem, state } = setup();
    appendLearning('demo', { kind: 'note', key: 'n', value: 'x' }, opts);
    const result = flushLearnings('demo', opts);
    expect(result.method).toBe('append');
    expect(readFileSync(join(mem, 'demo', 'learnings.jsonl'), 'utf8')).toContain('"note"');
    expect(existsSync(pendingOf(state))).toBe(false);
    expect(flushing(state)).toEqual([]);
  });

  it('refuses a direct append when AGENTS_MEMORY_READONLY=1 and keeps pending', () => {
    const { opts, mem, state } = setup({ AGENTS_MEMORY_READONLY: '1' });
    appendLearning('demo', { kind: 'note', key: 'n', value: 'x' }, opts);
    expect(() => flushLearnings('demo', opts)).toThrow(/AGENTS_MEMORY_PERSIST/);
    expect(existsSync(join(mem, 'demo', 'learnings.jsonl'))).toBe(false);
    expect(readFileSync(pendingOf(state), 'utf8')).toContain('"x"');
  });

  it('still runs the persist command when AGENTS_MEMORY_READONLY=1', () => {
    const sink = join(tempDir(), 'sink.txt');
    const { opts } = setup({
      AGENTS_MEMORY_READONLY: '1',
      AGENTS_MEMORY_PERSIST: `cat {file} >> ${sink}`,
    });
    appendLearning('demo', { kind: 'note', key: 'n', value: 'x' }, opts);
    expect(flushLearnings('demo', opts).method).toBe('command');
  });

  it('fails with a hint when the durable directory is not writable and restores pending', () => {
    const { opts, state } = setup();
    const blocker = join(tempDir(), 'file');
    writeFileSync(blocker, 'x');
    const bad = { ...opts, memoryDir: join(blocker, 'sub') };
    appendLearning('demo', { kind: 'note', key: 'n', value: 'x' }, bad);
    expect(() => flushLearnings('demo', bad)).toThrow(/AGENTS_MEMORY_PERSIST/);
    expect(readFileSync(pendingOf(state), 'utf8')).toContain('"x"');
    expect(flushing(state)).toEqual([]);
  });
});
