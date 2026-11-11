import { afterEach, describe, expect, it } from 'vitest';
import { defaultFiles, makeWorld, removeWorlds, runCli, sampleMap } from './helpers.js';

afterEach(removeWorlds);

const TRACKED = ['src/a/x.ts', 'src/b/x.ts', 'docs/a.md'];

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
});
