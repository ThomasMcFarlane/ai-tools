import type { GitFacts } from '../src/core/deps.js';

export interface FakeGitState {
  toplevel: string | null;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  origin: string | null;
  rootCommit: string | null;
  commits: string[];
  diffs: Record<string, string[]>;
  tracked: string[];
}

export function fakeGit(state: Partial<FakeGitState> = {}): GitFacts & { state: FakeGitState } {
  const s: FakeGitState = {
    toplevel: '/w',
    branch: 'main',
    head: 'c1',
    dirty: false,
    origin: 'git@github.com:octo-org/hello-world.git',
    rootCommit: 'r0',
    commits: ['c1'],
    diffs: {},
    tracked: [],
    ...state,
  };
  return {
    state: s,
    toplevel: async () => s.toplevel,
    branch: async () => s.branch,
    head: async () => s.head,
    dirty: async () => s.dirty,
    originUrl: async () => s.origin,
    rootCommit: async () => s.rootCommit,
    hasCommit: async (_root, sha) => s.commits.includes(sha),
    changedFiles: async (_root, from, to) => s.diffs[`${from}..${to}`] ?? [],
    trackedFiles: async () => s.tracked,
  };
}

export function clock(startIso: string): { now(): Date; advance(ms: number): void } {
  let t = new Date(startIso).getTime();
  return {
    now: () => new Date(t),
    advance(ms) {
      t += ms;
    },
  };
}
