import { afterEach, expect, it } from 'vitest';
import {
  defaultFiles,
  makeWorld,
  removeWorlds,
  runCli,
  sampleMap,
  type CliWorld,
} from './helpers.js';

interface AreaLevel {
  id: string;
  level: string;
  stale: boolean;
}
interface Ended {
  summary: Record<string, unknown>;
  verdict: Record<string, unknown>;
  areas: AreaLevel[];
}

afterEach(removeWorlds);

async function json<T = Record<string, unknown>>(world: CliWorld, args: string[]): Promise<T> {
  const r = await runCli([...args, '--json'], world);
  expect(r.error).toBeNull();
  expect(r.code).toBe(0);
  return r.json() as T;
}

async function exitsZero(world: CliWorld, args: string[]): Promise<string> {
  const r = await runCli(args, world);
  expect(r.error).toBeNull();
  expect(r.code).toBe(0);
  return r.out;
}

async function question(
  world: CliWorld & { clock: { advance(ms: number): void } },
  area: string,
  type: string,
  level: string,
  ms: number,
  score: number,
): Promise<void> {
  const asked = await json<{ questionId: string }>(world, [
    'ask',
    '--area',
    area,
    '--level',
    level,
    '--type',
    type,
    '--file',
    'prompt.txt',
    '--evidence',
    `src/${area}/x.ts:1`,
  ]);
  world.clock.advance(ms);
  await exitsZero(world, ['answer', asked.questionId, '--file', 'answer.txt']);
  await exitsZero(world, ['grade', asked.questionId, '--score', String(score)]);
}

it('drives a learn session, a revision rise and an interview session end to end', async () => {
  const map2 = sampleMap();
  map2.areas[0]!.revision = 2;
  const world = await makeWorld({
    files: {
      ...defaultFiles(),
      'map2.json': JSON.stringify(map2),
      'prompt.txt': 'What does this area do?',
      'answer.txt': 'It does this.',
    },
  });

  await exitsZero(world, ['map', 'set', '--file', 'map.json']);

  await exitsZero(world, ['session', 'start', '--mode', 'learn']);
  await question(world, 'a', 'explain', 'read', 40_000, 4);
  await question(world, 'a', 'trace', 'read', 60_000, 3);
  await question(world, 'b', 'explain', 'read', 40_000, 4);
  await question(world, 'b', 'trace', 'read', 60_000, 3);
  const learn = await json<Ended>(world, ['session', 'end']);
  expect(learn.summary).toMatchObject({ asked: 4, passed: 4, medianMs: 50_000 });
  expect(learn.verdict).toMatchObject({
    kind: 'level',
    level: 'read',
    label: 'Ready to be interviewed on it',
  });

  world.git.state.head = 'c2';
  world.git.state.commits.push('c2');
  world.git.state.diffs['c1..c2'] = ['src/a/x.ts'];
  const changes = await json(world, ['map', 'changes']);
  expect(JSON.stringify(changes)).toContain('"a"');
  const set = await json<{ changes: unknown[] }>(world, ['map', 'set', '--file', 'map2.json']);
  expect(set.changes).toContainEqual({ kind: 'revision_raised', areaId: 'a', from: 1, to: 2 });

  const levels = await json<{ areas: AreaLevel[]; verdict: { kind: string } }>(world, ['levels']);
  const byId = (id: string) => levels.areas.find((a) => a.id === id);
  expect(byId('a')).toMatchObject({ level: 'none', stale: true, staleFrom: 'read' });
  expect(byId('b')).toMatchObject({ level: 'read', stale: false });
  expect(levels.verdict.kind).toBe('not_enough_evidence');
  const next = await json<{ targets: Record<string, unknown>[] }>(world, ['next']);
  expect(next.targets[0]).toMatchObject({ areaId: 'a', level: 'read', reason: 'stale' });

  await exitsZero(world, ['session', 'start', '--mode', 'interview']);
  await question(world, 'a', 'explain', 'read', 30_000, 4);
  await question(world, 'a', 'trace', 'read', 30_000, 4);
  const interview = await json<Ended>(world, ['session', 'end']);
  expect(interview.areas.find((a) => a.id === 'a')).toMatchObject({
    level: 'read',
    stale: false,
  });
  expect(interview.verdict).toMatchObject({ kind: 'level', level: 'read' });

  const history = await json<{ commit: string }[]>(world, ['history']);
  expect(history).toHaveLength(6);
  expect(history.slice(0, 2).map((q) => q.commit)).toEqual(['c2', 'c2']);
  expect(history[5]?.commit).toBe('c1');

  const report = await exitsZero(world, ['report', '--format', 'text']);
  expect(report).toContain('Ready to be interviewed on it');
  for (const title of ['Area a', 'Area b', 'Area c']) expect(report).toContain(title);

  const timeline = await json<{ sessions: unknown[]; maps: { raised: string[] }[] }>(world, [
    'chart',
    'timeline',
    '--format',
    'json',
  ]);
  expect(timeline.sessions).toHaveLength(2);
  expect(timeline.maps).toHaveLength(2);
  expect(timeline.maps[1]?.raised).toEqual(['a']);
});
