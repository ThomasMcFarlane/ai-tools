import { createHash } from 'node:crypto';
import type { GitFacts } from './deps.js';
import { DIR_SLUG_MAX } from './types.js';

export interface RepoState {
  root: string;
  isGit: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  key: string;
  dirName: string;
  candidates: string[];
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
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, '-')
    .slice(0, DIR_SLUG_MAX);
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `${slug}-${digest}`;
}

export function candidateKeys(facts: {
  path: string;
  top: string | null;
  origin: string | null;
  rootCommit: string | null;
}): string[] {
  if (facts.top === null) return [`path:${facts.path}`];
  const keys: string[] = [];
  if (facts.origin !== null && facts.origin.length > 0) keys.push(normaliseRemote(facts.origin));
  if (facts.rootCommit !== null) keys.push(`root:${facts.rootCommit}`);
  keys.push(`path:${facts.top}`);
  return keys;
}

function withKeys(
  state: Omit<RepoState, 'key' | 'dirName' | 'candidates'>,
  candidates: string[],
): RepoState {
  const key = candidates[0] ?? `path:${state.root}`;
  return { ...state, key, dirName: dirNameFor(key), candidates };
}

export async function readRepoState(path: string, git: GitFacts): Promise<RepoState> {
  const top = await git.toplevel(path);
  if (top === null) {
    return withKeys(
      { root: path, isGit: false, branch: null, commit: null, dirty: false },
      candidateKeys({ path, top, origin: null, rootCommit: null }),
    );
  }
  const [branch, commit, dirty, origin, rootCommit] = await Promise.all([
    git.branch(top),
    git.head(top),
    git.dirty(top),
    git.originUrl(top),
    git.rootCommit(top),
  ]);
  return withKeys(
    { root: top, isGit: true, branch, commit, dirty },
    candidateKeys({ path, top, origin, rootCommit }),
  );
}
