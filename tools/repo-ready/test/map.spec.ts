import { describe, expect, it } from 'vitest';
import { readRepoState } from '../src/core/identity.js';
import {
  MapError,
  checkUpdate,
  diffMaps,
  mapChanges,
  revisionRecord,
  validateMap,
  type UpdateContext,
} from '../src/core/map.js';
import type { Area, MapInput, StoredMap } from '../src/core/types.js';
import { fakeGit, LogBuilder, sampleMap } from './helpers.js';

function clone(): MapInput {
  return structuredClone(sampleMap());
}
function first(map: MapInput): Area {
  const area = map.areas[0];
  if (area === undefined) throw new Error('no area');
  return area;
}
function problemsOf(input: unknown): string[] {
  try {
    validateMap(input);
  } catch (error) {
    if (error instanceof MapError) return error.problems;
    throw error;
  }
  return [];
}
function stored(commit: string | null): StoredMap {
  return {
    ...sampleMap(),
    version: 1,
    repoKey: 'github.com/octo-org/hello-world',
    branch: 'main',
    commit,
    setAt: '2026-01-01T00:00:00.000Z',
  };
}
function withArea(map: MapInput, id: string, patch: Partial<Area>): MapInput {
  return { areas: map.areas.map((a) => (a.id === id ? { ...a, ...patch } : a)) };
}

const prev = sampleMap();
const withAreaD: MapInput = {
  areas: [
    ...sampleMap().areas,
    { ...structuredClone(sampleMap().areas[0] as Area), id: 'd', paths: ['src/d/**'] },
  ],
};
const withoutB: MapInput = { areas: sampleMap().areas.filter((a) => a.id !== 'b') };
const prevWithA2 = withArea(sampleMap(), 'a', { revision: 2 });
const quiet: UpdateContext = {
  comparable: true,
  changedFiles: [],
  trackedFiles: ['src/a/x.ts', 'src/b/x.ts', 'docs/a.md'],
};

describe('validateMap', () => {
  it('accepts the sample map', () => expect(validateMap(sampleMap()).areas).toHaveLength(3));

  it('accepts one area and rejects none or eleven', () => {
    expect(validateMap({ areas: [first(sampleMap())] }).areas).toHaveLength(1);
    expect(problemsOf({ areas: [] }).join(' ')).toMatch(/1 to 10 areas/);
    const eleven = Array.from({ length: 11 }, (_v, i) => ({ ...first(clone()), id: `a${i}` }));
    expect(problemsOf({ areas: eleven }).join(' ')).toMatch(/1 to 10 areas/);
  });

  it('rejects shapes that are not a map', () => {
    expect(problemsOf(null)).toHaveLength(1);
    expect(problemsOf([])).toHaveLength(1);
    expect(problemsOf({ areas: 'x' })).toHaveLength(1);
  });

  it('returns only the known fields', () => {
    const noisy = clone() as MapInput & Record<string, unknown>;
    noisy['extra'] = 1;
    (first(noisy) as Area & Record<string, unknown>)['extra'] = 2;
    expect(validateMap(noisy)).toEqual(sampleMap());
  });

  const bad: [string, (m: MapInput) => void, RegExp][] = [
    [
      'duplicate area id',
      (m) => {
        (m.areas[1] as Area).id = 'a';
      },
      /duplicate area id/,
    ],
    [
      'id "Not A Slug"',
      (m) => {
        first(m).id = 'Not A Slug';
      },
      /slug/,
    ],
    [
      'no key area',
      (m) => {
        m.areas.forEach((a) => {
          a.key = false;
        });
      },
      /at least one key area/,
    ],
    [
      'empty paths',
      (m) => {
        first(m).paths = [];
      },
      /paths/,
    ],
    [
      'no principles',
      (m) => {
        first(m).principles = [];
      },
      /principle/,
    ],
    [
      'evidence "src/a.ts"',
      (m) => {
        (first(m).principles[0] as Area['principles'][number]).evidence = ['src/a.ts'];
      },
      /path:line/,
    ],
    [
      'revision 0',
      (m) => {
        first(m).revision = 0;
      },
      /revision/,
    ],
    [
      'revision 1.5',
      (m) => {
        first(m).revision = 1.5;
      },
      /revision/,
    ],
    [
      'empty title',
      (m) => {
        first(m).title = '';
      },
      /title/,
    ],
  ];
  it.each(bad)('rejects %s', (_case, mutate, pattern) => {
    const map = clone();
    mutate(map);
    expect(() => validateMap(map)).toThrow(MapError);
    expect(problemsOf(map).join(' ')).toMatch(pattern);
  });

  const badPaths: [string, (m: MapInput) => void][] = [
    ['an absolute area path', (m) => void (first(m).paths = ['/src/a/**'])],
    ['an area path starting with ./', (m) => void (first(m).paths = ['./src/a/**'])],
    ['an area path with a .. segment', (m) => void (first(m).paths = ['src/../a/**'])],
    ['an area path that is only ..', (m) => void (first(m).paths = ['..'])],
    ['an area path with a backslash', (m) => void (first(m).paths = ['src\\a\\**'])],
    [
      'an absolute evidence path',
      (m) => void ((first(m).principles[0] as Area['principles'][number]).evidence = ['/a.ts:1']),
    ],
    [
      'an evidence path starting with ./',
      (m) =>
        void ((first(m).principles[0] as Area['principles'][number]).evidence = ['./src/a/x.ts:1']),
    ],
    [
      'an evidence path with a .. segment',
      (m) =>
        void ((first(m).principles[0] as Area['principles'][number]).evidence = ['src/../x.ts:1']),
    ],
    [
      'an evidence path with a backslash',
      (m) =>
        void ((first(m).principles[0] as Area['principles'][number]).evidence = ['src\\a.ts:1']),
    ],
  ];
  it.each(badPaths)('rejects %s', (_case, mutate) => {
    const map = clone();
    mutate(map);
    expect(() => validateMap(map)).toThrow(MapError);
    expect(problemsOf(map).join(' ')).toMatch(/relative to the repository root/);
  });

  it('names an area with an invalid id by its position', () => {
    const map = clone();
    const second = map.areas[1] as Area;
    second.id = '';
    second.title = '';
    const problems = problemsOf(map);
    expect(problems).toContain('area #2: title must not be empty');
    expect(problems.some((p) => p.startsWith('area #2: id ""'))).toBe(true);
    expect(problems.join(' ')).not.toContain('area ""');
  });

  it('reports every problem at once', () => {
    const map = clone();
    first(map).title = '';
    first(map).revision = 0;
    expect(problemsOf(map)).toHaveLength(2);
  });
});

describe('diffMaps', () => {
  it('reports added, removed, key_set, key_cleared and revision_raised with from and to', () => {
    const before = withArea(withArea(sampleMap(), 'a', { key: false }), 'c', { key: true });
    const after: MapInput = {
      areas: [
        ...withArea(
          withArea(withArea(sampleMap(), 'a', { key: true, revision: 3 }), 'c', { key: false }),
          'b',
          {},
        ).areas.filter((a) => a.id !== 'b'),
        { ...structuredClone(first(sampleMap())), id: 'd' },
      ],
    };
    expect(diffMaps(before, after)).toEqual([
      { kind: 'key_set', areaId: 'a' },
      { kind: 'revision_raised', areaId: 'a', from: 1, to: 3 },
      { kind: 'key_cleared', areaId: 'c' },
      { kind: 'added', areaId: 'd' },
      { kind: 'removed', areaId: 'b' },
    ]);
  });

  it('reports every area as added against no previous map', () => {
    expect(diffMaps(null, sampleMap()).map((c) => [c.kind, c.areaId])).toEqual([
      ['added', 'a'],
      ['added', 'b'],
      ['added', 'c'],
    ]);
  });

  it('reports nothing for identical maps', () => expect(diffMaps(prev, sampleMap())).toEqual([]));
});

describe('revisionRecord', () => {
  it('keeps the highest revision seen per area in asks and revision rises', () => {
    const log = new LogBuilder();
    log.session();
    log.q('a', 'read', 4);
    log.raise('a');
    log.raise('a');
    log.q('b', 'read', 4);
    log.raise('b');
    expect(revisionRecord(log.events)).toEqual(
      new Map([
        ['a', 3],
        ['b', 2],
      ]),
    );
    expect(revisionRecord([])).toEqual(new Map());
  });
});

describe('diffMaps against the revision record', () => {
  const record = new Map([['b', 2]]);
  const atB = (revision: number): MapInput => withArea(sampleMap(), 'b', { revision });

  it('reports an area re-added above its record as a revision rise from the record', () =>
    expect(diffMaps(withoutB, atB(3), record)).toEqual([
      { kind: 'revision_raised', areaId: 'b', from: 2, to: 3 },
    ]));

  it('reports an area re-added at its record, or with no record, as added', () => {
    expect(diffMaps(withoutB, atB(2), record)).toEqual([{ kind: 'added', areaId: 'b' }]);
    expect(diffMaps(withoutB, atB(3), new Map())).toEqual([{ kind: 'added', areaId: 'b' }]);
  });

  it('refuses, without force, an area re-added below its record', () => {
    expect(checkUpdate(withoutB, atB(1), { ...quiet, revisions: record }).blocking).toEqual([
      expect.stringContaining('"b"'),
    ]);
    expect(checkUpdate(withoutB, atB(2), { ...quiet, revisions: record }).blocking).toEqual([]);
  });
});

describe('checkUpdate', () => {
  it('adding an area is always allowed', () =>
    expect(
      checkUpdate(prev, withAreaD, {
        ...quiet,
        trackedFiles: [...(quiet.trackedFiles ?? []), 'src/d/x.ts'],
      }),
    ).toEqual({ blocking: [], forceable: [] }));

  it('removing an untouched area needs force', () => {
    const r = checkUpdate(prev, withoutB, quiet);
    expect(r.forceable).toHaveLength(1);
    expect(r.forceable[0]).toContain('b');
    expect(r.blocking).toEqual([]);
  });

  it('removing an area whose files changed is allowed', () =>
    expect(
      checkUpdate(prev, withoutB, { ...quiet, changedFiles: ['src/b/x.ts'] }).forceable,
    ).toEqual([]));

  it('removing an area whose paths match no tracked file is allowed', () =>
    expect(
      checkUpdate(prev, withoutB, { ...quiet, trackedFiles: ['src/a/x.ts', 'docs/a.md'] })
        .forceable,
    ).toEqual([]));

  it('clearing key follows the same rule as removal', () => {
    const cleared = withArea(sampleMap(), 'b', { key: false });
    expect(checkUpdate(prev, cleared, quiet).forceable).toHaveLength(1);
    expect(
      checkUpdate(prev, cleared, { ...quiet, changedFiles: ['src/b/x.ts'] }).forceable,
    ).toEqual([]);
    const gone = checkUpdate(prev, cleared, {
      ...quiet,
      trackedFiles: ['src/a/x.ts', 'docs/a.md'],
    }).forceable;
    expect(gone.filter((p) => p.includes('stop being a key area'))).toEqual([]);
  });

  it('raising a revision needs a changed file in that area, or force', () => {
    const raised = withArea(sampleMap(), 'a', { revision: 2 });
    expect(checkUpdate(prev, raised, quiet).forceable).toHaveLength(1);
    expect(
      checkUpdate(prev, raised, { ...quiet, changedFiles: ['src/b/x.ts'] }).forceable,
    ).toHaveLength(1);
    expect(checkUpdate(prev, raised, { ...quiet, changedFiles: ['src/a/x.ts'] }).forceable).toEqual(
      [],
    );
  });

  it('judges a revision rise against the union of the previous and next paths', () => {
    const raised = withArea(sampleMap(), 'a', { revision: 2, paths: ['lib/a/**'] });
    const moved = { ...quiet, trackedFiles: ['lib/a/y.ts', 'src/b/x.ts', 'docs/a.md'] };
    expect(checkUpdate(prev, raised, { ...moved, changedFiles: ['lib/a/y.ts'] }).forceable).toEqual(
      [],
    );
    expect(checkUpdate(prev, raised, { ...moved, changedFiles: ['src/a/x.ts'] }).forceable).toEqual(
      [],
    );
  });

  it('lowering a revision is blocking and cannot be forced', () =>
    expect(checkUpdate(prevWithA2, sampleMap(), quiet).blocking).toHaveLength(1));

  describe('when the commits cannot be compared', () => {
    const unknown: UpdateContext = { ...quiet, comparable: false };
    const cleared = withArea(sampleMap(), 'b', { key: false });

    it('removal and key clearing of an area that still has tracked files need force', () => {
      expect(checkUpdate(prev, withoutB, unknown)).toEqual({
        blocking: [],
        forceable: [expect.stringContaining('"b"')],
      });
      expect(checkUpdate(prev, cleared, unknown)).toEqual({
        blocking: [],
        forceable: [expect.stringContaining('"b"')],
      });
    });

    it('ignores any changed-file list it is given', () =>
      expect(
        checkUpdate(prev, withoutB, { ...unknown, changedFiles: ['src/b/x.ts'] }).forceable,
      ).toHaveLength(1));

    it('removal is allowed when the area matches no tracked file', () =>
      expect(
        checkUpdate(prev, withoutB, { ...unknown, trackedFiles: ['src/a/x.ts', 'docs/a.md'] }),
      ).toEqual({ blocking: [], forceable: [] }));

    it('a revision rise is allowed', () =>
      expect(checkUpdate(prev, withArea(sampleMap(), 'a', { revision: 2 }), unknown)).toEqual({
        blocking: [],
        forceable: [],
      }));

    it('a lowered revision is still blocking', () =>
      expect(checkUpdate(prevWithA2, sampleMap(), unknown).blocking).toHaveLength(1));
  });

  it('outside a git repository every removal and key clear needs force', () => {
    const noGit: UpdateContext = { comparable: false, changedFiles: [], trackedFiles: null };
    expect(checkUpdate(prev, withoutB, noGit).forceable).toHaveLength(1);
    expect(
      checkUpdate(prev, withArea(sampleMap(), 'b', { key: false }), noGit).forceable,
    ).toHaveLength(1);
    expect(checkUpdate(prev, withArea(sampleMap(), 'a', { revision: 2 }), noGit)).toEqual({
      blocking: [],
      forceable: [],
    });
  });
});

describe('checkUpdate: paths must match a tracked file', () => {
  const nowhere = withArea(sampleMap(), 'a', { paths: ['nowhere/**'] });

  it('a first map with an area that matches no tracked file needs force', () => {
    const r = checkUpdate(null, nowhere, quiet);
    expect(r.blocking).toEqual([]);
    expect(r.forceable).toHaveLength(1);
    expect(r.forceable[0]).toContain('"a"');
  });

  it('changing an existing area to paths that match no tracked file needs force', () => {
    const r = checkUpdate(prev, nowhere, quiet);
    expect(r.forceable).toHaveLength(1);
    expect(r.forceable[0]).toContain('"a"');
  });

  it('a folder path without /** is caught', () => {
    const folder = withArea(sampleMap(), 'a', { paths: ['src/a'] });
    expect(checkUpdate(null, folder, quiet).forceable).toHaveLength(1);
  });

  it('is not applied without a list of tracked files', () => {
    expect(checkUpdate(null, nowhere, { ...quiet, trackedFiles: null }).forceable).toEqual([]);
    expect(checkUpdate(null, nowhere, { ...quiet, trackedFiles: [] }).forceable).toEqual([]);
  });
});

describe('mapChanges', () => {
  it('groups changed files by area and lists the rest as unmapped', async () => {
    const git = fakeGit({
      toplevel: '/w',
      head: 'c2',
      commits: ['c1', 'c2'],
      diffs: { 'c1..c2': ['src/a/x.ts', 'README.md'] },
    });
    const r = await mapChanges(stored('c1'), await readRepoState('/w', git), git);
    expect(r).toMatchObject({
      comparable: true,
      from: 'c1',
      to: 'c2',
      areas: [{ id: 'a', files: ['src/a/x.ts'] }],
      unmapped: ['README.md'],
    });
  });

  it('is comparable with nothing to list when the map commit is the current commit', async () => {
    const git = fakeGit({ head: 'c1', dirty: true });
    const r = await mapChanges(stored('c1'), await readRepoState('/w', git), git);
    expect(r).toMatchObject({ comparable: true, areas: [], unmapped: [], dirty: true });
  });

  it('lets a file appear under more than one area and lists only changed areas', async () => {
    const overlapping: StoredMap = {
      ...stored('c1'),
      areas: sampleMap().areas.map((a) => (a.id === 'b' ? { ...a, paths: ['src/**'] } : a)),
    };
    const git = fakeGit({ head: 'c2', commits: ['c1', 'c2'], diffs: { 'c1..c2': ['src/a/x.ts'] } });
    const r = await mapChanges(overlapping, await readRepoState('/w', git), git);
    expect(r.areas.map((a) => a.id)).toEqual(['a', 'b']);
    expect(r.unmapped).toEqual([]);
  });

  it('cannot compare when the repository has no commits but the map has one', async () => {
    const git = fakeGit({ head: null, branch: null, rootCommit: null, commits: [] });
    const r = await mapChanges(stored('c1'), await readRepoState('/w', git), git);
    expect(r).toMatchObject({
      comparable: false,
      reason: 'The repository has no commits yet, so there is nothing to compare.',
      from: 'c1',
      to: null,
      areas: [],
      unmapped: [],
    });
  });

  it('cannot compare when the map commit is gone, the map has no commit, or the folder is not a repository', async () => {
    const gone = fakeGit({ head: 'c2', commits: ['c2'] });
    const noCommit = fakeGit({ head: 'c2', commits: ['c2'] });
    const notRepo = fakeGit({ toplevel: null });
    const cases: [StoredMap, ReturnType<typeof fakeGit>][] = [
      [stored('c1'), gone],
      [stored(null), noCommit],
      [stored('c1'), notRepo],
    ];
    for (const [map, git] of cases) {
      const r = await mapChanges(map, await readRepoState('/w', git), git);
      expect(r.comparable).toBe(false);
      expect(r.reason).toMatch(/\S/);
      expect(r.areas).toEqual([]);
    }
  });
});
