import type { GitFacts } from '../src/core/deps.js';
import type { RepoState } from '../src/core/identity.js';
import type { LogEvent, StoredMap } from '../src/core/types.js';

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

export const map: StoredMap = {
  version: 1,
  repoKey: 'github.com/octo-org/hello-world',
  branch: 'main',
  commit: 'c1',
  setAt: '2026-01-01T00:00:00.000Z',
  areas: [],
};

export const repo: RepoState = {
  root: '/w',
  isGit: true,
  branch: 'main',
  commit: 'c1',
  dirty: false,
  key: 'github.com/octo-org/hello-world',
  dirName: 'github.com-octo-org-hello-world-00000000',
};

export function askEvent(overrides: Record<string, unknown> = {}): LogEvent {
  return {
    at: '2026-01-01T00:00:00.000Z',
    sessionId: 's1',
    mode: 'learn',
    branch: 'main',
    commit: 'c1',
    dirty: false,
    mapCommit: 'c1',
    type: 'ask',
    questionId: 'q1',
    areaId: 'a1',
    revision: 1,
    level: 'read',
    qtype: 'explain',
    principleIds: [],
    prompt: 'What does this do?',
    evidence: [],
    followUpOf: null,
    ...overrides,
  } as LogEvent;
}
