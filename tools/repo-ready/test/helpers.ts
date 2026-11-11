import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli/index.js';
import type { Deps, GitFacts } from '../src/core/deps.js';
import type { RepoState } from '../src/core/identity.js';
import {
  LEVELS,
  NotFoundError,
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
    tracked: ['src/a/x.ts', 'src/b/x.ts', 'docs/a.md'],
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
  candidates: ['github.com/octo-org/hello-world', 'root:r0', 'path:/w'],
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

export function holdLevel(log: LogBuilder, areaId: string, level: Level): void {
  for (const lv of LEVELS) {
    log.q(areaId, lv, 4);
    log.q(areaId, lv, 4);
    if (lv === level) break;
  }
}

export interface CliWorld {
  git: GitFacts;
  clock: { now(): Date };
  stateRoot: string;
  files?: Record<string, string>;
  stdin?: string;
  written?: Record<string, string>;
}

export interface CliResult {
  out: string;
  json(): unknown;
  error: Error | null;
  code: 0 | 1 | 2;
}

const REPO_ROOT = '/w';
const idCounters = new WeakMap<object, Record<string, number>>();

export function defaultFiles(): Record<string, string> {
  return {
    'src/a/x.ts': 'a\n',
    'src/b/x.ts': 'b\n',
    'docs/a.md': 'c\n',
    'map.json': JSON.stringify(sampleMap()),
  };
}

function relativeToRoot(path: string): string {
  return path.startsWith(`${REPO_ROOT}/`) ? path.slice(REPO_ROOT.length + 1) : path;
}

export async function runCli(args: string[], world: CliWorld): Promise<CliResult> {
  const files = world.files ?? defaultFiles();
  const counters = idCounters.get(world) ?? {};
  idCounters.set(world, counters);
  const lines: string[] = [];
  const written = (world.written ??= {});
  const deps: Partial<Deps> = {
    now: () => world.clock.now(),
    git: world.git,
    stateRoot: () => world.stateRoot,
    newId(prefix) {
      counters[prefix] = (counters[prefix] ?? 0) + 1;
      return `${prefix}${counters[prefix]}`;
    },
    async fileExists(absPath) {
      if (!absPath.startsWith(world.stateRoot)) return relativeToRoot(absPath) in files;
      return access(absPath).then(
        () => true,
        () => false,
      );
    },
    async readText(source) {
      if (source === '-') return world.stdin ?? '';
      const text = files[relativeToRoot(source)];
      if (text === undefined) throw new Error(`ENOENT: ${source}`);
      return text;
    },
    async writeText(absPath, text) {
      written[absPath] = text;
    },
    print: (text) => {
      lines.push(text);
    },
  };
  const withRepo = args.includes('--repo') ? args : ['--repo', REPO_ROOT, ...args];
  let error: Error | null = null;
  try {
    await run(['node', 'repo-ready', ...withRepo], deps);
  } catch (thrown) {
    error = thrown instanceof Error ? thrown : new Error(String(thrown));
  }
  const out = lines.join('\n');
  return {
    out,
    json: () => JSON.parse(out) as unknown,
    error,
    code: error === null ? 0 : error instanceof NotFoundError ? 1 : 2,
  };
}

const stateRoots: string[] = [];

export async function makeWorld(
  overrides: { git?: Partial<FakeGitState>; files?: Record<string, string> } = {},
): Promise<CliWorld & { git: ReturnType<typeof fakeGit>; clock: ReturnType<typeof clock> }> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'repo-ready-cli-'));
  stateRoots.push(stateRoot);
  return {
    git: fakeGit(overrides.git),
    clock: clock('2026-01-05T09:00:00.000Z'),
    stateRoot,
    ...(overrides.files === undefined ? {} : { files: overrides.files }),
  };
}

export async function removeWorlds(): Promise<void> {
  await Promise.all(stateRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}
