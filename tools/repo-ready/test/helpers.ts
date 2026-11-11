import type { GitFacts } from '../src/core/deps.js';
import type { RepoState } from '../src/core/identity.js';
import {
  QTYPES,
  type Area,
  type Level,
  type LogEvent,
  type MapInput,
  type Mode,
  type QType,
  type StoredMap,
} from '../src/core/types.js';

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

export function sampleMap(): MapInput {
  const area = (id: string, key: boolean, paths: string[], evidence: string): Area => ({
    id,
    title: `Area ${id}`,
    summary: `What area ${id} does.`,
    key,
    paths,
    revision: 1,
    principles: [
      {
        id: `${id}-p1`,
        statement: `Principle of area ${id}.`,
        reason: `Why area ${id} works this way.`,
        evidence: [evidence],
      },
    ],
  });
  return {
    areas: [
      area('a', true, ['src/a/**'], 'src/a/x.ts:1'),
      area('b', true, ['src/b/**'], 'src/b/x.ts:1'),
      area('c', false, ['docs/*.md'], 'docs/a.md:1'),
    ],
  };
}

export class LogBuilder {
  events: LogEvent[] = [];
  private time = new Date('2026-01-05T09:00:00.000Z').getTime();
  private sessionCount = 0;
  private questionCount = 0;
  private sessionId: string | null = null;
  private mode: Mode | null = null;
  private revisions = new Map<string, number>();

  private push(body: Record<string, unknown>, stepMs = 60_000): void {
    this.time += stepMs;
    this.events.push({
      at: new Date(this.time).toISOString(),
      sessionId: this.sessionId,
      mode: this.mode,
      branch: 'main',
      commit: 'c1',
      dirty: false,
      mapCommit: 'c1',
      ...body,
    } as LogEvent);
  }

  session(mode: Mode = 'learn'): this {
    this.sessionCount += 1;
    this.sessionId = `s${this.sessionCount}`;
    this.mode = mode;
    this.push({ type: 'session_start' });
    return this;
  }

  endSession(): this {
    this.push({ type: 'session_end', auto: false });
    this.sessionId = null;
    this.mode = null;
    return this;
  }

  q(
    areaId: string,
    level: Level,
    score: number | 'skip' | 'open',
    opts: {
      qtype?: QType;
      hints?: number;
      durationMs?: number;
      gaps?: string[];
      followUpOf?: string;
      prompt?: string;
    } = {},
  ): string {
    this.questionCount += 1;
    const questionId = `q${this.questionCount}`;
    const qtype = opts.qtype ?? QTYPES[level][0]!;
    this.push({
      type: 'ask',
      questionId,
      areaId,
      revision: this.revisions.get(areaId) ?? 1,
      level,
      qtype,
      principleIds: [],
      prompt: opts.prompt ?? `Question ${questionId}`,
      evidence: [],
      followUpOf: opts.followUpOf ?? null,
    });
    if (score === 'open') return questionId;
    if (score === 'skip') {
      this.push({ type: 'skip', questionId });
      return questionId;
    }
    for (let i = 0; i < (opts.hints ?? 0); i++) this.push({ type: 'hint', questionId });
    const durationMs = opts.durationMs ?? 60_000;
    this.push({ type: 'answer', questionId, text: 'An answer.', durationMs }, durationMs);
    this.push({ type: 'grade', questionId, score, notes: '', gaps: opts.gaps ?? [] });
    return questionId;
  }

  raise(areaId: string): this {
    const from = this.revisions.get(areaId) ?? 1;
    this.revisions.set(areaId, from + 1);
    this.push({
      type: 'map_set',
      changes: [{ kind: 'revision_raised', areaId, from, to: from + 1 }],
      forced: null,
    });
    return this;
  }
}
