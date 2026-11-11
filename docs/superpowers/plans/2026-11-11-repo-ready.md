# repo-ready Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `repo-ready` CLI and its Claude Code, Codex and OpenCode skills, so an agent can teach and quiz a person on any repository, record everything, and report a readiness level per design area.

**Architecture:** The agent does judgement (map, questions, grades); the CLI does facts. The CLI keeps one append-only event log and one map per repository under the XDG state directory. One pure function, `buildModel(map, events)`, derives every level, stale mark, verdict, statistic and chart from that log, so nothing derived is stored. The three skill files describe one session procedure over the same commands.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), commander `^12.1.0`, vitest `^2.1.1`, `@yao-pkg/pkg` for binaries. No other runtime dependency. No chart library.

**Spec:** `docs/superpowers/specs/2026-11-11-repo-ready-design.md`. Read it first. Where this plan and the spec disagree, the spec wins; stop and report.

## Global Constraints

- Package `tools/repo-ready`, name `@ai-tools/repo-ready`, bin `repo-ready` → `dist/cli.js`, first version `0.1.0`.
- Source split: `src/core/` (engine, no I/O assumptions) and `src/cli/` (commander program). Tests in `test/`, vitest, offline: the clock, the state location and git are injected.
- State lives under `ai-tools/repo-ready` in the XDG state directory, overridable by `AI_TOOLS_REPO_READY_STATE_DIR`.
- Exit codes: `0` success, `1` not found (no map, no open session, no history), `2` error. Every result-printing command supports `--json`.
- The CLI makes no network calls and never writes into the studied repository.
- A map holds 1 to 10 areas. Scores are whole numbers 0 to 4. A pass is score 3 or 4 with no hint. A level needs 2 passes in the last 3 valid questions. Default session length is 8 questions. These numbers are named constants in `src/core/types.ts` only.
- Verdict labels, exact copy: `read` = "Ready to be interviewed on it", `maintain` = "Ready to work on it", `rebuild` = "Ready to own it", no level = "Not yet ready", untested = "Not enough evidence yet". Every place that prints a level prints its label.
- eslint and prettier pass. British English in prose, comments and commits. No code comments unless essential. Conventional Commits.
- No personal information. Examples use `example.com`, `example.org` and `octo-org/hello-world`.
- Work in the worktree `repo-ready` on branch `repo-ready`. Never commit to `main`.

## Review Focus

Conditions the spec implies but states no test for. Each has a test in the task named.

1. **Commands out of order** (answer twice, grade before answer, hint after answer, unknown question id): exit `2` with a clear message and no event written. Task 8.
2. **Abandoned session** (the agent stopped mid-session): the next `session start` closes the old session and opens a new one; `ask` with no open session fails with exit `2`. Task 7.
3. **Same repository reached another way** (a subfolder, a second clone, `ssh` and `https` forms of one remote): one history. Task 2.
4. **No usable git state** (not a repository, no commits yet, detached HEAD): every command still works; branch and commit are recorded as `null`; change detection reports that it cannot compare. Tasks 2 and 4.
5. **Hostile or awkward text** (quotes, newlines, emoji, `<script>` in a prompt, answer or area title): survives the log unchanged and is escaped in HTML. Tasks 3 and 9.

## File Structure

```
tools/repo-ready/
├── package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, .gitignore, README.md
├── src/
│   ├── cli.ts                 entry; same shape as tools/gh-watcher/src/cli.ts
│   ├── index.ts               re-exports src/core/*
│   ├── version.ts             VERSION
│   ├── core/
│   │   ├── types.ts           constants, map, event and model types
│   │   ├── deps.ts            Deps, GitFacts, defaultDeps, realGit
│   │   ├── identity.ts        normaliseRemote, dirNameFor, readRepoState
│   │   ├── store.ts           stateDir, repoDir, map and event files
│   │   ├── glob.ts            globToRegExp, matchesAny
│   │   ├── map.ts             validateMap, diffMaps, checkUpdate, mapChanges
│   │   ├── model.ts           buildModel: questions, levels, stale, verdict
│   │   ├── next.ts            nextTargets
│   │   ├── stats.ts           sessionSummary, chartData
│   │   └── charts/text.ts, charts/html.ts
│   └── cli/
│       ├── index.ts           buildProgram, run, main, isEntryModule
│       ├── context.ts         openRepo: deps + repo state + state folder
│       ├── output.ts          printJson, formatTable (copy gh-watcher's)
│       ├── map-commands.ts    status, map set|show|changes
│       ├── session-commands.ts  session start|end|list, teach
│       ├── question-commands.ts ask, hint, answer, grade, skip
│       └── read-commands.ts   next, levels, history, chart, report, export, reset
└── test/
    ├── helpers.ts             fakeGit, clock, LogBuilder, sampleMap, runCli
    └── *.spec.ts
skills/claude-code/repo-ready/SKILL.md, skills/codex/repo-ready.md, skills/opencode/repo-ready.md
```

Follow `tools/gh-watcher` for anything not stated here (config files, entry module, table output).

---

### Task 1: Package scaffold, shared types, board row

**Files:**

- Create: `tools/repo-ready/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts,.gitignore}`, `src/cli.ts`, `src/index.ts`, `src/version.ts`, `src/core/types.ts`, `src/cli/index.ts`, `src/cli/output.ts`, `test/cli-version.spec.ts`
- Modify: `TASKS.md`, `package-lock.json` (by `npm install`)

**Interfaces:**

- Produces: everything in `src/core/types.ts` below; `run(argv: string[], overrides?: Partial<Deps>): Promise<void>` (the `overrides` parameter arrives in Task 2; here `run(argv)`).

- [ ] **Step 1: Add the board row.** In `TASKS.md` add epic `## 9. repo-ready readiness quiz tool and skills` after epic 8, with a one-line intro, an `ETA:` line and the table header. Rows: `21` "repo-ready CLI and skills for Claude Code, Codex and OpenCode" (`in_progress`, owner `claude`, branch `repo-ready`); `22` "Release repo-ready 0.1.0" (`todo`, Depends `9.21`). Set the ETA of 9.21 with the tasks-board `eta` tool. Commit: `chore(tasks): add 9.21 and 9.22 for repo-ready`.

- [ ] **Step 2: Write the failing test** `test/cli-version.spec.ts`

```ts
it('VERSION matches package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  expect(VERSION).toBe(pkg.version);
  expect(pkg.version).toBe('0.1.0');
});
it('exposes the constants the spec pins', () => {
  expect([PASS_SCORE, LEVEL_PASSES, LEVEL_WINDOW, STALE_CLEAR_AFTER]).toEqual([3, 2, 3, 3]);
  expect([SESSION_QUESTIONS, SESSION_AREA_CAP, MIN_AREAS, MAX_AREAS, RECENT_PROMPTS]).toEqual([
    8, 3, 1, 10, 5,
  ]);
  expect(LEVEL_LABELS).toEqual({
    none: 'Not yet ready',
    read: 'Ready to be interviewed on it',
    maintain: 'Ready to work on it',
    rebuild: 'Ready to own it',
  });
  expect(NOT_ENOUGH_LABEL).toBe('Not enough evidence yet');
  expect(QTYPES).toEqual({
    read: ['explain', 'trace'],
    maintain: ['predict', 'debug', 'change'],
    rebuild: ['rebuild'],
  });
});
```

- [ ] **Step 3: Create the package.** Copy `package.json`, both tsconfigs, `vitest.config.ts`, `.gitignore` and `src/cli.ts` from `tools/gh-watcher`, change the names, set version `0.1.0`, description "Repository readiness quiz engine for AI agents", dependency `commander ^12.1.0` only (no `@ai-tools/hooks`). Run `npm install` at the repo root.

- [ ] **Step 4: Write `src/core/types.ts`** with the constants above and these types:

```ts
export const LEVELS = ['read', 'maintain', 'rebuild'] as const;
export type Level = (typeof LEVELS)[number];
export type HeldLevel = Level | 'none';
export type QType = 'explain' | 'trace' | 'predict' | 'debug' | 'change' | 'rebuild';
export type Mode = 'learn' | 'interview';

export interface Principle {
  id: string;
  statement: string;
  reason: string;
  evidence: string[];
}
export interface Area {
  id: string;
  title: string;
  summary: string;
  key: boolean;
  paths: string[];
  revision: number;
  principles: Principle[];
}
export interface MapInput {
  areas: Area[];
}
export interface StoredMap extends MapInput {
  version: 1;
  repoKey: string;
  branch: string | null;
  commit: string | null;
  setAt: string;
}
export interface MapChange {
  kind: 'added' | 'removed' | 'key_set' | 'key_cleared' | 'revision_raised';
  areaId: string;
  from?: number;
  to?: number;
}

export interface EventBase {
  at: string;
  sessionId: string | null;
  mode: Mode | null;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  mapCommit: string | null;
}
export type LogEvent = EventBase &
  (
    | { type: 'session_start' }
    | { type: 'session_end'; auto: boolean }
    | { type: 'map_set'; changes: MapChange[]; forced: string | null }
    | { type: 'lesson'; areaId: string; principleIds: string[] }
    | {
        type: 'ask';
        questionId: string;
        areaId: string;
        revision: number;
        level: Level;
        qtype: QType;
        principleIds: string[];
        prompt: string;
        evidence: string[];
        followUpOf: string | null;
      }
    | { type: 'hint'; questionId: string }
    | { type: 'answer'; questionId: string; text: string; durationMs: number }
    | { type: 'grade'; questionId: string; score: number; notes: string; gaps: string[] }
    | { type: 'skip'; questionId: string }
  );

export interface QuestionRecord {
  id: string;
  sessionId: string;
  mode: Mode;
  areaId: string;
  revision: number;
  level: Level;
  qtype: QType;
  principleIds: string[];
  prompt: string;
  evidence: string[];
  followUpOf: string | null;
  askedAt: string;
  branch: string | null;
  commit: string | null;
  answer: string | null;
  answeredAt: string | null;
  durationMs: number | null;
  hints: number;
  score: number | null;
  notes: string;
  gaps: string[];
  status: 'open' | 'answered' | 'graded' | 'skipped';
  passed: boolean;
  voided: boolean;
}
export interface LevelTally {
  valid: number;
  passedInWindow: number;
  held: boolean;
}
export interface AreaState {
  id: string;
  title: string;
  key: boolean;
  revision: number;
  retired: boolean;
  level: HeldLevel;
  label: string;
  stale: boolean;
  staleFrom: Level | null;
  untested: boolean;
  lastTestedAt: string | null;
  perLevel: Record<Level, LevelTally>;
}
export interface Verdict {
  kind: 'level' | 'not_enough_evidence' | 'not_yet_ready';
  level: HeldLevel;
  label: string;
  untestedKeyAreas: string[];
  holdingBack: string[];
  weakestTypes: QType[];
  recurringGaps: string[];
}
export interface SessionRecord {
  id: string;
  mode: Mode;
  startedAt: string;
  endedAt: string | null;
  auto: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  questionIds: string[];
}
export interface Model {
  areas: AreaState[];
  questions: QuestionRecord[];
  sessions: SessionRecord[];
  verdict: Verdict;
}
```

- [ ] **Step 5: Write `src/cli/index.ts`** with `buildProgram()` (name `repo-ready`, `.version(VERSION, '-V, --version', 'print the version')`, global option `--repo <path>`), `run`, `main` and `isEntryModule`, as in gh-watcher. `main` maps a thrown `NotFoundError` to exit code `1` and any other error to `2`, printing `error: <message>` on stderr. Export `class NotFoundError extends Error` from `src/core/types.ts`.

- [ ] **Step 6: Verify.** Run `npm run build -w @ai-tools/repo-ready && npm test -w @ai-tools/repo-ready && node tools/repo-ready/dist/cli.js --version`. Expected: tests pass, prints `0.1.0`.

- [ ] **Step 7: Commit** `feat(repo-ready): scaffold package and shared types`.

---

### Task 2: Repository identity and git facts

**Files:**

- Create: `src/core/deps.ts`, `src/core/identity.ts`, `test/helpers.ts`, `test/identity.spec.ts`, `test/git-real.spec.ts`

**Interfaces:**

- Produces:

```ts
export interface GitFacts {
  toplevel(cwd: string): Promise<string | null>; // null when not a repository
  branch(root: string): Promise<string | null>; // null when detached or no commits
  head(root: string): Promise<string | null>; // null when no commits
  dirty(root: string): Promise<boolean>;
  originUrl(root: string): Promise<string | null>;
  rootCommit(root: string): Promise<string | null>; // lexically first root commit
  hasCommit(root: string, sha: string): Promise<boolean>;
  changedFiles(root: string, from: string, to: string): Promise<string[]>;
  trackedFiles(root: string): Promise<string[]>;
}
export interface Deps {
  now(): Date;
  git: GitFacts;
  stateRoot(): string;
  newId(prefix: 's' | 'q'): string;
  fileExists(absPath: string): Promise<boolean>;
  readText(source: string): Promise<string>; // '-' = stdin
  print(text: string): void;
}
export function realGit(): GitFacts;
export function defaultDeps(): Deps;
export interface RepoState {
  root: string;
  isGit: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  key: string;
  dirName: string;
}
export function normaliseRemote(url: string): string;
export function dirNameFor(key: string): string;
export function readRepoState(path: string, git: GitFacts): Promise<RepoState>;
// test/helpers.ts
export function fakeGit(state?: Partial<FakeGitState>): GitFacts & { state: FakeGitState };
export function clock(startIso: string): { now(): Date; advance(ms: number): void };
```

`FakeGitState`: `{ toplevel: string | null; branch: string | null; head: string | null; dirty: boolean; origin: string | null; rootCommit: string | null; commits: string[]; diffs: Record<string, string[]>` (key `"<from>..<to>"`)`; tracked: string[] }`. Tests change `state` between calls.

- [ ] **Step 1: Write the failing tests** `test/identity.spec.ts`

```ts
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
```

- [ ] **Step 2: Write** `test/git-real.spec.ts`: in a temp folder with `GIT_CONFIG_GLOBAL=/dev/null`, check `realGit()` against real git in three states: not a repository (`toplevel` → `null`); `git init` with no commits (`head` and `branch` → `null`, `dirty` false); after one commit made with `-c user.name=Test -c user.email=test@example.com` on branch `main` (`branch` → `'main'`, `head` is 40 hex, `hasCommit(head)` true, `hasCommit('0'.repeat(40))` false, `trackedFiles` lists the file), then after `git checkout --detach` (`branch` → `null`), and after a second commit `changedFiles(first, second)` lists exactly the changed file.

- [ ] **Step 3: Run the tests.** `npm test -w @ai-tools/repo-ready`. Expected: FAIL, functions not defined.

- [ ] **Step 4: Implement `deps.ts` and `identity.ts`.** `realGit` uses `execFile('git', args, { cwd })` and treats a non-zero exit as `null`, `false` or `[]`. `normaliseRemote` drops scheme, credentials, port, a trailing `.git` and trailing slash, and lower-cases. `dirNameFor` replaces every character outside `[a-z0-9.]` with `-` and appends `-` plus the first 8 hex characters of the SHA-256 of the key. Key order: `normaliseRemote(origin)`, else `root:<rootCommit>`, else `path:<root>`. `newId` returns the prefix plus 8 random base-36 characters. Extend `run(argv, overrides?)` to merge `overrides` over `defaultDeps()`.

- [ ] **Step 5: Run the tests.** Expected: PASS.

- [ ] **Step 6: Commit** `feat(repo-ready): repository identity and git facts`.

---

### Task 3: State store

**Files:**

- Create: `src/core/store.ts`, `test/store.spec.ts`

**Interfaces:**

- Consumes: `StoredMap`, `LogEvent`, `RepoState`.
- Produces:

```ts
export function stateDir(): string; // env override, XDG, platform default
export function repoDir(stateRoot: string, dirName: string): string; // <stateRoot>/repos/<dirName>
export function readMap(dir: string): Promise<StoredMap | null>;
export function writeMap(dir: string, map: StoredMap, repo: RepoState): Promise<void>;
export function appendEvent(dir: string, event: LogEvent): Promise<void>;
export function readEvents(dir: string): Promise<LogEvent[]>;
export function resetRepo(dir: string): Promise<boolean>; // false when nothing existed
```

Files in a repository folder: `map.json`, `maps/<setAt with ":" replaced by "-">.json` (earlier maps), `events.jsonl`, `repo.json` (`{ key, root, firstSeenAt }`, written once, so a person can tell the folders apart).

- [ ] **Step 1: Write the failing tests** `test/store.spec.ts` (temp folder per test)

```ts
it('stateDir honours the override, then XDG_STATE_HOME', () => {
  process.env.AI_TOOLS_REPO_READY_STATE_DIR = '/x/override';
  expect(stateDir()).toBe('/x/override');
  delete process.env.AI_TOOLS_REPO_READY_STATE_DIR;
  process.env.XDG_STATE_HOME = '/x/state';
  expect(stateDir()).toBe('/x/state/ai-tools/repo-ready');
});
it('readMap returns null and readEvents returns [] for a new folder');
it('writeMap keeps the earlier map under maps/', async () => {
  await writeMap(dir, { ...map, setAt: '2026-01-01T00:00:00.000Z' }, repo);
  await writeMap(dir, { ...map, setAt: '2026-01-02T00:00:00.000Z' }, repo);
  expect((await readMap(dir))?.setAt).toBe('2026-01-02T00:00:00.000Z');
  expect(await readdir(join(dir, 'maps'))).toEqual(['2026-01-01T00-00-00.000Z.json']);
});
it('events round-trip awkward text unchanged', async () => {
  const prompt = 'He said "why?"\n<script>alert(1)</script> 🙂 \\  ';
  await appendEvent(dir, askEvent({ prompt }));
  expect((await readEvents(dir))[0]).toMatchObject({ type: 'ask', prompt });
});
it('readEvents skips a damaged line and warns once', async () => {
  await appendEvent(dir, askEvent({}));
  await appendFile(join(dir, 'events.jsonl'), '{"type":"ask","prom');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await readEvents(dir)).toHaveLength(1);
  expect(warn).toHaveBeenCalledTimes(1);
});
it('resetRepo removes the folder and reports whether it existed');
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `store.ts`.** `stateDir` copies the shape of `tools/gh-watcher/src/core/store.ts`. `writeMap` writes to a temporary file and renames. `appendEvent` writes one JSON line.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(repo-ready): state store`.

---

### Task 4: Map validation, update rules, change detection

**Files:**

- Create: `src/core/glob.ts`, `src/core/map.ts`, `test/glob.spec.ts`, `test/map.spec.ts`
- Modify: `test/helpers.ts` (add `sampleMap`)

**Interfaces:**

- Produces:

```ts
export function globToRegExp(glob: string): RegExp;
export function matchesAny(path: string, globs: string[]): boolean;
export class MapError extends Error {
  problems: string[];
}
export function validateMap(input: unknown): MapInput; // throws MapError listing every problem
export function diffMaps(prev: MapInput | null, next: MapInput): MapChange[];
export interface UpdateContext {
  comparable: boolean;
  changedFiles: string[];
  trackedFiles: string[] | null;
}
export function checkUpdate(
  prev: MapInput,
  next: MapInput,
  ctx: UpdateContext,
): { blocking: string[]; forceable: string[] };
export interface MapChangesResult {
  comparable: boolean;
  reason: string | null;
  from: string | null;
  to: string | null;
  dirty: boolean;
  areas: { id: string; title: string; files: string[] }[];
  unmapped: string[];
}
export function mapChanges(
  map: StoredMap,
  repo: RepoState,
  git: GitFacts,
): Promise<MapChangesResult>;
// test/helpers.ts
export function sampleMap(): MapInput; // areas: a (key, paths ['src/a/**']), b (key, ['src/b/**']), c (not key, ['docs/*.md']);
// evidence 'src/a/x.ts:1', 'src/b/x.ts:1', 'docs/a.md:1'; every revision 1
```

Glob rules: paths are POSIX, relative to the repository root. `*` matches within one segment, `?` one character within a segment, `**` any number of segments including none, a pattern ending in `/` matches everything below it.

- [ ] **Step 1: Write the failing tests**

```ts
// glob.spec.ts
it.each([
  ['src/a/**', 'src/a/x/y.ts', true],
  ['src/a/**', 'src/ab/x.ts', false],
  ['docs/*.md', 'docs/a.md', true],
  ['docs/*.md', 'docs/sub/a.md', false],
  ['**/store.ts', 'store.ts', true],
  ['**/store.ts', 'tools/x/src/store.ts', true],
  ['tools/', 'tools/x/y.ts', true],
  ['a?.ts', 'ab.ts', true],
  ['a?.ts', 'a/.ts', false],
])('%s vs %s', (glob, path, want) => expect(matchesAny(path, [glob])).toBe(want));

// map.spec.ts — validateMap
it('accepts the sample map', () => expect(validateMap(sampleMap()).areas).toHaveLength(3));
it('accepts one area and rejects none or eleven');
it.each([
  ['duplicate area id', /duplicate area id/],
  ['id "Not A Slug"', /slug/],
  ['no key area', /at least one key area/],
  ['empty paths', /paths/],
  ['no principles', /principle/],
  ['evidence "src/a.ts"', /path:line/],
  ['revision 0', /revision/],
  ['revision 1.5', /revision/],
  ['empty title', /title/],
])('rejects %s', (_case, pattern) => {
  /* build the bad map, expect MapError matching pattern */
});
it('reports every problem at once', () => {
  /* two faults → error.problems has length 2 */
});

// diffMaps and checkUpdate
it('diffMaps reports added, removed, key_set, key_cleared and revision_raised with from and to');
it('adding an area is always allowed', () =>
  expect(checkUpdate(prev, withAreaD, quiet)).toEqual({ blocking: [], forceable: [] }));
it('removing an untouched area needs force', () =>
  expect(checkUpdate(prev, withoutB, quiet).forceable).toHaveLength(1));
it('removing an area whose files changed is allowed', () =>
  expect(checkUpdate(prev, withoutB, { ...quiet, changedFiles: ['src/b/x.ts'] }).forceable).toEqual(
    [],
  ));
it('removing an area whose paths match no tracked file is allowed', () =>
  expect(checkUpdate(prev, withoutB, { ...quiet, trackedFiles: ['src/a/x.ts'] }).forceable).toEqual(
    [],
  ));
it('clearing key follows the same rule as removal');
it('raising a revision needs a changed file in that area, or force');
it('lowering a revision is blocking and cannot be forced', () =>
  expect(checkUpdate(prevWithA2, sampleMap(), quiet).blocking).toHaveLength(1));
it('everything is allowed when the commits cannot be compared', () =>
  expect(
    checkUpdate(prev, withoutB, { comparable: false, changedFiles: [], trackedFiles: null }),
  ).toEqual({ blocking: [], forceable: [] }));

// mapChanges
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
it('cannot compare when the map commit is gone, the map has no commit, or the folder is not a repository', async () => {
  /* each case: comparable false, reason is a non-empty sentence, areas [] */
});
```

`quiet` is `{ comparable: true, changedFiles: [], trackedFiles: ['src/a/x.ts', 'src/b/x.ts', 'docs/a.md'] }`.

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `glob.ts` and `map.ts`.** `validateMap` checks: 1 to 10 areas; area and principle ids match `^[a-z0-9][a-z0-9-]*$` and are unique in their scope; non-empty `title`, `summary`, `statement`, `reason`; `key` boolean and at least one true; at least one path; at least one principle, each with at least one evidence string matching `^[^:\s]+:\d+(-\d+)?$`; `revision` a whole number ≥ 1. Removal and key-clearing are judged with the **previous** area's paths; a revision rise with the union of the previous and next paths.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(repo-ready): map validation, update rules and change detection`.

---

### Task 5: The model: questions, levels, staleness, verdict

**Files:**

- Create: `src/core/model.ts`, `test/model.spec.ts`
- Modify: `test/helpers.ts` (add `LogBuilder`)

**Interfaces:**

- Consumes: types from Task 1, `sampleMap`, `clock`.
- Produces:

```ts
export function buildModel(map: MapInput, events: LogEvent[]): Model;
export function levelRank(level: HeldLevel): number; // none 0, read 1, maintain 2, rebuild 3
// test/helpers.ts
export class LogBuilder {
  events: LogEvent[];
  session(mode?: Mode): this; // default 'learn'
  endSession(): this;
  q(
    areaId: string,
    level: Level,
    score: number | 'skip' | 'open',
    opts?: {
      qtype?: QType;
      hints?: number;
      durationMs?: number;
      gaps?: string[];
      followUpOf?: string;
      prompt?: string;
    },
  ): string;
  raise(areaId: string): this; // map_set with one revision_raised change
}
```

`q` emits ask, hints, answer and grade (or ask and skip, or ask alone for `'open'`), 60 000 ms apart unless `durationMs` is given, and returns the question id. `qtype` defaults to the first type of the level.

**The rules, as an algorithm.** Replay the events in order.

- A question is **valid** unless voided. Only `graded` and `skipped` questions count; a skipped one counts as score 0. A question **passes** when score ≥ `PASS_SCORE` and it had no hint.
- `perLevel[L]`: take the area's valid counted questions at level L in order; `valid` is their number; `passedInWindow` is the passes among the last `LEVEL_WINDOW`; `held` is `passedInWindow >= LEVEL_PASSES`.
- An area's `level` is the highest L for which L and every lower level are `held`. `untested` is `perLevel.read.valid < 2`.
- On a `map_set` event, for each `revision_raised` change on area X: let `L` be X's level at that moment. Void every counted question in X whose level is ≥ `L` (≥ `read` when `L` is `none`). If `L` is not `none`: X becomes stale with `staleFrom = L` and a re-test count of 0. If `L` is `none` and X is already stale: keep `staleFrom`, reset the count.
- After each grade or skip in a stale area X: add 1 to the count if the question's level is `staleFrom`. If X's level is now ≥ `staleFrom`, or the count has reached `STALE_CLEAR_AFTER`, X is no longer stale and `staleFrom` is `null`.
- An area in the events but not in the map is **retired**: it appears in `areas` with `retired: true` and takes no part in the verdict.
- **Verdict** over key, non-retired areas. Let `m` be the lowest level among them. If `m` is `none` and any of those areas at `none` is `untested`: kind `not_enough_evidence`, label `NOT_ENOUGH_LABEL`, `untestedKeyAreas` lists them. Else if `m` is `none`: kind `not_yet_ready`. Else kind `level`. `label` is `LEVEL_LABELS[m]` in the last two cases. `holdingBack`: the key areas at level `m`, empty when `m` is `rebuild`. `weakestTypes`: up to 3 question types by lowest pass rate over valid counted questions, types never asked left out. `recurringGaps`: gap tags seen at least twice, most frequent first, at most 5.

- [ ] **Step 1: Write the failing tests** `test/model.spec.ts`. `area(m, id)` finds an `AreaState`; `L` is a `LogBuilder` with a session open.

```ts
it('holds read after 2 passes in the last 3', () => {
  L.q('a', 'read', 4);
  L.q('a', 'read', 1);
  L.q('a', 'read', 3);
  expect(area(m(), 'a')).toMatchObject({
    level: 'read',
    label: 'Ready to be interviewed on it',
    untested: false,
  });
});
it('one pass is not enough', () => {
  L.q('a', 'read', 4);
  L.q('a', 'read', 1);
  expect(area(m(), 'a').level).toBe('none');
});
it('only the last 3 count', () => {
  for (const s of [4, 4, 1, 1]) L.q('a', 'read', s);
  expect(area(m(), 'a').level).toBe('none');
});
it('a hinted answer does not pass', () => {
  L.q('a', 'read', 4, { hints: 1 });
  L.q('a', 'read', 4);
  expect(area(m(), 'a').perLevel.read).toEqual({ valid: 2, passedInWindow: 1, held: false });
});
it('a skip counts as a fail and an open question does not count', () => {
  L.q('a', 'read', 'skip');
  L.q('a', 'read', 'open');
  expect(area(m(), 'a').perLevel.read.valid).toBe(1);
});
it('maintain does not count without read', () => {
  L.q('a', 'maintain', 4);
  L.q('a', 'maintain', 4);
  expect(area(m(), 'a')).toMatchObject({ level: 'none', untested: true });
});
it('verdict is the lowest key level', () => {
  hold('a', 'read');
  hold('b', 'maintain');
  expect(m().verdict).toMatchObject({
    kind: 'level',
    level: 'read',
    label: 'Ready to be interviewed on it',
    holdingBack: ['a'],
  });
});
it('a non-key area never lowers the verdict', () => {
  hold('a', 'read');
  hold('b', 'read');
  expect(m().verdict.level).toBe('read');
});
it('says not enough evidence when a key area is untested', () => {
  hold('a', 'read');
  expect(m().verdict).toMatchObject({
    kind: 'not_enough_evidence',
    label: 'Not enough evidence yet',
    untestedKeyAreas: ['b'],
  });
});
it('says not yet ready when every key area was tested and one failed', () => {
  hold('a', 'read');
  L.q('b', 'read', 1);
  L.q('b', 'read', 0);
  expect(m().verdict).toMatchObject({
    kind: 'not_yet_ready',
    label: 'Not yet ready',
    level: 'none',
  });
});
it('a revision rise costs one level and marks the area stale', () => {
  hold('a', 'maintain');
  L.raise('a');
  expect(area(m(), 'a')).toMatchObject({ level: 'read', stale: true, staleFrom: 'maintain' });
  expect(
    m()
      .questions.filter((q) => q.voided)
      .every((q) => q.level === 'maintain'),
  ).toBe(true);
});
it('two passes at the old level bring it back', () => {
  hold('a', 'maintain');
  L.raise('a');
  L.q('a', 'maintain', 4);
  L.q('a', 'maintain', 4);
  expect(area(m(), 'a')).toMatchObject({ level: 'maintain', stale: false, staleFrom: null });
});
it('the mark clears after 3 graded questions without the level', () => {
  hold('a', 'maintain');
  L.raise('a');
  for (let i = 0; i < 3; i++) L.q('a', 'maintain', 1);
  expect(area(m(), 'a')).toMatchObject({ level: 'read', stale: false });
});
it('lower-level passes during a re-test change nothing', () => {
  hold('a', 'maintain');
  L.raise('a');
  L.q('a', 'read', 4);
  expect(area(m(), 'a')).toMatchObject({ level: 'read', stale: true });
});
it('a second rise while stale costs another level', () => {
  hold('a', 'maintain');
  L.raise('a');
  L.raise('a');
  expect(area(m(), 'a')).toMatchObject({ level: 'none', stale: true, staleFrom: 'read' });
});
it('a rise on an area with no level voids its questions without a stale mark', () => {
  L.q('a', 'read', 4);
  L.raise('a');
  expect(area(m(), 'a')).toMatchObject({ level: 'none', stale: false, untested: true });
});
it('an area missing from the map is retired and outside the verdict', () => {
  hold('a', 'read');
  hold('b', 'read');
  L.q('z', 'read', 0);
  expect(area(m(), 'z').retired).toBe(true);
  expect(m().verdict.level).toBe('read');
});
it('lists recurring gaps and weakest types', () => {
  L.q('a', 'read', 1, { gaps: ['locking'], qtype: 'trace' });
  L.q('a', 'read', 1, { gaps: ['locking'] });
  L.q('a', 'read', 4, { gaps: ['naming'] });
  expect(m().verdict.recurringGaps).toEqual(['locking']);
  expect(m().verdict.weakestTypes[0]).toBe('trace');
});
it('records sessions with their questions, and duration and hints on each question');
```

`hold(areaId, level)` is a test helper that asks two passing questions at each level up to `level`.

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `buildModel`** as the algorithm above.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(repo-ready): levels, staleness and verdict model`.

---

### Task 6: What to test next, and session summaries

**Files:**

- Create: `src/core/next.ts`, `src/core/stats.ts`, `test/next.spec.ts`, `test/stats.spec.ts`

**Interfaces:**

- Consumes: `buildModel`, `Model`, `MapInput`.
- Produces:

```ts
export interface NextTarget {
  areaId: string;
  title: string;
  level: Level;
  qtype: QType;
  reason: 'stale' | 'untested' | 'not_held' | 'keep_fresh';
  recentPrompts: string[];
}
export interface NextResult {
  targets: NextTarget[];
  session: { id: string | null; asked: number; limit: number; done: boolean };
}
export function nextTargets(
  map: MapInput,
  model: Model,
  opts: { areas?: string[]; count: number; sessionId: string | null },
): NextResult;
export interface SessionSummary {
  sessionId: string;
  mode: Mode;
  startedAt: string;
  endedAt: string | null;
  asked: number;
  graded: number;
  passed: number;
  passRate: number | null;
  medianMs: number | null;
  hints: number;
  skips: number;
  byArea: { areaId: string; level: Level; asked: number; passed: number }[];
}
export function sessionSummary(model: Model, sessionId: string): SessionSummary;
export function median(values: number[]): number | null;
```

**Ordering rules.**

- Target level of an area: `staleFrom` when stale; otherwise the level above the one it holds; `rebuild` when it holds `rebuild`.
- Area order: stale areas; then key areas by held level, lowest first; then other areas by held level, lowest first. Ties: least recently tested first (never tested first), then map order. Within the stale group, key areas first.
- An area that already has `SESSION_AREA_CAP` questions in the current session goes after every area that does not, keeping the order above within each group.
- Question type, among the types of the target level: lowest pass rate in that area first, a type never asked there counting as lowest; then the higher median time; then the order in `QTYPES`.
- `reason`: `stale`; else `keep_fresh` when the area holds `rebuild`; else `untested` when the target level has fewer than 2 valid counted questions; else `not_held`.
- `recentPrompts`: the area's last `RECENT_PROMPTS` prompts, newest first. Retired areas are never targets. `opts.areas` filters; an unknown id throws.
- `session.asked` counts every question of the session, follow-ups included; `limit` is `SESSION_QUESTIONS`; `done` is `asked >= limit`.

- [ ] **Step 1: Write the failing tests**

```ts
// next.spec.ts — ids(r) maps targets to areaId
it('puts a stale area first, at the level it held', () => {
  hold('a', 'maintain');
  hold('b', 'read');
  L.raise('a');
  expect(next().targets[0]).toMatchObject({ areaId: 'a', level: 'maintain', reason: 'stale' });
});
it('then key areas lowest first, then other areas', () => {
  hold('a', 'read');
  expect(ids(next({ count: 3 }))).toEqual(['b', 'a', 'c']);
  expect(next({ count: 3 }).targets.map((t) => t.level)).toEqual(['read', 'maintain', 'read']);
});
it('picks an untried type, then the weakest', () => {
  L.q('a', 'read', 4, { qtype: 'explain' });
  expect(next({ areas: ['a'] }).targets[0]?.qtype).toBe('trace');
  L.q('a', 'read', 1, { qtype: 'trace' });
  expect(next({ areas: ['a'] }).targets[0]?.qtype).toBe('trace');
});
it('picks the slower type when pass rates are equal', () => {
  L.q('c', 'read', 1, { qtype: 'explain', durationMs: 30_000 });
  L.q('c', 'read', 1, { qtype: 'trace', durationMs: 90_000 });
  expect(next({ areas: ['c'] }).targets[0]?.qtype).toBe('trace');
});
it('moves an area back after 3 questions in this session', () => {
  for (let i = 0; i < 3; i++) L.q('b', 'read', 1);
  expect(ids(next({ count: 3 }))).toEqual(['a', 'c', 'b']);
});
it('filters by area and rejects an unknown id', () => {
  expect(ids(next({ areas: ['c'], count: 3 }))).toEqual(['c']);
  expect(() => next({ areas: ['nope'] })).toThrow(/unknown area/);
});
it('reports untested, not_held and keep_fresh', () => {
  /* a: no questions → untested; a: two fails → not_held; a holds rebuild → keep_fresh at rebuild */
});
it('returns the last 5 prompts newest first');
it('is done after 8 questions, follow-ups included', () => {
  for (let i = 0; i < 8; i++) L.q('a', 'read', 4);
  expect(next().session).toMatchObject({ asked: 8, limit: 8, done: true });
});

// stats.spec.ts
it('summarises one session', () => {
  L.q('a', 'read', 4, { durationMs: 40_000 });
  L.q('a', 'read', 1, { durationMs: 60_000, hints: 1 });
  L.q('b', 'maintain', 'skip');
  expect(sessionSummary(m(), sid)).toMatchObject({
    asked: 3,
    graded: 2,
    passed: 1,
    passRate: 1 / 3,
    medianMs: 50_000,
    hints: 1,
    skips: 1,
    byArea: [
      { areaId: 'a', level: 'read', asked: 2, passed: 1 },
      { areaId: 'b', level: 'maintain', asked: 1, passed: 0 },
    ],
  });
});
it('pass rate is null for a session with no counted question');
```

`passRate` is passes divided by counted questions (graded plus skipped).

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `next.ts` and the two functions in `stats.ts`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(repo-ready): next-target ordering and session summary`.

---

### Task 7: CLI: status, map, session, teach

**Files:**

- Create: `src/cli/context.ts`, `src/cli/map-commands.ts`, `src/cli/session-commands.ts`, `test/cli-map.spec.ts`, `test/cli-session.spec.ts`
- Modify: `src/cli/index.ts`, `test/helpers.ts` (add `runCli`)

**Interfaces:**

- Consumes: Tasks 2 to 6.
- Produces:

```ts
// context.ts
export interface Ctx { deps: Deps; repo: RepoState; dir: string; json: boolean }
export function openRepo(deps: Deps, repoPath: string | undefined, json: boolean): Promise<Ctx>;
export function requireMap(ctx: Ctx): Promise<StoredMap>;           // throws NotFoundError('no map yet; build one with: repo-ready map set --file <path>')
export function openSession(events: LogEvent[]): SessionRecord | null;
export function record(ctx: Ctx, map: StoredMap | null, session: SessionRecord | null, body: /* the type-specific part of a LogEvent */): Promise<LogEvent>;
export function registerMapCommands(p: Command, deps: Deps): void;
export function registerSessionCommands(p: Command, deps: Deps): void;
// test/helpers.ts
export function runCli(args: string[], world: { git: GitFacts; clock: { now(): Date }; stateRoot: string; files?: Record<string, string>; stdin?: string }):
  Promise<{ out: string; json(): unknown; error: Error | null; code: 0 | 1 | 2 }>;
```

`record` fills `at`, `sessionId`, `mode`, `branch`, `commit`, `dirty` and `mapCommit` and appends the event. `runCli` calls `run(['node', 'repo-ready', ...args], deps)`, collects `print` output, maps a thrown `NotFoundError` to code 1 and any other error to code 2. `files` backs `readText` and `fileExists`; keys are paths relative to the repository root. When `files` is not given it holds the three evidence files of `sampleMap` and `map.json` with the sample map.

**Commands.**

| Command                                           | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                          | Prints repository (`root`, `key`, `branch`, `commit`, `dirty`), the state folder, the map (`commit`, `setAt`, area count, `behind`: the map commit differs from HEAD), each area's level with label and stale mark, the verdict, the open session and the last ended session. With no map it prints the repository part, then throws `NotFoundError`.                                                                         |
| `map set --file <path> [--force --reason <text>]` | `validateMap`; every evidence path must exist under the repository root (`fileExists`), else error. With an earlier map: build `UpdateContext` from `mapChanges` and `trackedFiles`, run `checkUpdate`; any `blocking` problem fails; any `forceable` problem fails unless `--force`, which requires `--reason`. Stores the map stamped with branch, commit and time, appends a `map_set` event, prints the `MapChange` list. |
| `map show`                                        | Prints the stored map.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `map changes`                                     | Prints `MapChangesResult`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session start --mode learn\|interview`           | Ends an open session first with `session_end` `auto: true`. Appends `session_start`, prints the session id. Needs a map.                                                                                                                                                                                                                                                                                                      |
| `session end`                                     | No open session: `NotFoundError`. Appends `session_end`, prints the session summary, the areas and the verdict. Text output leads with the session summary in interview mode and with the verdict in learn mode. `--json`: `{ summary, areas, verdict }`.                                                                                                                                                                     |
| `session list`                                    | Past sessions, newest first, each with its summary. No sessions: `NotFoundError`.                                                                                                                                                                                                                                                                                                                                             |
| `teach --area <id> [--principles <id,id>]`        | Needs an open session and a known area and principles. Appends `lesson`.                                                                                                                                                                                                                                                                                                                                                      |

- [ ] **Step 1: Write the failing tests**

```ts
// cli-map.spec.ts
it('status with no map exits 1 and still prints the repository', async () => {
  const r = await runCli(['status', '--json'], world);
  expect(r.code).toBe(1);
  expect(r.json()).toMatchObject({ repo: { key: 'github.com/octo-org/hello-world' }, map: null });
});
it('map set stores the map and stamps the commit', async () => {
  expect((await runCli(['map', 'set', '--file', 'map.json', '--json'], world)).code).toBe(0);
  expect((await runCli(['map', 'show', '--json'], world)).json()).toMatchObject({
    commit: 'c1',
    branch: 'main',
    areas: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  });
});
it('map set rejects a bad map with exit 2 and names every problem');
it('map set rejects evidence that points at a missing file', async () => {
  /* files lacks src/a/x.ts → code 2, message names the path */
});
it('map set refuses to drop an untouched key area, and accepts it with --force --reason', async () => {
  expect((await runCli(['map', 'set', '--file', 'without-b.json'], world)).code).toBe(2);
  expect((await runCli(['map', 'set', '--file', 'without-b.json', '--force'], world)).code).toBe(2);
  const r = await runCli(
    [
      'map',
      'set',
      '--file',
      'without-b.json',
      '--force',
      '--reason',
      'person asked for a redraw',
      '--json',
    ],
    world,
  );
  expect(r.json()).toMatchObject({
    changes: [{ kind: 'removed', areaId: 'b' }],
    forced: 'person asked for a redraw',
  });
});
it('map set prints revision_raised when files in the area changed');
it('map changes groups files after the repository moves to c2');
it('works in a folder that is not a git repository', async () => {
  /* fakeGit({ toplevel: null }): map set code 0; map show commit null; map changes comparable false */
});

// cli-session.spec.ts
it('session start needs a map (exit 1) and a valid mode (exit 2)');
it('a second session start closes the first one', async () => {
  const first = (await runCli(['session', 'start', '--mode', 'learn', '--json'], world)).json() as {
    sessionId: string;
  };
  await runCli(['session', 'start', '--mode', 'interview'], world);
  const list = (await runCli(['session', 'list', '--json'], world)).json() as {
    id: string;
    endedAt: string | null;
    auto: boolean;
  }[];
  expect(list.find((s) => s.id === first.sessionId)).toMatchObject({ auto: true });
  expect(list.filter((s) => s.endedAt === null)).toHaveLength(1);
});
it('session end with no open session exits 1');
it('session end prints summary, areas and verdict as JSON');
it(
  'teach needs an open session and a known area (exit 2 otherwise) and records the branch and commit',
);
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `context.ts`, the two command files, and register them in `buildProgram`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(repo-ready): status, map and session commands`.

---

### Task 8: CLI: question lifecycle and read commands

**Files:**

- Create: `src/cli/question-commands.ts`, `src/cli/read-commands.ts`, `test/cli-question.spec.ts`, `test/cli-read.spec.ts`
- Modify: `src/cli/index.ts`

**Interfaces:**

- Consumes: `Ctx`, `record`, `requireMap`, `openSession`, `buildModel`, `nextTargets`, `sessionSummary`.
- Produces: `registerQuestionCommands(p, deps)`, `registerReadCommands(p, deps)` (chart and report are added to the second in Task 9).

**Commands.** Text comes from `--file <path>`; `--file -` reads standard input.

| Command                                                                                                                                            | Rules (each broken rule: exit 2, no event written)                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask --area <id> --level <level> --type <type> --file <path> --evidence <path:line> [--evidence ...] [--principles <id,id>] [--follow-up-of <id>]` | Open session; known area; the type belongs to the level; non-empty prompt; at least one evidence value in `path:line` form. Follow-up: the parent is in this session, in the same area, has an answer, is not itself a follow-up, has no follow-up yet, and the new level is the parent's or one above. Appends `ask` with the area's current revision. Prints the question id. |
| `hint <id>`                                                                                                                                        | The question is open (asked, no answer, not skipped); the session mode is `learn`.                                                                                                                                                                                                                                                                                              |
| `answer <id> --file <path>`                                                                                                                        | The question is open. `durationMs` is now minus the ask time, never below 0.                                                                                                                                                                                                                                                                                                    |
| `grade <id> --score <0-4> [--file <path>] [--gaps <tag,tag>]`                                                                                      | The question is answered and not graded; the score is a whole number 0 to 4. `--file` holds the notes.                                                                                                                                                                                                                                                                          |
| `skip <id>`                                                                                                                                        | The question is open.                                                                                                                                                                                                                                                                                                                                                           |
| `next [--area <id>...] [--count <n>]`                                                                                                              | Default count 3. Prints `NextResult`.                                                                                                                                                                                                                                                                                                                                           |
| `levels`                                                                                                                                           | Areas with level, label, stale mark (`stale (was <level>)`), untested mark and last tested time; then the verdict with its label and gaps.                                                                                                                                                                                                                                      |
| `history [--area <id>] [--session <id>] [--limit <n>]`                                                                                             | Question records, newest first; a retired area is marked. Nothing to show: `NotFoundError`.                                                                                                                                                                                                                                                                                     |
| `export`                                                                                                                                           | `{ repo, map, events }` as JSON.                                                                                                                                                                                                                                                                                                                                                |
| `reset --yes`                                                                                                                                      | Without `--yes`: exit 2. Deletes the repository's state folder.                                                                                                                                                                                                                                                                                                                 |

An unknown question id, area id or session id is exit 2 with the id in the message.

- [ ] **Step 1: Write the failing tests**

```ts
// cli-question.spec.ts
it('ask, answer and grade record a timed, graded question', async () => {
  const id = await ask(['--area', 'a', '--level', 'read', '--type', 'explain']);
  clock.advance(45_000);
  await ok(['answer', id, '--file', 'answer.txt']);
  await ok(['grade', id, '--score', '4', '--gaps', 'locking,naming']);
  const q = (await history())[0];
  expect(q).toMatchObject({
    id,
    status: 'graded',
    durationMs: 45_000,
    score: 4,
    passed: true,
    gaps: ['locking', 'naming'],
    branch: 'main',
    commit: 'c1',
  });
});
it('reads the prompt from standard input with --file -');
it('ask needs an open session', async () =>
  expect((await runCli(askArgs, noSession)).code).toBe(2));
it.each([
  [['--level', 'read', '--type', 'debug'], /debug.*maintain/],
  [['--area', 'nope'], /unknown area/],
  [['--evidence', 'src/a/x.ts'], /path:line/],
])('ask rejects %j', async (extra, pattern) => {
  /* code 2, message matches, event count unchanged */
});
it.each([
  ['answer twice', /already answered/],
  ['grade before answer', /not answered/],
  ['grade twice', /already graded/],
  ['hint after answer', /already answered/],
  ['skip after answer', /already answered/],
  ['answer an unknown id', /unknown question/],
  ['grade with score 5', /0 to 4/],
  ['grade with score 2.5', /0 to 4/],
])('%s exits 2 and writes nothing', async (name, pattern) => {
  /* run the sequence; last call: code 2, message matches, event count unchanged */
});
it('hint is recorded in learn mode and refused in interview mode');
it('a hinted answer is graded but does not pass');
it('a follow-up may be the same level or one above, in the same area, once per question', async () => {
  const parent = await askAnswerGrade('a', 'read', 4);
  expect(
    await askCode(['--area', 'b', '--level', 'read', '--type', 'trace', '--follow-up-of', parent]),
  ).toBe(2);
  expect(
    await askCode([
      '--area',
      'a',
      '--level',
      'rebuild',
      '--type',
      'rebuild',
      '--follow-up-of',
      parent,
    ]),
  ).toBe(2);
  const child = await ask([
    '--area',
    'a',
    '--level',
    'maintain',
    '--type',
    'predict',
    '--follow-up-of',
    parent,
  ]);
  expect(
    await askCode(['--area', 'a', '--level', 'read', '--type', 'trace', '--follow-up-of', parent]),
  ).toBe(2);
  expect(
    await askCode([
      '--area',
      'a',
      '--level',
      'maintain',
      '--type',
      'debug',
      '--follow-up-of',
      child,
    ]),
  ).toBe(2);
});
it('a follow-up of an unanswered question is refused');
it('duration is never negative when the clock goes back');

// cli-read.spec.ts
it('next returns targets and session progress as JSON');
it('levels prints every label and the stale mark', async () => {
  /* hold a at maintain, raise a → out contains 'Ready to be interviewed on it' and 'stale (was maintain)' */
});
it('history filters by area and session and exits 1 when empty');
it('export prints repo, map and events; reset needs --yes and then status exits 1');
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** both command files and register them.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(repo-ready): question lifecycle and read commands`.

---

### Task 9: Charts and report

**Files:**

- Create: `src/core/charts/text.ts`, `src/core/charts/html.ts`, `test/charts.spec.ts`
- Modify: `src/core/stats.ts`, `src/cli/read-commands.ts`, `test/cli-read.spec.ts`

**Interfaces:**

- Produces:

```ts
export const CHART_KINDS = ['levels', 'accuracy', 'speed', 'types', 'timeline'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];
export type ChartData =
  | { kind: 'levels'; verdict: Verdict; areas: (AreaState & { summary: string })[] }
  | {
      kind: 'accuracy';
      sessions: {
        sessionId: string;
        startedAt: string;
        mode: Mode;
        counted: number;
        passed: number;
        passRate: number | null;
      }[];
      byArea: {
        areaId: string;
        title: string;
        points: { sessionId: string; passRate: number | null }[];
      }[];
    }
  | {
      kind: 'speed';
      sessions: {
        sessionId: string;
        startedAt: string;
        count: number;
        medianMs: number | null;
        meanMs: number | null;
      }[];
    }
  | {
      kind: 'types';
      types: {
        qtype: QType;
        level: Level;
        counted: number;
        passed: number;
        passRate: number | null;
        medianMs: number | null;
      }[];
    }
  | {
      kind: 'timeline';
      sessions: {
        sessionId: string;
        startedAt: string;
        endedAt: string | null;
        mode: Mode;
        branch: string | null;
        commit: string | null;
        dirty: boolean;
        asked: number;
        passed: number;
      }[];
      maps: { at: string; commit: string | null; raised: string[] }[];
    };
export function chartData(
  kind: ChartKind,
  map: MapInput,
  model: Model,
  events: LogEvent[],
): ChartData; // stats.ts
export function bar(fraction: number, width: number): string;
export function sparkline(values: (number | null)[]): string;
export function formatDuration(ms: number): string;
export function renderText(data: ChartData): string;
export function escapeHtml(text: string): string;
export function renderHtml(charts: ChartData[], title: string): string;
```

Commands: `chart <kind> --format text|json|html` (default `text`; an unknown kind is exit 2) and `report --format text|html [--out <path>]` (all five kinds; `--out` writes the file and prints its path; `--out` inside the studied repository's root is refused with exit 2). Both need a map (exit 1 without).

Format rules from the spec: text uses Unicode bars and sparklines; HTML is one self-contained page with inline SVG, no script, no external resource, colours from CSS variables with a `prefers-color-scheme: dark` block; a state is never shown by colour alone (the stale and untested marks are also words).

- [ ] **Step 1: Write the failing tests** `test/charts.spec.ts`

```ts
it('bar fills in proportion', () => {
  expect(bar(0.5, 10)).toBe('█████░░░░░');
  expect(bar(0, 4)).toBe('░░░░');
  expect(bar(1.2, 4)).toBe('████');
});
it('sparkline scales to its range and shows a gap for null', () => {
  expect(sparkline([0, 0.5, 1])).toBe('▁▄█');
  expect(sparkline([1, null, 1])).toBe('█ █');
  expect(sparkline([])).toBe('');
});
it('formatDuration', () => {
  expect(formatDuration(45_000)).toBe('45s');
  expect(formatDuration(125_000)).toBe('2m 05s');
});
it('levels text names every area, level label and mark', () => {
  /* hold a maintain, raise a, b untested →
  text contains each title, 'Ready to be interviewed on it', 'stale (was maintain)', 'untested', and the verdict label */
});
it('accuracy, speed, types and timeline data match a two-session log', () => {
  /* exact numbers for passRate, medianMs, counted per type, branch and commit per session, raised areas per map event */
});
it('every kind renders text for an empty history without throwing');
it('html is self-contained and escapes text', () => {
  const html = renderHtml(
    allCharts(mapWithTitle('<script>alert(1)</script>')),
    'octo-org/hello-world',
  );
  expect(html).toContain('<svg');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toMatch(/<script|src=|href=|@import|url\(/i);
  expect(html).toContain('prefers-color-scheme: dark');
});
```

Add to `test/cli-read.spec.ts`: `chart levels --format json` returns `kind: 'levels'`; `chart nope` exits 2; `report --format html --out <temp path>` writes a file that starts with `<!doctype html>`; `report --out <path inside the repository root>` exits 2.

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `chartData`, the two renderers and the two commands. `sparkline` uses `▁▂▃▄▅▆▇█`, index `round((v - min) / (max - min) * 7)`, the top block when all values are equal, and a space for `null`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(repo-ready): charts and report`.

---

### Task 10: End-to-end session test

**Files:**

- Create: `test/e2e.spec.ts`

**Interfaces:**

- Consumes: `runCli`, `fakeGit`, `clock`, the whole CLI.

- [ ] **Step 1: Write the test.** One test, one state folder, a fake repository at `/w` with origin `git@github.com:octo-org/hello-world.git`, branch `main`, head `c1`, clock from `2026-01-05T09:00:00.000Z`:

  1. `map set` the sample map → code 0.
  2. `session start --mode learn`; ask `a`/`read`/`explain`, advance 40 s, answer, grade 4; ask `a`/`read`/`trace`, advance 60 s, answer, grade 3; the same two for `b`; `session end --json` → `summary` has `asked: 4`, `passed: 4`, `medianMs: 50000`; `verdict` is `{ kind: 'level', level: 'read', label: 'Ready to be interviewed on it' }`.
  3. Move the fake repository to head `c2` with `diffs['c1..c2'] = ['src/a/x.ts']`. `map changes --json` lists area `a`. `map set` the map with `a.revision: 2` → changes contain `{ kind: 'revision_raised', areaId: 'a', from: 1, to: 2 }`.
  4. `levels --json`: area `a` is `{ level: 'none', stale: true, staleFrom: 'read' }`, area `b` is still `read`, verdict kind `not_enough_evidence`. `next --json`: first target `{ areaId: 'a', level: 'read', reason: 'stale' }`.
  5. `session start --mode interview`; two `a`/`read` questions graded 4; `session end --json` → area `a` `{ level: 'read', stale: false }`, verdict level `read`.
  6. `history --json` has 6 questions; the two newest have `commit: 'c2'`, the oldest `commit: 'c1'`.
  7. `report --format text` contains "Ready to be interviewed on it" and the titles of all three areas; `chart timeline --format json` has 2 sessions and 2 map entries, the second with `raised: ['a']`.

- [ ] **Step 2: Run.** `npm test -w @ai-tools/repo-ready`. Expected: PASS. A failure here is a defect in Tasks 5 to 9: fix it there, with a unit test for the cause.
- [ ] **Step 3: Commit** `test(repo-ready): end-to-end session`.

---

### Task 11: Skills for Claude Code, Codex and OpenCode

**Files:**

- Create: `skills/claude-code/repo-ready/SKILL.md`, `skills/codex/repo-ready.md`, `skills/opencode/repo-ready.md`, `tools/repo-ready/test/skills.spec.ts`
- Modify: `skills/generic/AGENTS.md.snippet.md`, `skills/README.md`

**Interfaces:**

- Consumes: the CLI surface of Tasks 7 to 9. Verify every flag against `node tools/repo-ready/dist/cli.js <command> --help`; do not write a flag from memory.

Each file has the header its platform uses (copy from the `gh-watcher` file beside it). Claude Code frontmatter: `name: repo-ready`, `description: Teach and quiz a person on a repository's design, track every answer, and report whether they are ready to be interviewed on it, work on it or own it. Use when someone asks to learn a codebase, be quizzed on it, or check their readiness.` The body is the same in all three, except the chart section. Sections, in this order:

1. **When to use**, and the requirement: `repo-ready` on `PATH`, or `<repo>/tools/repo-ready/dist/cli.js`.
2. **Rules.** The agent: never edits the state files, only calls the CLI; never writes into the studied repository (the map file goes in a temporary folder outside it); grounds every question in `path:line` evidence it has read; asks no trivia (a name may appear in a question, but the answer must need understanding); never states a level or verdict of its own, only what the CLI printed, with the label; uses `map set --force` only when the person asks for the map to be redrawn; keeps lessons to about 150 to 300 words.
3. **Build the map.** What to read (README, agent and contributor guides, entry points, tests, recent history for design decisions); what an area is and is not; 1 to 10 areas, never padded; which areas are key; a complete JSON example with one area and one principle, using `octo-org/hello-world`-style paths; the `map set` command; show the person the list of areas.
4. **Start of every session.** `status --json`; no map → build it; map → `map changes --json`, re-read the changed areas, raise `revision` only where the design changed, `map set`, tell the person which areas went stale; show the progress chart; ask for the mode and any focus areas; `session start`.
5. **The loop.** The six steps of the spec's session section with the exact commands, including: call `answer` before grading; one follow-up at most per question from `next`, with `--follow-up-of`; stop when `next` reports `done` or the person stops.
6. **Modes.** The spec's modes table.
7. **Question types.** For each of the six types: its level and one sentence on what a good question of that type asks.
8. **Grading.** The 0 to 4 rubric, word for word from the spec; grade against the evidence, not against style; record gap tags as short lower-case slugs and reuse existing tags.
9. **End of session.** `session end`; show the verdict with its label, the gaps and the charts; in interview mode lead with the session summary, then give the debrief for each question with its evidence.
10. **Charts.** All three: show `chart <kind> --format text` output in a code block. Claude Code only: where the session has a tool that shows HTML in chat, pass it `report --format html` output instead; never start a server to show a chart.
11. **Command reference.** One line per command.

- [ ] **Step 1: Write the failing test** `tools/repo-ready/test/skills.spec.ts`

````ts
const FILES = ['claude-code/repo-ready/SKILL.md', 'codex/repo-ready.md', 'opencode/repo-ready.md'];
const COMMANDS = [
  'status',
  'map set',
  'map show',
  'map changes',
  'session start',
  'session end',
  'session list',
  'teach',
  'ask',
  'hint',
  'answer',
  'grade',
  'skip',
  'next',
  'levels',
  'history',
  'chart',
  'report',
  'export',
  'reset',
];
const LABELS = [
  'Ready to be interviewed on it',
  'Ready to work on it',
  'Ready to own it',
  'Not yet ready',
  'Not enough evidence yet',
];
it.each(FILES)('%s names every command and label', async (file) => {
  const text = await readFile(new URL(`../../../skills/${file}`, import.meta.url), 'utf8');
  for (const c of COMMANDS) expect(text).toContain(`repo-ready ${c}`);
  for (const l of LABELS) expect(text).toContain(l);
  expect(text).toContain('--follow-up-of');
});
it('the three bodies differ only in header and chart section', async () => {
  /* strip the frontmatter or title block and the "## Charts" section from each; the remainders are equal */
});
it('the JSON example in the skill is a valid map', async () => {
  /* extract the first ```json block from the Claude Code file and pass it to validateMap */
});
````

- [ ] **Step 2: Run.** Expected: FAIL, files missing.
- [ ] **Step 3: Write the three skill files**, then add a `### repo-ready` section to `skills/generic/AGENTS.md.snippet.md` (purpose in one sentence, the session loop as a command list, the rules of section 2 in short form) and add the three files to the install matrix and install examples in `skills/README.md`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(skills): repo-ready for Claude Code, Codex and OpenCode`.

---

### Task 12: Documentation, release wiring, full checks

**Files:**

- Create: `tools/repo-ready/README.md`
- Modify: `README.md`, `AGENTS.md`, `.github/workflows/release.yml`

- [ ] **Step 1: Write `tools/repo-ready/README.md`:** what it is; the split between agent and CLI; the command table with every flag; the map JSON format; the level, stale and verdict rules with the constants; what is stored and where (`~/.local/state/ai-tools/repo-ready/repos/<name>/`, `AI_TOOLS_REPO_READY_STATE_DIR`); that time taken runs from question recorded to reply recorded and includes reading and typing; that full question and answer text stays on the machine, with `export` and `reset --yes`; exit codes.
- [ ] **Step 2: Update the root `README.md`:** a row in the Tools table; `repo-ready` in the install and release text where the other tools are named; a row in the state table; a line under Privacy and security (no network calls; answers are stored locally); the monorepo layout.
- [ ] **Step 3: Update `AGENTS.md`:** add `tools/repo-ready/` to the repo map.
- [ ] **Step 4: Update `.github/workflows/release.yml`:** add `'repo-ready-v*'` to the tag patterns and `- repo-ready` to the `tool` choices.
- [ ] **Step 5: Run every check from the repo root.**

```sh
npm run lint && npm run typecheck && npm run build && npm test
npx prettier --check tools/repo-ready skills README.md AGENTS.md docs/superpowers .github/workflows/release.yml
PKG_TARGETS=node22-linux-x64 npm run build:bin -w @ai-tools/repo-ready && npm run rename:bins
tools/repo-ready/bin/repo-ready-linux-x64 --version
git diff --exit-code -- actions
```

Expected: all pass; the binary prints `0.1.0`; `actions` is unchanged. Fix prettier findings with `npx prettier --write` on the same paths only.

- [ ] **Step 6: Commit** `docs(repo-ready): tool README, repo docs and release wiring`.

---

### Task 13: Acceptance run, pull request, release

- [ ] **Step 1: Acceptance run on this repository,** with `AI_TOOLS_REPO_READY_STATE_DIR` set to a temporary folder and the Claude Code skill followed as written: build a map of `ai-tools`; run one short learn session and one short interview session with real typed answers; commit a change to one mapped file on a scratch branch in a scratch clone; confirm `map changes` names the area, a revision rise marks it stale, and two passes bring the level back; view `report --format text` and `report --format html`. Write down every place where the skill text was unclear or a command failed, fix it, and rerun the affected tests.
- [ ] **Step 2: Open the pull request** from `repo-ready` to `main`, titled `feat: repo-ready readiness quiz CLI and skills (9.21)`. Set 9.21 to `in_review` with the link. Wait for CI with `gh-watcher`.
- [ ] **Step 3: After the pull request is merged,** set 9.21 to `done` with the evidence, then release: run the Release workflow on `main` with `tool=repo-ready`, `version=0.1.0`, wait for it, download one binary and verify it against `checksums.txt`. Set 9.22 to `done` with the run id. Merging the pull request needs the owner's go-ahead unless they have already given it.

---

## Self-Review Notes

- **Spec coverage:** every row of the spec's CLI table has a command in Tasks 7 to 9; map rules are Task 4; level, stale and verdict rules are Task 5; adapting is Task 6; tracking fields are the `LogEvent` types in Task 1 and `record` in Task 7; charts are Task 9; the three skills and the generic snippet are Task 11; docs and release are Task 12; the manual run is Task 13.
- **Plan calls beyond the spec** (each is consistent with it): a revision rise needs a changed file in the area or `--force`; evidence paths must exist; an area with 3 questions in a session moves to the back of `next`; a new `session start` closes an abandoned session; `hint` is refused in interview mode; `report --out` may not point inside the studied repository.
