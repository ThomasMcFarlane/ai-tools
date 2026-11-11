import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NextResult } from '../src/core/next.js';
import { appendEvent } from '../src/core/store.js';
import type { QuestionRecord } from '../src/core/types.js';
import {
  defaultFiles,
  holdLevel,
  LogBuilder,
  makeWorld,
  removeWorlds,
  runCli,
  type CliWorld,
} from './helpers.js';

afterEach(removeWorlds);

const ASK = ['--area', 'a', '--level', 'read', '--type', 'explain', '--file', 'prompt.txt'];

async function worldWithMap(mode: 'learn' | 'interview' | null = 'learn') {
  const world = await makeWorld({
    files: { ...defaultFiles(), 'prompt.txt': 'What does it do?', 'answer.txt': 'It does.' },
  });
  await runCli(['map', 'set', '--file', 'map.json'], world);
  if (mode !== null) await runCli(['session', 'start', '--mode', mode], world);
  return world;
}

async function stateDir(world: CliWorld): Promise<string> {
  return ((await runCli(['status', '--json'], world)).json() as { stateDir: string }).stateDir;
}

async function seed(world: CliWorld, log: LogBuilder): Promise<void> {
  const dir = await stateDir(world);
  for (const event of log.events) await appendEvent(dir, event);
}

describe('read commands', () => {
  it('next returns targets and session progress as JSON', async () => {
    const world = await worldWithMap();
    await runCli(['ask', ...ASK, '--evidence', 'src/a/x.ts:1'], world);
    const r = await runCli(['next', '--count', '2', '--json'], world);
    expect(r.code).toBe(0);
    const result = r.json() as NextResult;
    expect(result.targets).toHaveLength(2);
    expect(result.session).toEqual({ id: 's1', asked: 1, limit: 8, done: false });
    const first = result.targets[0];
    expect(first).toMatchObject({ level: 'read' });
    const only = (await runCli(['next', '--area', 'c', '--json'], world)).json() as NextResult;
    expect(only.targets.map((t) => t.areaId)).toEqual(['c']);
    const dflt = (await runCli(['next', '--json'], world)).json() as NextResult;
    expect(dflt.targets).toHaveLength(3);
  });

  it('next without an open session reports a null session id, and rejects bad input', async () => {
    const world = await worldWithMap(null);
    const r = (await runCli(['next', '--json'], world)).json() as NextResult;
    expect(r.session.id).toBeNull();
    expect((await runCli(['next', '--count', '0'], world)).code).toBe(2);
    expect((await runCli(['next', '--count', '1.5'], world)).code).toBe(2);
    expect((await runCli(['next', '--area', 'nope'], world)).code).toBe(2);
    expect((await runCli(['next'], await makeWorld())).code).toBe(1);
  });

  it('next prints readable text', async () => {
    const world = await worldWithMap();
    const r = await runCli(['next', '--count', '1'], world);
    expect(r.out).toContain('Area a');
    expect(r.out).toContain('Session s1: 0 of 8');
  });

  it('levels prints every label and the stale mark', async () => {
    const world = await worldWithMap();
    const log = new LogBuilder();
    holdLevel(log, 'a', 'maintain');
    holdLevel(log, 'b', 'read');
    log.raise('a');
    await seed(world, log);
    const r = await runCli(['levels'], world);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Ready to be interviewed on it');
    expect(r.out).toContain('stale (was maintain)');
    expect(r.out).toContain('untested');
    expect(r.out).toContain('Verdict:');
    const json = (await runCli(['levels', '--json'], world)).json() as {
      areas: { id: string; stale: boolean }[];
      verdict: { label: string };
    };
    expect(json.areas.find((a) => a.id === 'a')?.stale).toBe(true);
    expect(json.verdict.label).toBeTruthy();
  });

  it('history filters by area and session and exits 1 when empty', async () => {
    const world = await worldWithMap();
    expect((await runCli(['history'], world)).code).toBe(1);
    await runCli(['ask', ...ASK, '--evidence', 'src/a/x.ts:1'], world);
    await runCli(
      ['ask', ...ASK.map((v) => (v === 'a' ? 'b' : v)), '--evidence', 'src/b/x.ts:1'],
      world,
    );
    await runCli(['session', 'start', '--mode', 'learn'], world);
    await runCli(['ask', ...ASK, '--evidence', 'src/a/x.ts:1'], world);
    const all = (await runCli(['history', '--json'], world)).json() as (QuestionRecord & {
      retired: boolean;
    })[];
    expect(all.map((q) => q.id)).toEqual(['q3', 'q2', 'q1']);
    expect(all.every((q) => q.retired === false)).toBe(true);
    const ids = async (args: string[]) =>
      ((await runCli(['history', '--json', ...args], world)).json() as { id: string }[]).map(
        (q) => q.id,
      );
    expect(await ids(['--area', 'a'])).toEqual(['q3', 'q1']);
    expect(await ids(['--session', 's1'])).toEqual(['q2', 'q1']);
    expect(await ids(['--area', 'a', '--session', 's1'])).toEqual(['q1']);
    expect(await ids(['--limit', '1'])).toEqual(['q3']);
    expect((await runCli(['history', '--area', 'c'], world)).code).toBe(1);
    expect((await runCli(['history', '--area', 'zzz'], world)).code).toBe(2);
    expect((await runCli(['history', '--session', 's9'], world)).code).toBe(2);
    expect((await runCli(['history', '--limit', '0'], world)).code).toBe(2);
    expect((await runCli(['history', '--limit', 'x'], world)).code).toBe(2);
    const text = await runCli(['history'], world);
    expect(text.out).toContain('q3');
    expect(text.out).toContain('open');
  });

  it('history marks a retired area', async () => {
    const world = await worldWithMap();
    const log = new LogBuilder();
    log.session();
    log.q('gone', 'read', 4);
    await seed(world, log);
    const all = (await runCli(['history', '--json'], world)).json() as {
      areaId: string;
      retired: boolean;
    }[];
    expect(all[0]).toMatchObject({ areaId: 'gone', retired: true });
    expect((await runCli(['history', '--area', 'gone'], world)).out).toContain('retired');
  });

  it('export prints repo, map and events; reset needs --yes and then status exits 1', async () => {
    const world = await worldWithMap();
    await runCli(['ask', ...ASK, '--evidence', 'src/a/x.ts:1'], world);
    const exported = (await runCli(['export'], world)).json() as {
      repo: { key: string };
      map: { areas: unknown[] };
      events: { type: string }[];
    };
    expect(exported.repo.key).toBe('github.com/octo-org/hello-world');
    expect(exported.map.areas).toHaveLength(3);
    expect(exported.events.map((e) => e.type)).toEqual(['map_set', 'session_start', 'ask']);

    const refused = await runCli(['reset'], world);
    expect(refused.code).toBe(2);
    expect((await runCli(['status'], world)).code).toBe(0);
    expect((await runCli(['map', 'show'], world)).code).toBe(0);

    const done = await runCli(['reset', '--yes', '--json'], world);
    expect(done.json()).toEqual({ removed: true });
    expect((await runCli(['status'], world)).code).toBe(1);
    expect((await runCli(['reset', '--yes', '--json'], world)).json()).toEqual({ removed: false });
  });

  it('reset removes only this repository state folder', async () => {
    const world = await worldWithMap();
    const dir = await stateDir(world);
    const other = join(dir, '..', 'other-repo');
    const { mkdir, writeFile, stat } = await import('node:fs/promises');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'events.jsonl'), '');
    await runCli(['reset', '--yes'], world);
    await expect(stat(other)).resolves.toBeTruthy();
    await expect(readFile(join(dir, 'map.json'), 'utf8')).rejects.toThrow();
  });
});
