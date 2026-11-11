import { createHash } from 'node:crypto';
import type { GitFacts } from './deps.js';

export interface RepoState {
  root: string;
  isGit: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  key: string;
  dirName: string;
}

export function normaliseRemote(url: string): string {
  let rest = url.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rest);
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  rest = rest.replace(/^[^@/]*@/, '');
  if (hasScheme) {
    rest = rest.replace(/^([^/:]+):\d+(?=\/|$)/, '$1');
  } else {
    rest = rest.replace(':', '/');
  }
  rest = rest
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return rest.toLowerCase();
}

export function dirNameFor(key: string): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9.]/g, '-');
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `${slug}-${digest}`;
}

export async function readRepoState(path: string, git: GitFacts): Promise<RepoState> {
  const top = await git.toplevel(path);
  if (top === null) {
    const key = `path:${path}`;
    return {
      root: path,
      isGit: false,
      branch: null,
      commit: null,
      dirty: false,
      key,
      dirName: dirNameFor(key),
    };
  }
  const [branch, commit, dirty, origin, rootCommit] = await Promise.all([
    git.branch(top),
    git.head(top),
    git.dirty(top),
    git.originUrl(top),
    git.rootCommit(top),
  ]);
  const key =
    origin !== null && origin.length > 0
      ? normaliseRemote(origin)
      : rootCommit !== null
        ? `root:${rootCommit}`
        : `path:${top}`;
  return { root: top, isGit: true, branch, commit, dirty, key, dirName: dirNameFor(key) };
}
