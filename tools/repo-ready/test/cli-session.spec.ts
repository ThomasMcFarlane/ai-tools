import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, removeWorlds, runCli } from './helpers.js';

afterEach(removeWorlds);

async function withMap() {
  const world = await makeWorld();
  await runCli(['map', 'set', '--file', 'map.json'], world);
  return world;
}

describe('session and teach', () => {
  it('session start needs a map (exit 1) and a valid mode (exit 2)', async () => {
    const world = await makeWorld();
    expect((await runCli(['session', 'start', '--mode', 'learn'], world)).code).toBe(1);
    await runCli(['map', 'set', '--file', 'map.json'], world);
    expect((await runCli(['session', 'start', '--mode', 'cram'], world)).code).toBe(2);
    expect((await runCli(['session', 'start'], world)).code).toBe(2);
    const ok = await runCli(['session', 'start', '--mode', 'learn', '--json'], world);
    expect(ok.code).toBe(0);
    expect(ok.json()).toEqual({ sessionId: 's1', mode: 'learn', endedPrevious: null });
  });

  it('a second session start closes the first one', async () => {
    const world = await withMap();
    const first = (
      await runCli(['session', 'start', '--mode', 'learn', '--json'], world)
    ).json() as {
      sessionId: string;
    };
    const second = await runCli(['session', 'start', '--mode', 'interview', '--json'], world);
    expect(second.json()).toMatchObject({ endedPrevious: first.sessionId });
    const list = (await runCli(['session', 'list', '--json'], world)).json() as {
      id: string;
      endedAt: string | null;
      auto: boolean;
    }[];
    expect(list.find((s) => s.id === first.sessionId)).toMatchObject({ auto: true });
    expect(list.filter((s) => s.endedAt === null)).toHaveLength(1);
  });

  it('session list is newest first and exits 1 when there are no sessions', async () => {
    const world = await withMap();
    expect((await runCli(['session', 'list'], world)).code).toBe(1);
    await runCli(['session', 'start', '--mode', 'learn'], world);
    world.clock.advance(60_000);
    await runCli(['session', 'start', '--mode', 'interview'], world);
    const list = (await runCli(['session', 'list', '--json'], world)).json() as {
      id: string;
      summary: { sessionId: string; asked: number };
    }[];
    expect(list.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(list[0]?.summary).toMatchObject({ sessionId: 's2', asked: 0 });
  });

  it('session end with no open session exits 1', async () => {
    const world = await withMap();
    expect((await runCli(['session', 'end'], world)).code).toBe(1);
  });

  it('session end prints summary, areas and verdict as JSON', async () => {
    const world = await withMap();
    await runCli(['session', 'start', '--mode', 'interview'], world);
    const r = await runCli(['session', 'end', '--json'], world);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      summary: { sessionId: 's1', mode: 'interview', asked: 0 },
      areas: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      verdict: { kind: 'not_enough_evidence' },
    });
    expect((await runCli(['session', 'end'], world)).code).toBe(1);
    const status = (await runCli(['status', '--json'], world)).json() as {
      openSession: unknown;
      lastSession: { sessionId: string };
    };
    expect(status.openSession).toBeNull();
    expect(status.lastSession.sessionId).toBe('s1');
  });

  it('session end text leads with the summary in interview mode and the verdict in learn mode', async () => {
    const world = await withMap();
    await runCli(['session', 'start', '--mode', 'interview'], world);
    const interview = await runCli(['session', 'end'], world);
    expect(interview.out.indexOf('Session s1')).toBeLessThan(interview.out.indexOf('Verdict:'));
    await runCli(['session', 'start', '--mode', 'learn'], world);
    const learn = await runCli(['session', 'end'], world);
    expect(learn.out.indexOf('Verdict:')).toBeLessThan(learn.out.indexOf('Session s2'));
  });

  it('teach needs an open session and a known area (exit 2 otherwise) and records the branch and commit', async () => {
    const world = await withMap();
    expect((await runCli(['teach', '--area', 'a'], world)).code).toBe(2);
    await runCli(['session', 'start', '--mode', 'learn'], world);
    expect((await runCli(['teach', '--area', 'nope'], world)).code).toBe(2);
    expect((await runCli(['teach', '--area', 'a', '--principles', 'zzz'], world)).code).toBe(2);
    expect((await runCli(['teach'], world)).code).toBe(2);
    world.git.state.branch = 'feature';
    world.git.state.head = 'c9';
    const r = await runCli(['teach', '--area', 'a', '--principles', 'a-p1', '--json'], world);
    expect(r.code).toBe(0);
    const status = (await runCli(['status', '--json'], world)).json() as {
      stateDir: string;
    };
    const lines = (await readFile(join(status.stateDir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.at(-1)).toMatchObject({
      type: 'lesson',
      areaId: 'a',
      principleIds: ['a-p1'],
      sessionId: 's1',
      mode: 'learn',
      branch: 'feature',
      commit: 'c9',
      mapCommit: 'c1',
    });
  });
});
