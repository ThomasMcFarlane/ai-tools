import { afterEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/core/store.js';
import {
  defaultFiles,
  holdLevel,
  LogBuilder,
  makeWorld,
  removeWorlds,
  runCli,
  sampleMap,
  type CliWorld,
} from './helpers.js';

afterEach(removeWorlds);

const TRACKED = ['src/a/x.ts', 'src/b/x.ts', 'docs/a.md'];

function mapJson(change: (areas: ReturnType<typeof sampleMap>['areas']) => unknown[]): string {
  return JSON.stringify({ areas: change(sampleMap().areas) });
}

async function seed(world: CliWorld, log: LogBuilder): Promise<void> {
  const dir = ((await runCli(['status', '--json'], world)).json() as { stateDir: string }).stateDir;
  for (const event of log.events) await appendEvent(dir, event);
}

async function verdictKind(world: CliWorld): Promise<string> {
  return ((await runCli(['levels', '--json'], world)).json() as { verdict: { kind: string } })
    .verdict.kind;
}

function withoutB(): string {
  const m = sampleMap();
  return JSON.stringify({ areas: m.areas.filter((a) => a.id !== 'b') });
}

describe('status and map', () => {
  it('status with no map exits 1 and still prints the repository', async () => {
    const world = await makeWorld();
    const r = await runCli(['status', '--json'], world);
    expect(r.code).toBe(1);
    expect(r.json()).toMatchObject({
      repo: { key: 'github.com/octo-org/hello-world' },
      map: null,
      areas: [],
      verdict: null,
    });
  });

  it('status reports the map, areas and verdict once a map is set', async () => {
    const world = await makeWorld();
    await runCli(['map', 'set', '--file', 'map.json'], world);
    const r = await runCli(['status', '--json'], world);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      map: { commit: 'c1', areas: 3, behind: false },
      areas: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      verdict: { kind: 'not_enough_evidence' },
      openSession: null,
      lastSession: null,
    });
    world.git.state.head = 'c2';
    const behind = await runCli(['status', '--json'], world);
    expect(behind.json()).toMatchObject({ map: { behind: true } });
  });

  it('status text prints the label next to each level', async () => {
    const world = await makeWorld();
    await runCli(['map', 'set', '--file', 'map.json'], world);
    const r = await runCli(['status'], world);
    expect(r.out).toContain('Not yet ready');
    expect(r.out).toContain('Not enough evidence yet');
  });

  it('map set stores the map and stamps the commit', async () => {
    const world = await makeWorld();
    expect((await runCli(['map', 'set', '--file', 'map.json', '--json'], world)).code).toBe(0);
    expect((await runCli(['map', 'show', '--json'], world)).json()).toMatchObject({
      commit: 'c1',
      branch: 'main',
      areas: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    });
  });

  it('map set rejects a bad map with exit 2 and names every problem', async () => {
    const bad = JSON.stringify({ areas: [{ id: 'Bad Id', title: '', key: 'yes', paths: [] }] });
    const world = await makeWorld({ files: { ...defaultFiles(), 'bad.json': bad } });
    const r = await runCli(['map', 'set', '--file', 'bad.json'], world);
    expect(r.code).toBe(2);
    expect(r.error?.message).toContain('Bad Id');
    expect(r.error?.message).toContain('title must not be empty');
    expect(r.error?.message).toContain('key must be true or false');
    expect(r.error?.message).toContain('paths must list at least one');
    expect(r.error?.message.split('\n').length).toBeGreaterThan(4);
  });

  it('map set rejects evidence that points at a missing file', async () => {
    const files = defaultFiles();
    delete files['src/a/x.ts'];
    const world = await makeWorld({ files });
    const r = await runCli(['map', 'set', '--file', 'map.json'], world);
    expect(r.code).toBe(2);
    expect(r.error?.message).toContain('src/a/x.ts');
  });

  it('map set refuses to drop an untouched key area, and accepts it with --force --reason', async () => {
    const world = await makeWorld({
      git: { tracked: TRACKED },
      files: { ...defaultFiles(), 'without-b.json': withoutB() },
    });
    await runCli(['map', 'set', '--file', 'map.json'], world);
    expect((await runCli(['map', 'set', '--file', 'without-b.json'], world)).code).toBe(2);
    expect((await runCli(['map', 'set', '--file', 'without-b.json', '--force'], world)).code).toBe(
      2,
    );
    const r = await runCli(
      [
        'map',
        'set',
        '--file',
        'without-b.json',
        '--force',
        '--reason',
        'person asked for a redraw',
        '--json',
      ],
      world,
    );
    expect(r.json()).toMatchObject({
      changes: [{ kind: 'removed', areaId: 'b' }],
      forced: 'person asked for a redraw',
    });
  });

  it('map set prints revision_raised when files in the area changed', async () => {
    const raised = sampleMap();
    raised.areas[0]!.revision = 2;
    const world = await makeWorld({
      git: { tracked: TRACKED },
      files: { ...defaultFiles(), 'raised.json': JSON.stringify(raised) },
    });
    await runCli(['map', 'set', '--file', 'map.json'], world);
    world.git.state.head = 'c2';
    world.git.state.commits = ['c1', 'c2'];
    world.git.state.diffs = { 'c1..c2': ['src/a/x.ts'] };
    const r = await runCli(['map', 'set', '--file', 'raised.json', '--json'], world);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      changes: [{ kind: 'revision_raised', areaId: 'a', from: 1, to: 2 }],
      forced: null,
      map: { commit: 'c2' },
    });
  });

  it('map changes groups files after the repository moves to c2', async () => {
    const world = await makeWorld();
    await runCli(['map', 'set', '--file', 'map.json'], world);
    world.git.state.head = 'c2';
    world.git.state.commits = ['c1', 'c2'];
    world.git.state.diffs = { 'c1..c2': ['src/a/x.ts', 'README.md'] };
    const r = await runCli(['map', 'changes', '--json'], world);
    expect(r.json()).toMatchObject({
      comparable: true,
      from: 'c1',
      to: 'c2',
      areas: [{ id: 'a', files: ['src/a/x.ts'] }],
      unmapped: ['README.md'],
    });
  });

  it('works in a folder that is not a git repository', async () => {
    const world = await makeWorld({ git: { toplevel: null } });
    expect((await runCli(['map', 'set', '--file', 'map.json'], world)).code).toBe(0);
    expect((await runCli(['map', 'show', '--json'], world)).json()).toMatchObject({
      commit: null,
    });
    expect((await runCli(['map', 'changes', '--json'], world)).json()).toMatchObject({
      comparable: false,
    });
  });

  it('refuses to move a failing key area onto paths that match nothing, so it cannot then be dropped', async () => {
    const world = await makeWorld({
      files: {
        ...defaultFiles(),
        'a-nowhere.json': mapJson((areas) =>
          areas.map((a) => (a.id === 'a' ? { ...a, paths: ['nowhere/**'] } : a)),
        ),
        'without-a.json': mapJson((areas) => areas.filter((a) => a.id !== 'a')),
      },
    });
    await runCli(['map', 'set', '--file', 'map.json'], world);
    const log = new LogBuilder();
    log.session();
    log.q('a', 'read', 0);
    log.q('a', 'read', 1);
    log.q('b', 'read', 4);
    log.q('b', 'read', 4);
    log.endSession();
    await seed(world, log);
    expect(await verdictKind(world)).toBe('not_yet_ready');

    const step1 = await runCli(['map', 'set', '--file', 'a-nowhere.json'], world);
    expect(step1.code).toBe(2);
    expect(step1.error?.message).toContain('"a"');
    expect(step1.error?.message).toMatch(/match no tracked file/);
    const step2 = await runCli(['map', 'set', '--file', 'without-a.json'], world);
    expect(step2.code).toBe(2);
    expect(await verdictKind(world)).toBe('not_yet_ready');
  });

  it('refuses a first map whose area matches no tracked file, unless forced with a reason', async () => {
    const world = await makeWorld({
      files: {
        ...defaultFiles(),
        'folder.json': mapJson((areas) =>
          areas.map((a) => (a.id === 'a' ? { ...a, paths: ['src/a'] } : a)),
        ),
      },
    });
    const refused = await runCli(['map', 'set', '--file', 'folder.json'], world);
    expect(refused.code).toBe(2);
    expect(refused.error?.message).toContain('"a"');
    expect((await runCli(['status'], world)).code).toBe(1);
    const forced = await runCli(
      ['map', 'set', '--file', 'folder.json', '--force', '--reason', 'files come later', '--json'],
      world,
    );
    expect(forced.code).toBe(0);
    expect(forced.json()).toMatchObject({ forced: 'files come later' });
  });

  it('refuses to drop a failing key area when the map commit is gone, or outside git', async () => {
    for (const git of [{}, { toplevel: null }]) {
      const world = await makeWorld({
        git,
        files: {
          ...defaultFiles(),
          'without-a.json': mapJson((areas) => areas.filter((a) => a.id !== 'a')),
        },
      });
      await runCli(['map', 'set', '--file', 'map.json'], world);
      const log = new LogBuilder();
      log.session();
      log.q('a', 'read', 0);
      log.q('a', 'read', 1);
      log.q('b', 'read', 4);
      log.q('b', 'read', 4);
      log.endSession();
      await seed(world, log);
      world.git.state.head = 'c1-amended';
      world.git.state.commits = ['c1-amended'];
      const r = await runCli(['map', 'set', '--file', 'without-a.json'], world);
      expect(r.code).toBe(2);
      expect(r.error?.message).toContain('"a"');
      expect(await verdictKind(world)).toBe('not_yet_ready');
    }
  });

  describe('removing an area and adding it back', () => {
    async function heldThenDropped(): Promise<Awaited<ReturnType<typeof makeWorld>>> {
      const at = (revision: number): string =>
        mapJson((areas) => areas.map((a) => (a.id === 'a' ? { ...a, revision } : a)));
      const world = await makeWorld({
        files: {
          ...defaultFiles(),
          'without-a.json': mapJson((areas) => areas.filter((a) => a.id !== 'a')),
          'a-1.json': at(1),
          'a-2.json': at(2),
        },
      });
      await runCli(['map', 'set', '--file', 'map.json'], world);
      const log = new LogBuilder();
      log.session();
      holdLevel(log, 'a', 'maintain');
      holdLevel(log, 'b', 'read');
      log.endSession();
      await seed(world, log);
      world.git.state.head = 'c2';
      world.git.state.commits = ['c1', 'c2'];
      world.git.state.diffs = { 'c1..c2': ['src/a/x.ts'] };
      expect((await runCli(['map', 'set', '--file', 'without-a.json'], world)).code).toBe(0);
      return world;
    }

    async function areaA(world: CliWorld): Promise<Record<string, unknown> | undefined> {
      const levels = (await runCli(['levels', '--json'], world)).json() as {
        areas: Record<string, unknown>[];
      };
      return levels.areas.find((a) => a['id'] === 'a');
    }

    it('back at a higher revision, the area drops one level and is stale', async () => {
      const world = await heldThenDropped();
      const r = await runCli(['map', 'set', '--file', 'a-2.json', '--json'], world);
      expect(r.code).toBe(0);
      expect(r.json()).toMatchObject({
        changes: [{ kind: 'revision_raised', areaId: 'a', from: 1, to: 2 }],
      });
      expect(await areaA(world)).toMatchObject({
        level: 'read',
        stale: true,
        staleFrom: 'maintain',
        retired: false,
      });
    });

    it('back at the same revision, the area keeps its level with no stale mark', async () => {
      const world = await heldThenDropped();
      const r = await runCli(['map', 'set', '--file', 'a-1.json', '--json'], world);
      expect(r.code).toBe(0);
      expect(r.json()).toMatchObject({ changes: [{ kind: 'added', areaId: 'a' }] });
      expect(await areaA(world)).toMatchObject({ level: 'maintain', stale: false });
    });

    it('back at a lower revision is refused even with --force', async () => {
      const world = await heldThenDropped();
      expect((await runCli(['map', 'set', '--file', 'a-2.json'], world)).code).toBe(0);
      world.git.state.head = 'c3';
      world.git.state.commits = ['c1', 'c2', 'c3'];
      world.git.state.diffs = { 'c2..c3': ['src/a/x.ts'] };
      expect((await runCli(['map', 'set', '--file', 'without-a.json'], world)).code).toBe(0);
      const r = await runCli(
        ['map', 'set', '--file', 'a-1.json', '--force', '--reason', 'person asked'],
        world,
      );
      expect(r.code).toBe(2);
      expect(r.error?.message).toContain('"a"');
      expect(await areaA(world)).toMatchObject({ retired: true });
    });
  });

  describe('repository identity', () => {
    async function statusKey(world: CliWorld): Promise<{ code: number; key: string }> {
      const r = await runCli(['status', '--json'], world);
      return { code: r.code, key: (r.json() as { repo: { key: string } }).repo.key };
    }

    it('finds history made before the first commit and before origin was added', async () => {
      const world = await makeWorld({
        git: { head: null, branch: null, rootCommit: null, origin: null, commits: [] },
      });
      expect((await runCli(['map', 'set', '--file', 'map.json'], world)).code).toBe(0);
      expect(await statusKey(world)).toEqual({ code: 0, key: 'path:/w' });
      Object.assign(world.git.state, { head: 'c1', branch: 'main', rootCommit: 'r0' });
      world.git.state.commits = ['c1'];
      expect(await statusKey(world)).toEqual({ code: 0, key: 'path:/w' });
      world.git.state.origin = 'git@github.com:octo-org/hello-world.git';
      expect(await statusKey(world)).toEqual({ code: 0, key: 'path:/w' });
      expect((await runCli(['status'], world)).out).toContain('path:/w');
    });

    it('a repository seen for the first time uses the origin key', async () => {
      const world = await makeWorld();
      expect(await statusKey(world)).toEqual({
        code: 1,
        key: 'github.com/octo-org/hello-world',
      });
      await runCli(['map', 'set', '--file', 'map.json'], world);
      expect(await statusKey(world)).toEqual({
        code: 0,
        key: 'github.com/octo-org/hello-world',
      });
    });

    it('refuses a state folder inside the studied repository and writes nothing', async () => {
      const world = await makeWorld();
      world.stateRoot = '/w/.repo-ready-state';
      for (const args of [['status'], ['map', 'set', '--file', 'map.json']]) {
        const r = await runCli(args, world);
        expect(r.code).toBe(2);
        expect(r.error?.message).toMatch(/inside the studied repository/);
      }
      expect(world.written).toEqual({});
    });
  });
});
