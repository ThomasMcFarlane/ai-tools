import { describe, expect, it } from 'vitest';
import { candidateKeys, dirNameFor, normaliseRemote, readRepoState } from '../src/core/identity.js';
import { fakeGit } from './helpers.js';

describe('repository identity', () => {
  it.each([
    ['https://github.com/Octo-Org/Hello-World.git', 'github.com/octo-org/hello-world'],
    ['git@github.com:octo-org/hello-world.git', 'github.com/octo-org/hello-world'],
    ['ssh://git@example.com:2222/octo-org/hello-world/', 'example.com/octo-org/hello-world'],
    ['https://user:secret@example.com/octo-org/hello-world', 'example.com/octo-org/hello-world'],
  ])('normaliseRemote(%s)', (url, key) => expect(normaliseRemote(url)).toBe(key));

  it('dirNameFor is a safe slug plus 8 hex characters', () => {
    expect(dirNameFor('github.com/octo-org/hello-world')).toMatch(
      /^github\.com-octo-org-hello-world-[0-9a-f]{8}$/,
    );
  });

  it('two clones and a subfolder share one key', async () => {
    const a = await readRepoState(
      '/work/a/src',
      fakeGit({ toplevel: '/work/a', origin: 'git@github.com:octo-org/hello-world.git' }),
    );
    const b = await readRepoState(
      '/work/b',
      fakeGit({ toplevel: '/work/b', origin: 'https://github.com/octo-org/hello-world' }),
    );
    expect(a.root).toBe('/work/a');
    expect(a.dirName).toBe(b.dirName);
  });

  it('falls back to the root commit, then to the path', async () => {
    expect(
      (await readRepoState('/w', fakeGit({ toplevel: '/w', origin: null, rootCommit: 'abc123' })))
        .key,
    ).toBe('root:abc123');
    const plain = await readRepoState('/plain', fakeGit({ toplevel: null }));
    expect(plain).toMatchObject({
      isGit: false,
      root: '/plain',
      branch: null,
      commit: null,
      dirty: false,
      key: 'path:/plain',
    });
  });

  it('records null branch and commit when there are no commits or HEAD is detached', async () => {
    const s = await readRepoState(
      '/w',
      fakeGit({ toplevel: '/w', head: null, branch: null, origin: null, rootCommit: null }),
    );
    expect(s).toMatchObject({ isGit: true, branch: null, commit: null, key: 'path:/w' });
  });

  it('candidateKeys lists origin, root commit and path, each only when available', () => {
    expect(
      candidateKeys({
        path: '/w/src',
        top: '/w',
        origin: 'git@github.com:octo-org/hello-world.git',
        rootCommit: 'r0',
      }),
    ).toEqual(['github.com/octo-org/hello-world', 'root:r0', 'path:/w']);
    expect(candidateKeys({ path: '/w', top: '/w', origin: null, rootCommit: 'r0' })).toEqual([
      'root:r0',
      'path:/w',
    ]);
    expect(candidateKeys({ path: '/w', top: '/w', origin: '', rootCommit: null })).toEqual([
      'path:/w',
    ]);
    expect(candidateKeys({ path: '/plain', top: null, origin: null, rootCommit: null })).toEqual([
      'path:/plain',
    ]);
  });

  it('readRepoState keeps the candidates and uses the first as the default key', async () => {
    const s = await readRepoState('/w', fakeGit({ toplevel: '/w' }));
    expect(s.candidates).toEqual(['github.com/octo-org/hello-world', 'root:r0', 'path:/w']);
    expect(s.key).toBe('github.com/octo-org/hello-world');
  });

  it('dirNameFor keeps a very long key to at most 89 characters', () => {
    const name = dirNameFor(`example.com/${'very-long-name/'.repeat(30)}hello-world`);
    expect(name.length).toBeLessThanOrEqual(89);
    expect(name).toMatch(/-[0-9a-f]{8}$/);
    expect(dirNameFor('a'.repeat(200))).not.toBe(dirNameFor(`${'a'.repeat(199)}b`));
  });
});
