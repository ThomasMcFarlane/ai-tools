import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realGit } from '../src/core/deps.js';

const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
let dir: string;

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd: dir,
    stdio: 'ignore',
  });
}

beforeAll(async () => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  dir = await realpath(await mkdtemp(join(tmpdir(), 'repo-ready-git-')));
});

afterAll(async () => {
  for (const [key, value] of [
    ['GIT_CONFIG_GLOBAL', saved.global],
    ['GIT_CONFIG_NOSYSTEM', saved.system],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(dir, { recursive: true, force: true });
});

describe('realGit', () => {
  const g = realGit();

  it('walks through the repository states in order', async () => {
    expect(await g.toplevel(dir)).toBeNull();

    git('init', '-q', '-b', 'main');
    expect(await g.toplevel(dir)).toBe(dir);
    expect(await g.head(dir)).toBeNull();
    expect(await g.branch(dir)).toBeNull();
    expect(await g.dirty(dir)).toBe(false);
    expect(await g.rootCommit(dir)).toBeNull();
    expect(await g.originUrl(dir)).toBeNull();

    await writeFile(join(dir, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'first');
    const first = await g.head(dir);
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await g.branch(dir)).toBe('main');
    expect(await g.hasCommit(dir, first as string)).toBe(true);
    expect(await g.hasCommit(dir, '0'.repeat(40))).toBe(false);
    expect(await g.trackedFiles(dir)).toEqual(['a.txt']);
    expect(await g.rootCommit(dir)).toBe(first);
    expect(await g.dirty(dir)).toBe(false);

    git('checkout', '-q', '--detach');
    expect(await g.branch(dir)).toBeNull();

    await writeFile(join(dir, 'b.txt'), 'two\n');
    expect(await g.dirty(dir)).toBe(true);
    git('add', 'b.txt');
    git('commit', '-q', '-m', 'second');
    const second = await g.head(dir);
    expect(await g.changedFiles(dir, first as string, second as string)).toEqual(['b.txt']);
  });

  it('returns special file names unquoted and exact', async () => {
    const before = await g.head(dir);
    await writeFile(join(dir, 'café.ts'), 'x\n');
    await writeFile(join(dir, 'with space.txt'), 'y\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'special names');
    const after = await g.head(dir);
    const expected = ['café.ts', 'with space.txt'];
    expect(await g.changedFiles(dir, before as string, after as string)).toEqual(expected);
    expect(await g.trackedFiles(dir)).toEqual(expect.arrayContaining(expected));
  });
});
