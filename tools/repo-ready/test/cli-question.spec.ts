import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QuestionRecord } from '../src/core/types.js';
import {
  defaultFiles,
  makeWorld,
  removeWorlds,
  runCli,
  sampleMap,
  type CliWorld,
} from './helpers.js';

afterEach(removeWorlds);

type World = Awaited<ReturnType<typeof makeWorld>>;

const DEFAULT_ASK = ['--area', 'a', '--level', 'read', '--type', 'explain'];

async function worldWithMap(mode: 'learn' | 'interview' | null = 'learn'): Promise<World> {
  const world = await makeWorld({
    files: {
      ...defaultFiles(),
      'prompt.txt': 'What does area a do?',
      'answer.txt': 'It does a.',
      'notes.txt': 'Good answer, missed locking.',
    },
  });
  await runCli(['map', 'set', '--file', 'map.json'], world);
  if (mode !== null) await runCli(['session', 'start', '--mode', mode], world);
  return world;
}

function askArgs(extra: string[]): string[] {
  return [
    'ask',
    ...DEFAULT_ASK,
    ...extra,
    '--file',
    'prompt.txt',
    ...(extra.includes('--evidence') ? [] : ['--evidence', 'src/a/x.ts:1']),
  ];
}

async function ok(world: CliWorld, args: string[]): Promise<string> {
  const r = await runCli(args, world);
  expect(r.error).toBeNull();
  expect(r.code).toBe(0);
  return r.out;
}

async function ask(world: CliWorld, extra: string[] = []): Promise<string> {
  const r = await runCli([...askArgs(extra), '--json'], world);
  expect(r.error).toBeNull();
  return (r.json() as { questionId: string }).questionId;
}

async function askCode(world: CliWorld, extra: string[]): Promise<number> {
  return (await runCli(askArgs(extra), world)).code;
}

async function history(world: CliWorld): Promise<(QuestionRecord & { retired: boolean })[]> {
  return (await runCli(['history', '--json'], world)).json() as (QuestionRecord & {
    retired: boolean;
  })[];
}

async function eventCount(world: CliWorld): Promise<number> {
  const status = (await runCli(['status', '--json'], world)).json() as { stateDir: string };
  const raw = await readFile(join(status.stateDir, 'events.jsonl'), 'utf8');
  return raw.split('\n').filter((l) => l.trim().length > 0).length;
}

async function askAnswerGrade(
  world: CliWorld,
  area: string,
  level: string,
  score: number,
  type = 'explain',
): Promise<string> {
  const id = await ask(world, ['--area', area, '--level', level, '--type', type]);
  await ok(world, ['answer', id, '--file', 'answer.txt']);
  await ok(world, ['grade', id, '--score', String(score)]);
  return id;
}

describe('question lifecycle', () => {
  it('ask, answer and grade record a timed, graded question', async () => {
    const world = await worldWithMap();
    const id = await ask(world, ['--area', 'a', '--level', 'read', '--type', 'explain']);
    world.clock.advance(45_000);
    await ok(world, ['answer', id, '--file', 'answer.txt']);
    await ok(world, ['grade', id, '--score', '4', '--gaps', 'locking,naming']);
    const q = (await history(world))[0];
    expect(q).toMatchObject({
      id,
      status: 'graded',
      durationMs: 45_000,
      score: 4,
      passed: true,
      gaps: ['locking', 'naming'],
      branch: 'main',
      commit: 'c1',
      sessionId: 's1',
      revision: 1,
      prompt: 'What does area a do?',
      evidence: ['src/a/x.ts:1'],
      answer: 'It does a.',
    });
  });

  it('prints the question id and the JSON shapes', async () => {
    const world = await worldWithMap();
    expect(await ok(world, askArgs([]))).toBe('q1');
    const asked = (await runCli([...askArgs([]), '--json'], world)).json();
    expect(asked).toEqual({ questionId: 'q2', askedAt: '2026-01-05T09:00:00.000Z' });
    world.clock.advance(2_000);
    expect(
      (await runCli(['answer', 'q2', '--file', 'answer.txt', '--json'], world)).json(),
    ).toEqual({ questionId: 'q2', durationMs: 2_000 });
    expect((await runCli(['grade', 'q2', '--score', '3', '--json'], world)).json()).toEqual({
      questionId: 'q2',
      score: 3,
      passed: true,
    });
    expect((await runCli(['hint', 'q1', '--json'], world)).json()).toEqual({
      questionId: 'q1',
      hints: 1,
    });
    expect((await runCli(['skip', 'q1', '--json'], world)).json()).toEqual({ questionId: 'q1' });
  });

  it('reads the prompt from standard input with --file -', async () => {
    const world = await worldWithMap();
    world.stdin = 'Prompt typed on standard input.';
    const r = await runCli(
      ['ask', ...DEFAULT_ASK, '--file', '-', '--evidence', 'src/a/x.ts:1', '--json'],
      world,
    );
    expect(r.code).toBe(0);
    expect((await history(world))[0]?.prompt).toBe('Prompt typed on standard input.');
  });

  it('records several --evidence values and principles', async () => {
    const world = await worldWithMap();
    await ok(world, [
      'ask',
      ...DEFAULT_ASK,
      '--file',
      'prompt.txt',
      '--evidence',
      'src/a/x.ts:1',
      '--evidence',
      'src/b/x.ts:7',
      '--principles',
      'a-p1,',
    ]);
    expect((await history(world))[0]).toMatchObject({
      evidence: ['src/a/x.ts:1', 'src/b/x.ts:7'],
      principleIds: ['a-p1'],
    });
  });

  it('ask accepts an evidence line range, as the map does, and still needs a line', async () => {
    const world = await worldWithMap();
    await ok(world, askArgs(['--evidence', 'src/a/x.ts:1-5']));
    expect((await history(world))[0]?.evidence).toEqual(['src/a/x.ts:1-5']);
    const before = await eventCount(world);
    expect(await askCode(world, ['--evidence', 'src/a/x.ts'])).toBe(2);
    expect(await eventCount(world)).toBe(before);
  });

  it('ask refuses evidence in a missing file or outside the path rules, and writes nothing', async () => {
    const world = await worldWithMap();
    const before = await eventCount(world);
    for (const evidence of ['src/a/missing.ts:1', './src/a/x.ts:1', '../x.ts:1', 'src\\a.ts:1']) {
      const r = await runCli(askArgs(['--evidence', evidence]), world);
      expect(r.code).toBe(2);
      expect(r.error?.message).toContain(evidence);
    }
    expect(await eventCount(world)).toBe(before);
  });

  it('recorded prompt, answer and notes lose trailing whitespace only', async () => {
    const world = await makeWorld({
      files: {
        ...defaultFiles(),
        'prompt.txt': '  Indented prompt,\n  second line.\n\n',
        'answer.txt': 'line one\nline two\n\n',
        'notes.txt': 'Notes here.\n',
      },
    });
    await runCli(['map', 'set', '--file', 'map.json'], world);
    await runCli(['session', 'start', '--mode', 'learn'], world);
    const id = await ask(world);
    await ok(world, ['answer', id, '--file', 'answer.txt']);
    await ok(world, ['grade', id, '--score', '3', '--file', 'notes.txt']);
    expect((await history(world))[0]).toMatchObject({
      prompt: '  Indented prompt,\n  second line.',
      answer: 'line one\nline two',
      notes: 'Notes here.',
    });
  });

  it('an answer of only whitespace is accepted and stored as empty', async () => {
    const world = await worldWithMap();
    const id = await ask(world);
    world.stdin = ' \n\t\n';
    await ok(world, ['answer', id, '--file', '-']);
    expect((await history(world))[0]).toMatchObject({ status: 'answered', answer: '' });
  });

  it('ask needs an open session', async () => {
    const world = await worldWithMap(null);
    const before = await eventCount(world);
    expect((await runCli(askArgs([]), world)).code).toBe(2);
    expect(await eventCount(world)).toBe(before);
  });

  it.each([
    [['--level', 'read', '--type', 'debug'], /debug.*maintain/],
    [['--area', 'nope'], /unknown area/],
    [['--level', 'expert'], /level/],
    [['--evidence', 'src/a/x.ts'], /path:line/],
    [['--principles', 'zzz'], /unknown principles/],
    [['--follow-up-of', 'q99'], /unknown question/],
  ])('ask rejects %j', async (extra, pattern) => {
    const world = await worldWithMap();
    const before = await eventCount(world);
    const r = await runCli(askArgs(extra), world);
    expect(r.code).toBe(2);
    expect(r.error?.message).toMatch(pattern);
    expect(await eventCount(world)).toBe(before);
  });

  it('ask rejects an empty prompt and a missing evidence list', async () => {
    const files = { ...defaultFiles(), 'empty.txt': '  \n', 'prompt.txt': 'A prompt.' };
    const empty = await makeWorld({ files });
    await runCli(['map', 'set', '--file', 'map.json'], empty);
    await runCli(['session', 'start', '--mode', 'learn'], empty);
    const before = await eventCount(empty);
    const blank = await runCli(
      ['ask', ...DEFAULT_ASK, '--file', 'empty.txt', '--evidence', 'src/a/x.ts:1'],
      empty,
    );
    expect(blank.code).toBe(2);
    expect(blank.error?.message).toMatch(/prompt/);
    const none = await runCli(['ask', ...DEFAULT_ASK, '--file', 'prompt.txt'], empty);
    expect(none.code).toBe(2);
    expect(none.error?.message).toMatch(/evidence/);
    expect(await eventCount(empty)).toBe(before);
  });

  it.each([
    ['answer twice', /already answered/],
    ['grade before answer', /not answered/],
    ['grade twice', /already graded/],
    ['hint after answer', /already answered/],
    ['skip after answer', /already answered/],
    ['answer an unknown id', /unknown question/],
    ['grade with score 5', /0 to 4/],
    ['grade with score 2.5', /0 to 4/],
  ])('%s exits 2 and writes nothing', async (name, pattern) => {
    const world = await worldWithMap();
    const id = await ask(world);
    const last = async (args: string[]) => {
      const before = await eventCount(world);
      const r = await runCli(args, world);
      expect(r.code).toBe(2);
      expect(r.error?.message).toMatch(pattern);
      expect(await eventCount(world)).toBe(before);
    };
    switch (name) {
      case 'answer twice':
        await ok(world, ['answer', id, '--file', 'answer.txt']);
        return last(['answer', id, '--file', 'answer.txt']);
      case 'grade before answer':
        return last(['grade', id, '--score', '3']);
      case 'grade twice':
        await ok(world, ['answer', id, '--file', 'answer.txt']);
        await ok(world, ['grade', id, '--score', '3']);
        return last(['grade', id, '--score', '3']);
      case 'hint after answer':
        await ok(world, ['answer', id, '--file', 'answer.txt']);
        return last(['hint', id]);
      case 'skip after answer':
        await ok(world, ['answer', id, '--file', 'answer.txt']);
        return last(['skip', id]);
      case 'answer an unknown id':
        return last(['answer', 'q99', '--file', 'answer.txt']);
      case 'grade with score 5':
        await ok(world, ['answer', id, '--file', 'answer.txt']);
        return last(['grade', id, '--score', '5']);
      default:
        await ok(world, ['answer', id, '--file', 'answer.txt']);
        return last(['grade', id, '--score', '2.5']);
    }
  });

  it('a skipped question cannot be hinted, answered, graded or skipped again', async () => {
    const world = await worldWithMap();
    const id = await ask(world);
    await ok(world, ['skip', id]);
    const before = await eventCount(world);
    for (const args of [
      ['hint', id],
      ['answer', id, '--file', 'answer.txt'],
      ['grade', id, '--score', '3'],
      ['skip', id],
    ]) {
      const r = await runCli(args, world);
      expect(r.code).toBe(2);
      expect(r.error?.message).toMatch(/skipped/);
    }
    expect(await eventCount(world)).toBe(before);
  });

  it('answer and grade need the files to be readable and write nothing otherwise', async () => {
    const world = await worldWithMap();
    const id = await ask(world);
    const before = await eventCount(world);
    expect((await runCli(['answer', id, '--file', 'missing.txt'], world)).code).toBe(2);
    expect((await runCli(['answer', id], world)).code).toBe(2);
    expect(await eventCount(world)).toBe(before);
  });

  it('grade reads notes from --file and defaults them to empty', async () => {
    const world = await worldWithMap();
    const a = await ask(world);
    const b = await ask(world);
    await ok(world, ['answer', a, '--file', 'answer.txt']);
    await ok(world, ['answer', b, '--file', 'answer.txt']);
    await ok(world, ['grade', a, '--score', '2', '--file', 'notes.txt']);
    await ok(world, ['grade', b, '--score', '3']);
    const byId = new Map((await history(world)).map((q) => [q.id, q]));
    expect(byId.get(a)).toMatchObject({ notes: 'Good answer, missed locking.', passed: false });
    expect(byId.get(b)).toMatchObject({ notes: '' });
  });

  it('hint is recorded in learn mode and refused in interview mode', async () => {
    const learn = await worldWithMap('learn');
    const id = await ask(learn);
    const out = await ok(learn, ['hint', id]);
    expect(out).toContain(id);
    expect((await history(learn))[0]?.hints).toBe(1);

    const interview = await worldWithMap('interview');
    const iid = await ask(interview);
    const before = await eventCount(interview);
    const r = await runCli(['hint', iid], interview);
    expect(r.code).toBe(2);
    expect(r.error?.message).toMatch(/not given in interview mode/);
    expect(await eventCount(interview)).toBe(before);
  });

  it('grade says so when a design change voided the question', async () => {
    const raised = sampleMap();
    const first = raised.areas[0];
    if (first === undefined) throw new Error('sample map has no area');
    first.revision = 2;
    const world = await makeWorld({
      files: {
        ...defaultFiles(),
        'prompt.txt': 'What does area a do?',
        'answer.txt': 'It does a.',
        'map2.json': JSON.stringify(raised),
      },
    });
    await ok(world, ['map', 'set', '--file', 'map.json']);
    await ok(world, ['session', 'start', '--mode', 'learn']);
    const id = await ask(world);
    await ok(world, ['answer', id, '--file', 'answer.txt']);
    world.git.state.head = 'c2';
    world.git.state.commits.push('c2');
    world.git.state.diffs['c1..c2'] = ['src/a/x.ts'];
    await ok(world, ['map', 'set', '--file', 'map2.json']);

    const json = await runCli(['grade', id, '--score', '4', '--json'], world);
    expect(json.code).toBe(0);
    expect(json.json()).toEqual({ questionId: id, score: 4, passed: false, voided: true });
    expect((await history(world))[0]).toMatchObject({ status: 'graded', voided: true });

    const other = await ask(world);
    await ok(world, ['answer', other, '--file', 'answer.txt']);
    const text = await runCli(['grade', other, '--score', '4'], world);
    expect(text.out).toContain('passed');
    expect(text.out).not.toContain('does not count');
  });

  it('grade text names a voided question as not counting', async () => {
    const raised = sampleMap();
    const first = raised.areas[0];
    if (first === undefined) throw new Error('sample map has no area');
    first.revision = 2;
    const world = await makeWorld({
      files: {
        ...defaultFiles(),
        'prompt.txt': 'What does area a do?',
        'answer.txt': 'It does a.',
        'map2.json': JSON.stringify(raised),
      },
    });
    await ok(world, ['map', 'set', '--file', 'map.json']);
    await ok(world, ['session', 'start', '--mode', 'learn']);
    const id = await ask(world);
    await ok(world, ['answer', id, '--file', 'answer.txt']);
    world.git.state.head = 'c2';
    world.git.state.commits.push('c2');
    world.git.state.diffs['c1..c2'] = ['src/a/x.ts'];
    await ok(world, ['map', 'set', '--file', 'map2.json']);

    const text = await runCli(['grade', id, '--score', '4'], world);
    expect(text.code).toBe(0);
    expect(text.out).toContain('does not count');
    expect(text.out).not.toMatch(/, passed\./);
  });

  it.each([
    ['none', /leave --gaps out/],
    ['n/a', /lower-case letters, digits and hyphens/],
    ['Bad Tag', /lower-case letters, digits and hyphens/],
  ])('grade refuses the gap tag %j and writes nothing', async (tag, pattern) => {
    const world = await worldWithMap();
    const id = await ask(world);
    await ok(world, ['answer', id, '--file', 'answer.txt']);
    const before = await eventCount(world);
    const r = await runCli(['grade', id, '--score', '4', '--gaps', tag], world);
    expect(r.code).toBe(2);
    expect(r.error?.message).toMatch(pattern);
    expect(await eventCount(world)).toBe(before);
  });

  it('a hinted answer is graded but does not pass', async () => {
    const world = await worldWithMap();
    const id = await ask(world);
    await ok(world, ['hint', id]);
    await ok(world, ['answer', id, '--file', 'answer.txt']);
    const r = await runCli(['grade', id, '--score', '4', '--json'], world);
    expect(r.json()).toEqual({ questionId: id, score: 4, passed: false });
    expect((await history(world))[0]).toMatchObject({ status: 'graded', hints: 1, passed: false });
  });

  it('a follow-up may be the same level or one above, in the same area, once per question', async () => {
    const world = await worldWithMap();
    const parent = await askAnswerGrade(world, 'a', 'read', 4);
    const base = (extra: string[]) => ['--follow-up-of', parent, ...extra];
    const before = await eventCount(world);
    expect(
      await askCode(world, ['--area', 'b', '--level', 'read', '--type', 'trace', ...base([])]),
    ).toBe(2);
    expect(
      await askCode(world, ['--area', 'a', '--level', 'rebuild', '--type', 'rebuild', ...base([])]),
    ).toBe(2);
    expect(await eventCount(world)).toBe(before);
    const child = await ask(world, [
      '--area',
      'a',
      '--level',
      'maintain',
      '--type',
      'predict',
      ...base([]),
    ]);
    expect(
      await askCode(world, ['--area', 'a', '--level', 'read', '--type', 'trace', ...base([])]),
    ).toBe(2);
    expect(
      await askCode(world, [
        '--area',
        'a',
        '--level',
        'maintain',
        '--type',
        'debug',
        '--follow-up-of',
        child,
      ]),
    ).toBe(2);
    expect((await history(world)).find((q) => q.id === child)?.followUpOf).toBe(parent);
  });

  it('a follow-up of an unanswered question is refused', async () => {
    const world = await worldWithMap();
    const parent = await ask(world);
    const before = await eventCount(world);
    const r = await runCli(askArgs(['--follow-up-of', parent]), world);
    expect(r.code).toBe(2);
    expect(r.error?.message).toMatch(/no answer/);
    expect(await eventCount(world)).toBe(before);
  });

  it('a follow-up must belong to the same session', async () => {
    const world = await worldWithMap();
    const parent = await askAnswerGrade(world, 'a', 'read', 4);
    await ok(world, ['session', 'start', '--mode', 'learn']);
    const before = await eventCount(world);
    const r = await runCli(askArgs(['--follow-up-of', parent]), world);
    expect(r.code).toBe(2);
    expect(r.error?.message).toMatch(/session/);
    expect(await eventCount(world)).toBe(before);
  });

  it('duration is never negative when the clock goes back', async () => {
    const world = await worldWithMap();
    const id = await ask(world);
    world.clock.advance(-10_000);
    const r = await runCli(['answer', id, '--file', 'answer.txt', '--json'], world);
    expect(r.json()).toEqual({ questionId: id, durationMs: 0 });
  });

  describe('a question from an ended session', () => {
    it('cannot be answered, hinted or skipped, and nothing is written', async () => {
      for (const command of ['answer', 'hint', 'skip']) {
        const world = await worldWithMap('learn');
        const id = await ask(world);
        await ok(world, ['session', 'end']);
        const before = await eventCount(world);
        const args = command === 'answer' ? [command, id, '--file', 'answer.txt'] : [command, id];
        const r = await runCli(args, world);
        expect(r.code).toBe(2);
        expect(r.error?.message).toMatch(/session .* has ended/);
        expect(await eventCount(world)).toBe(before);
      }
    });

    it('cannot be graded after a new session ended it, and nothing is written', async () => {
      const world = await worldWithMap('learn');
      const id = await ask(world);
      await ok(world, ['answer', id, '--file', 'answer.txt']);
      await ok(world, ['session', 'start', '--mode', 'learn']);
      const before = await eventCount(world);
      const r = await runCli(['grade', id, '--score', '4'], world);
      expect(r.code).toBe(2);
      expect(r.error?.message).toMatch(/session .* has ended/);
      expect(await eventCount(world)).toBe(before);
    });
  });

  it('grade drops repeated gap tags', async () => {
    const world = await worldWithMap('learn');
    const id = await ask(world);
    await ok(world, ['answer', id, '--file', 'answer.txt']);
    await ok(world, ['grade', id, '--score', '1', '--gaps', 'foo,foo, bar ,foo']);
    expect((await history(world))[0]?.gaps).toEqual(['foo', 'bar']);
  });
});
