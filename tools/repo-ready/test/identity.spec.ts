import { describe, expect, it } from 'vitest';
import { dirNameFor, normaliseRemote, readRepoState } from '../src/core/identity.js';
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
});
