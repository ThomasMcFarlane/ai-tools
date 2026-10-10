import { describe, expect, test } from 'claude-code/testing'

import { ETA_W, epicEta, shortEta, fillTemplate, matchTemplate, parseRemote, repoFromCwd, worktreePaths, worktreeTag, mergeBoards, changedSinceFork, parseTarget, lintBoard, checkBoard, shouldLaunchFix, FIX_WINDOW_MS, STATE_BUDGET, ACTIVE_MS, pickBoard, numColumnWidth, slimTasks, barColumns, isActive, trackChanges, extractEta, boardCandidates, epicLabel, groupByEpic, isBlockedOnYou, parseBoard, headerRuns, ruleLine, subHeader, rowIds, parseIds, tableLine, wrapText } from './board'
import { DEFAULT_CONFIG, readConfig } from './config'
import { fixPrompt } from './format'

const FIXTURE = `# Tasks

## Epic one

| # | Task | Status | Owner | Depends on | Acceptance |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Do \`a\` thing | in_progress | claude-1-ci (alias, other) | 2 | Needs [link](http://x). ETA: 2 days. More. |
| 2 | Spare | done | ui | | fine |

### Epic two

| # | Task | Status | Owner | Depends on | Acceptance and evidence |
| --- | --- | --- | --- | --- | --- |
| 3 | Wait | blocked | owner | | Owner approval needed |
| 4 | Wait too | blocked | claude-9 | | tests red |
| 5 | Other | in progress | claude-9 | | none |
| 6 | Later | todo | unassigned | | owner decision pending |
`

describe('board parser', () => {
  const tasks = parseBoard(FIXTURE)
  const by = (n: number) => tasks.find(t => t.n === n)!

  test('reads rows from several tables with their epic', () => {
    expect(tasks.length).toBe(6)
    expect(by(1).epic).toBe('Epic one')
    expect(by(3).epic).toBe('Epic two')
  })
  test('normalises both status spellings', () => {
    expect(by(1).status).toBe('in_progress')
    expect(by(5).status).toBe('in_progress')
    expect(by(6).status).toBe('todo')
  })
  test('extracts owner agent and ETA', () => {
    expect(by(1).agent).toBe('claude-1-ci')
    expect(by(1).eta).toBe('2 days')
    expect(by(4).eta).toBe('')
  })
  test('detects blocked-on-you', () => {
    expect(isBlockedOnYou(by(3))).toBe(true)
    expect(isBlockedOnYou(by(4))).toBe(false)
    expect(isBlockedOnYou(by(6))).toBe(false)
  })
  test('extracts row numbers from an edit string', () => {
    expect(rowIds('| 65 | x | done |\ntext\n  | 7 | y |\n| PZ-001 | z |')).toEqual(['65', '7', 'PZ-001'])
    expect(parseIds(['65', 'pz-001', 'x'])).toEqual(['65', 'PZ-001'])
  })
})

describe('board path resolution', () => {
  // An example layout: primary boards under {root}/main/{org}/{repo}, task worktrees and mirrors elsewhere.
  const cfg = {
    baseBoard: '{root}/main/{org}/{repo}/TASKS.md',
    reposRoot: '/work/repos',
    repoPatterns: ['{root}/trees/{org}/{task}/{repo}', '{root}/mirrors/{org}/{repo}'],
  }
  const generic = { baseBoard: '', reposRoot: '', repoPatterns: [] as string[] }
  const R = cfg.reposRoot

  test('templates match paths, also from deeper inside the repo', () => {
    expect(matchTemplate('{root}/trees/{org}/{task}/{repo}', R, `${R}/trees/Org/t1/app/src/x`)).toEqual({ org: 'Org', task: 't1', repo: 'app' })
    expect(matchTemplate('{root}/trees/{org}/{task}/{repo}', R, `${R}/trees/Org/t1/app/src`, true)).toBeUndefined()
    expect(repoFromCwd(`${R}/mirrors/Org/app`, cfg)).toEqual({ org: 'Org', repo: 'app' })
    expect(repoFromCwd('/elsewhere', cfg)).toBeUndefined()
    expect(fillTemplate(cfg.baseBoard, { org: 'Org', repo: 'app', root: R })).toBe(`${R}/main/Org/app/TASKS.md`)
    expect(worktreeTag(`${R}/trees/Org/t1/app`, cfg)).toBe('t1')
    expect(worktreeTag('/a/b/feature-x', generic)).toBe('feature-x')
  })
  test('configured: the primary board comes first, then the git main worktree, then the walk-up', () => {
    const c = boardCandidates(`${R}/trees/Org/t1/app/src`, cfg, '/work/main-checkout')
    expect(c.map(x => x.path).slice(0, 3)).toEqual([`${R}/main/Org/app/TASKS.md`, '/work/main-checkout/TASKS.md', `${R}/trees/Org/t1/app/src/TASKS.md`])
    expect(c.map(x => x.source).slice(0, 3)).toEqual(['primary', 'primary', 'walkup'])
    expect(c.some(x => x.path === `${R}/TASKS.md`)).toBe(false) // the walk-up stops at the root
  })
  test('generic: the git main worktree first, then the walk-up to the filesystem root', () => {
    const c = boardCandidates('/a/b/c', generic, '/a/b')
    expect(c.map(x => x.path)).toEqual(['/a/b/TASKS.md', '/a/b/c/TASKS.md', '/a/TASKS.md'])
    expect(c[0]!.source).toBe('primary')
    expect(boardCandidates('/tmp/x', generic).map(x => x.path)).toEqual(['/tmp/x/TASKS.md', '/tmp/TASKS.md'])
  })
  test('direct target beats primary, primary beats walk-up', async () => {
    const c = boardCandidates(`${R}/trees/Org/t1/app`, cfg, '')
    const all = async () => true
    expect(await pickBoard(parseTarget('Org/other', cfg), c, all)).toEqual({ path: `${R}/main/Org/other/TASKS.md`, source: 'override' })
    expect(await pickBoard('', c, all)).toEqual({ path: `${R}/main/Org/app/TASKS.md`, source: 'primary' })
    expect(await pickBoard('', c, async p => p.includes('/t1/'))).toEqual({ path: `${R}/trees/Org/t1/app/TASKS.md`, source: 'walkup' })
    expect(await pickBoard('', c, async () => false)).toEqual({ path: '', source: 'none' })
  })
  test('parseTarget: org/repo (only with a primary template), file, directory', () => {
    expect(parseTarget('Org/app', cfg)).toBe(`${R}/main/Org/app/TASKS.md`)
    expect(parseTarget('Org/app', generic)).toBe('Org/app/TASKS.md')
    expect(parseTarget('/x/y/TASKS.md', cfg)).toBe('/x/y/TASKS.md')
    expect(parseTarget('/x/y/', cfg)).toBe('/x/y/TASKS.md')
    expect(parseTarget('docs/TASKS.md', cfg)).toBe('docs/TASKS.md')
  })
  test('git output: worktree list and remote url', () => {
    expect(worktreePaths('worktree /a/main\nHEAD abc\nbranch refs/heads/main\n\nworktree /a/wt1\nHEAD def\n')).toEqual(['/a/main', '/a/wt1'])
    expect(parseRemote('git@github.com:Some-Org/the.repo.git\n')).toEqual({ org: 'Some-Org', repo: 'the.repo' })
    expect(parseRemote('https://github.com/Some-Org/app')).toEqual({ org: 'Some-Org', repo: 'app' })
    expect(parseRemote('')).toBeUndefined()
  })
})

describe('formatting agent prompt', () => {
  test('is generic without extra instructions', () => {
    const p = fixPrompt('org/app', '/x/TASKS.md', '20261009')
    expect(p).toContain('org/app')
    expect(p).toContain('/x/TASKS.md')
    expect(p).toContain('board-format-20261009')
    expect(p).toContain('Do NOT merge')
    expect(p).toContain('## <N>. <Epic name>')
    expect(p).toContain('tasks-board-check-v2')
    expect(p).toContain('<epic>.<task>')
    expect(p).not.toContain('Additional rules')
  })
  test('appends the configured instructions verbatim', () => {
    expect(fixPrompt('org/app', '/x/TASKS.md', '20261009', 'Use tool X.')).toContain('Additional rules:\nUse tool X.')
  })
  test('options are read with defaults and splitting', () => {
    expect(readConfig({})).toEqual(DEFAULT_CONFIG)
    const c = readConfig({ repoPatterns: 'a/{org}/{repo}; b/{org}/{repo}\nc', ownerNames: 'Ann, Bo', autofix: false, maxWorktrees: 5, reposRoot: '/r/' })
    expect(c.repoPatterns).toEqual(['a/{org}/{repo}', 'b/{org}/{repo}', 'c'])
    expect(c.ownerNames).toEqual(['Ann', 'Bo'])
    expect(c.autofix).toBe(false)
    expect(c.maxWorktrees).toBe(5)
    expect(c.reposRoot).toBe('/r')
  })
})

test('wrapText wraps on words and cuts overlong ones', () => {
  expect(wrapText('aa bb cc dd', 5)).toEqual(['aa bb', 'cc dd'])
  expect(wrapText('abcdefgh', 3)).toEqual(['abc', 'def', 'gh'])
  expect(wrapText('', 4)).toEqual([''])
})

const PZ = `# Tasks

## Epic A

| # | Task | Status | Owner | Notes |
|---|------|--------|-------|-------|
| PZ-001 | First | done | me | ok |
| PZ-002 | Second | in-progress | me (x) | ETA: 3h |
| PZ-003 | Third | todo | | later |

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Use X | because |

| # | Question | Status |
|---|----------|--------|
| Q1 | Why? | open |
`

const AIS = `## Work

| # | Task | Status | Owner | Notes |
| --- | --- | --- | --- | --- |
| 1 | a | Done | | |
| 2 | b | In review | | |
| 3 | c | Backlog | | |
| 4 | d | Blocked | owner | approval |
| 5 | e | Planned | | |
| 6 | f | weird | | |
`

test('Prefixed-id board: prefixed ids, 5 columns, non-task tables skipped, hyphenated status', () => {
  const t = parseBoard(PZ)
  expect(t.map(x => x.id)).toEqual(['PZ-001', 'PZ-002', 'PZ-003'])
  expect(t.map(x => x.status)).toEqual(['done', 'in_progress', 'todo'])
  expect(t[1]!.n).toBe(2)
  expect(t[1]!.eta).toBe('3h')
  expect(t[1]!.notes).toBe('ETA: 3h')
  expect(t[1]!.depends).toBe('')
  expect(numColumnWidth(t)).toBe(8)
})

test('capitalised and unusual statuses are normalised', () => {
  expect(parseBoard(AIS).map(x => x.status)).toEqual(['done', 'in_progress', 'todo', 'blocked', 'todo', 'todo'])
})

const CF = `# Tasks

| # | Task | Status | Picked up by | Notes |
|---|------|--------|--------------|-------|
| CF-EMAIL-ROUTING-01 | Cloudflare Email Routing | done (live 9 October 2026) | claude | x |
| CF-BROKER-URL-01 | Point the broker | done (merged #337) | claude / broker-url | y |
| CF-A-01 | Chrome | done — merged, on main | claude | z |
| CF-B-01 | Partly | partly done | claude / b | w |
| CF-C-02 | Working | in progress | claude | w |
| CF-D-03 | Paused | pending (paused in chart, PR opened, not merged) | | w |
| CF-E-04 | Start | open, not started | | w |
| CF-F-05 | Notes | recorded | | w |
| CF-G-06 | Wait | waiting on owner | owner | w |
`

test('Multi-segment-id board: long ids, Picked up by, free-text statuses', () => {
  const t = parseBoard(CF)
  expect(t.map(x => x.status)).toEqual(['done', 'done', 'done', 'in_progress', 'in_progress', 'todo', 'todo', 'done', 'blocked'])
  expect(t[0]!.id).toBe('CF-EMAIL-ROUTING-01')
  expect(t[0]!.n).toBe(1)
  expect(t[0]!.agent).toBe('claude')
  expect(t[1]!.owner).toBe('claude / broker-url')
  expect(numColumnWidth(t)).toBe(18)
})

test('rows after prose or blank lines inside a table still belong to it', () => {
  const t = parseBoard('| # | Task | Status | Owner | Notes |\n|--|--|--|--|--|\n| 1 | a | todo | | |\n\nsome prose\n\n| 2 | b | todo | | |')
  expect(t.map(x => x.id)).toEqual(['1', '2'])
})

test('the # cell fits the widest number plus spinner', () => {
  const rows = parseBoard('## Task 443: big\n\n| # | Task | Status | Owner | Depends on | n |\n| - | - | - | - | - | - |\n| 1234 | a | todo | x | | n |\n| 5 | b | todo | x | | n |')
  const numW = numColumnWidth(rows)
  expect(numW).toBe(6)
  expect(numColumnWidth([])).toBe(3)
  expect(('⠋' + '1234'.padStart(numW - 1)).length).toBe(numW)
})

test('header, blank row, task row and rules put borders in the same columns', () => {
  for (const numW of [3, 5, 6])
  for (const [w, a, e] of [[44, false, true], [60, true, true], [30, false, false]] as const) {
    const taskW = Math.max(6, w - (11 + numW) - (a ? 15 : 0) - (e ? ETA_W + 3 : 0))
    const bars = barColumns(taskW, a, e, numW)
    const cols = (s: string) => [...s].flatMap((ch, i) => (ch === '│' ? [i] : []))
    for (const line of [tableLine({ num: '#', task: 'Task', agent: 'Agent', eta: 'ETA' }, taskW, a, e, numW), tableLine({}, taskW, a, e, numW), tableLine({ num: '65', task: 'x'.repeat(99), agent: 'y', eta: '2d' }, taskW, a, e, numW)]) {
      expect(cols(line)).toEqual(bars)
      expect(line.length).toBe(w)
    }
    // the header's pad rows (blank lines) carry the borders in the same columns as the label row
    expect(cols(tableLine({}, taskW, a, e, numW))).toEqual(cols(tableLine({ num: '#', task: 'Task', agent: 'Agent', eta: 'ETA' }, taskW, a, e, numW)))
    const runs = headerRuns(tableLine({ num: '#', task: 'Task' }, taskW, a, e, numW), bars)
    expect(runs.map(r => r.kind)).toEqual(['blank', 'edge', 'fill', 'edge', 'blank'])
    expect(runs[0]!.text.length).toBe(bars[0])
    expect(runs.map(r => r.text).join('').length).toBe(w)
    expect(runs.some(r => r.text.includes('│'))).toBe(false)
    expect(runs[1]!.text + runs[3]!.text).toBe('▐▌')
    expect(runs[2]!.text.length).toBe(bars[bars.length - 1]! - bars[0]! - 1)
    const rule = ruleLine(w, '┴', bars)
    expect([...rule].flatMap((ch, i) => (ch === '┴' ? [i] : [])).join()).toBe(bars.slice(1, -1).join())
    expect(bars[bars.length - 1]).toBe(w - 3)
    expect(rule[w - 3]).toBe('┤')
    expect(rule.length).toBe(w)
    expect(rule[2]).toBe('├')
    const F = bars[0]!
    const L = bars[bars.length - 1]!
    for (const row of ['top', 'title', 'bottom'] as const) {
      const runs = subHeader('IN PROGRESS', 12, w, bars, row)
      const text = runs.map(r => r.text).join('')
      expect(text.length).toBe(w)
      expect(text[F]).toBe('▐')
      expect(text[L]).toBe('▌')
      expect(text.slice(0, F).trim()).toBe('')
      expect(text.slice(L + 1).trim()).toBe('')
      const between = text.slice(F + 1, L)
      expect(text.includes('▄') || text.includes('▀')).toBe(false)
      if (row !== 'title') expect(between).toBe(' '.repeat(L - F - 1))
      if (row === 'title') expect(between.startsWith(' IN PROGRESS (12)') || L - F - 1 < 18).toBe(true)
    }
  }
})

test('ETA extraction is strict', () => {
  expect(extractEta('see record-eta) legs')).toBe('')
  expect(extractEta('record-ETA) legs')).toBe('')
  expect(extractEta('goal-ETA seams')).toBe('')
  expect(extractEta('ETA: 14:00 ICT')).toBe('14:00 ICT')
  expect(extractEta('ETA ~2h')).toBe('~2h')
  expect(extractEta('ETA 2026-10-10; later')).toBe('2026-10-10')
  expect(extractEta('ETA: tomorrow.')).toBe('tomorrow')
  expect(extractEta('ETA soon')).toBe('')
})

test('active rows: touched during a turn, or changed within 30 minutes; first load seeds nothing', () => {
  const rows = parseBoard(FIXTURE)
  const first = trackChanges(undefined, rows, 1_000_000)
  const ctx = { touched: [] as string[], isTurnRunning: false, changes: first, now: 1_000_000 }
  expect(isActive({ id: '1', key: '1' }, ctx)).toBe(false)
  expect(isActive({ id: '1', key: '1' }, { ...ctx, touched: ['1'], isTurnRunning: true })).toBe(true)
  expect(isActive({ id: '1', key: '1' }, { ...ctx, touched: ['1'] })).toBe(false)
  const edited = rows.map(t => (t.id === '3' ? { ...t, line: t.line + ' x' } : t))
  const next = trackChanges(first, edited, 2_000_000)
  expect(isActive({ id: '3', key: '3' }, { ...ctx, changes: next, now: 2_000_000 + ACTIVE_MS - 1 })).toBe(true)
  expect(isActive({ id: '3', key: '3' }, { ...ctx, changes: next, now: 2_000_000 + ACTIVE_MS })).toBe(false)
  expect(isActive({ id: '1', key: '1' }, { ...ctx, changes: next, now: 2_000_001 })).toBe(false)
})

test('state stays small for a multi-megabyte board', () => {
  // ~1000 rows with 4 KB notes, a tenth of them open (the real board is about 4 MB, ~90 open)
  const row = (n: number, st: string) => `| ${n} | Title ${n} | ${st} | claude-1-x (a, b) | 1 | ${'note '.repeat(800)} |`
  const text = '## E\n\n| # | Task | Status | Owner | Depends on | Acceptance |\n| --- | --- | --- | --- | --- | --- |\n' +
    Array.from({ length: 1000 }, (_, i) => row(i + 1, i % 10 === 0 ? 'in_progress' : 'done')).join('\n')
  expect(text.length).toBeGreaterThan(4_000_000)
  const all = parseBoard(text)
  const open = all.filter(t => t.status !== 'done')
  const state = JSON.stringify({ tasks: slimTasks(all), rows: trackChanges(undefined, open, 0) })
  expect(state.length).toBeLessThan(150_000)
  expect(slimTasks(all).every(t => t.notes.length <= 300 && t.line === '')).toBe(true)
})

describe('epic grouping', () => {
  test('### sub-sections inherit the numbered parent epic', () => {
    const H = '| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |\n|---|---|---|---|---|---|---|---|\n'
    const row = (id: string) => `| ${id} | t | todo | | | | | |\n`
    const board = `# Tasks\n\n## 3. Backlog\n\n### Git hosting\n\n${H}${row('G-1')}\n### Security\n\n${H}${row('S-1')}\n### Plain\n\n${H}${row('P-1')}\n## Loose\n\n### Sub\n\n${H}${row('L-1')}`
    const tasks = parseBoard(board)
    expect(tasks.map(t => t.id)).toEqual(['G-1', 'S-1', 'P-1', 'L-1'])
    expect(tasks.map(t => epicLabel(t.epic))).toEqual([
      { num: '3', name: 'Backlog › Git hosting' },
      { num: '3', name: 'Backlog › Security' },
      { num: '3', name: 'Backlog › Plain' },
      { num: '', name: 'Sub' },
    ])
    expect(groupByEpic(tasks, tasks, () => 0).map(g => g.epic)).toEqual(['3. Backlog › Git hosting', '3. Backlog › Security', '3. Backlog › Plain', 'Sub'])
  })
  test('epic heading with a task number splits into number and name', () => {
    expect(epicLabel('Task 443: comprehensive code mode')).toEqual({ num: '443', name: 'comprehensive code mode' })
    expect(epicLabel('3. Code mode')).toEqual({ num: '3', name: 'Code mode' })
    expect(epicLabel('12. Task 5: x')).toEqual({ num: '12', name: 'Task 5: x' })
    expect(epicLabel('Epic one')).toEqual({ num: '', name: 'Epic one' })
  })
  const all = parseBoard(FIXTURE)
  test('epics keep file order, rows sort by rank then number, empty epics drop', () => {
    const visible = all.filter(t => t.status !== 'done')
    const rank = (t: { status: string; n: number }) => (t.n === 5 ? 0 : t.status === 'in_progress' ? 2 : t.status === 'blocked' ? 3 : 4)
    const g = groupByEpic(all, visible, rank)
    expect(g.map(x => x.epic)).toEqual(['Epic one', 'Epic two'])
    expect(g[1]!.rows.map(t => t.n)).toEqual([5, 4, 3, 6]) // tie on rank: agent "claude-9" sorts before "owner"
    expect(groupByEpic(all, all.filter(t => t.n === 3), rank).map(x => x.epic)).toEqual(['Epic two'])
  })
})

// The test environment has no $.fs, so this is a (clipped) excerpt of the real file, not a live read.
const REAL = `## Active

| # | Task | Status | Owner | Depends on | Acceptance and evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 65 | Bind verification evidence to the tested commit and restore reachable CI coverage | in_progress | claude-20260922-deploy-fixture-in-image (claude-20260922-hotfix-verify-lib-ci, claude-20260921-task65-runner-spec-dependson, claude-20260921-task65-remainder, release_acceptance) | 6 | \`--commit\` is parsed but not enforced or reported; dependency, blocked-delta, flaky-history and descendant-lea
| 21 | Add Git storage placement, routing, replication, and failover | blocked | claude-20260925-cluster-git-publication-fence (claude-20260922-git-operator-verbs-renewal-helm-git-role (claude-20260922-git-routing-replication (claude-20260922-cluster-authority-dial (claude-20260922-rqlite-sync-bridge, git_hosting)))) | 15-20, 34-36 | Route each repository to one fenced writable primary, drain/reba`

test('smoke: real TASKS.md excerpt has in-progress rows', () => {
  expect(parseBoard(REAL).filter(t => t.status === 'in_progress').length).toBeGreaterThan(0)
})

const CHECK = `# Herdr recovery

## host-io Job deadline 60 s -> 300 s, 2026-10-09

- [ ] \`host-io\` (chart 0.6.2) raises the Job deadline from 60
  to 300. Evidence: the Job failed twice.
  Pending: live verification (Job Complete after Argo sync).

## NVMe health: heat and TRIM, 2026-10-09

- [ ] Owner action. With io.cost floored at \`min=75\` (PR #1023), full I/O
  needs a decision.
- [x] P1: Done thing. It shipped.
- [ ] Plain open item with no special wording at all here.
`

test('checklist boards: synthetic ids, epic date stripped, owner and progress wording', () => {
  const t = parseBoard(CHECK)
  expect(t.map(x => x.id)).toEqual(['1.1', '2.1', 'P1', '2.3'])
  expect(t[0]!.epic).toBe('host-io Job deadline 60 s -> 300 s')
  expect(t[0]!.status).toBe('in_progress')
  expect(t[0]!.notes).toContain('to 300. Evidence')
  expect(t[1]!.status).toBe('blocked')
  expect(t[1]!.agent).toBe('')
  expect(isBlockedOnYou(t[1]!)).toBe(true)
  expect(t[2]!.status).toBe('done')
  expect(t[2]!.title.startsWith('Done thing')).toBe(true)
  expect(t[3]!.status).toBe('todo')
})

test('Free-text statuses with qualifiers', () => {
  const st = (s: string) => parseBoard(`| # | Task | Status | Picked up by | Notes |\n|--|--|--|--|--|\n| 1 | a | ${s} | x | n |`)[0]!.status
  for (const s of ['done - published as v0.3.56 (x)', 'done — closed', 'closed — verdict ok', 'merged via PR [#35](http://x)', 'complete', 'completed', 'published immutable v0.3.x', 'accepted and published in v1', 'fixed', 'fixed and merged via PR', 'superseded', 'cancelled']) expect(st(s)).toBe('done')
  for (const s of ['open', 'runtime check pending', 'reopened', '']) expect(st(s)).toBe('todo')
})

test('Hold, PR and implemented statuses, and heading names', () => {
  const st = (s: string) => parseBoard(`| # | Task | Status | Picked up by | Notes |\n|--|--|--|--|--|\n| 9872 | a | ${s} | x | n |`)[0]!.status
  expect(['done on 9 Oct', 'implemented', 'dropped'].map(st)).toEqual(['done', 'done', 'done'])
  expect(['in progress', 'in PR', 'in review', 'partly done'].map(st)).toEqual(['in_progress', 'in_progress', 'in_progress', 'in_progress'])
  expect(['pending', 'planned'].map(st)).toEqual(['todo', 'todo'])
  expect(st('on hold')).toBe('todo') // legacy deferred without owner evidence
  const t = parseBoard('## Active: Server write queue (2026-10-09)\n\n| # | Task | Status | Picked up by | Notes |\n|--|--|--|--|--|\n| 9872 | a | done | x | n |')
  expect(t[0]!.epic).toBe('Server write queue')
  expect(t[0]!.id).toBe('9872')
})


const mk = (id: string, status: string, extra: Partial<ReturnType<typeof parseBoard>[number]> = {}) =>
  ({ id, key: id, n: Number(id), title: `T${id}`, status, owner: 'a', agent: 'a', depends: '', notes: '', epic: 'E', eta: '', line: id, ...extra })

test('duplicate ids get unique keys, match worktree rows by occurrence, and lint reports them', () => {
  const text = '| # | Task | Status | Owner | Notes |\n|--|--|--|--|--|\n| 246 | a | todo | | |\n| 247 | b | todo | | |\n| 246 | a2 | todo | | |'
  const t = parseBoard(text)
  expect(t.map(x => x.key)).toEqual(['246', '247', '246#2'])
  expect(t.map(x => x.id)).toEqual(['246', '247', '246'])
  expect(lintBoard(text).issues).toContain('duplicate ID 246')
  const wt = parseBoard(text.replace('| a2 | todo', '| a2 | done'))
  const m = mergeBoards(t, [{ tag: 'w', path: '/p', isOwn: false, tasks: wt }])
  expect(m.map(x => x.key)).toEqual(['246', '247', '246#2@w'])
  expect(m[2]!.id).toBe('246')
  expect(m[2]!.priorStatus).toBe('todo')
})

describe('worktree merge', () => {
  const board = [mk('1', 'todo'), mk('2', 'in_progress'), mk('3', 'todo'), mk('4', 'done')]
  test('identical rows drop, changed rows show tagged, new rows add', () => {
    const wt = { tag: 'ci-infra', path: '/w/ci-infra/r', isOwn: false, tasks: [mk('1', 'todo'), mk('2', 'blocked'), mk('9', 'todo')] }
    const m = mergeBoards(board, [wt])
    expect(m.map(t => t.key)).toEqual(['1', '2@ci-infra', '3', '4', '9@ci-infra'])
    expect(m[1]!.tag).toBe('ci-infra')
    expect(m[1]!.wtPath).toBe('/w/ci-infra/r')
  })
  test('a worktree overrides only fields it changed since the fork', () => {
    const base = [mk('1', 'in_progress', { eta: '5m', owner: 'b' })]
    const fork = [mk('1', 'todo', { eta: '', owner: 'a' })]
    const m = mergeBoards(base, [{ tag: 'w', path: '/p', isOwn: false, fork, tasks: [mk('1', 'blocked', { eta: '', owner: 'a' })] }])
    expect(m[0]!).toMatchObject({ key: '1@w', status: 'blocked', eta: '5m', owner: 'b' })
    expect(mergeBoards(base, [{ tag: 'w', path: '/p', isOwn: false, fork, tasks: fork }])).toEqual(base)
  })
  test('an empty worktree field never blanks a base value', () => {
    const base = [mk('1', 'todo', { eta: '5m', owner: 'b' })]
    const m = mergeBoards(base, [{ tag: 'w', path: '/p', isOwn: false, tasks: [mk('1', 'blocked', { eta: '', owner: '' })] }])
    expect(m[0]!).toMatchObject({ status: 'blocked', eta: '5m', owner: 'b' })
  })
  test('two worktrees changing the same id are both shown beside the base row', () => {
    const a = { tag: 'a', path: '/w/a/r', isOwn: false, tasks: [mk('3', 'in_progress')] }
    const b = { tag: 'b-very-long-folder-name', path: '/w/b/r', isOwn: true, tasks: [mk('3', 'blocked')] }
    const m = mergeBoards(board, [a, b])
    expect(m.filter(t => t.id === '3').map(t => t.key)).toEqual(['3', '3@a', '3@b-very-long-folder-name'])
    expect(m.find(t => t.key === '3@b-very-long-folder-name')!.tag!.length).toBe(14)
    expect(m.find(t => t.key === '3@b-very-long-folder-name')!.isOwn).toBe(true)
  })
  test('a worktree finishing an open base row shows it as done, in the base row\'s place', () => {
    const m = mergeBoards(board, [{ tag: 'a', path: '/p', isOwn: false, tasks: [mk('1', 'done')] }])
    expect(m.length).toBe(4)
    expect(m[0]!.key).toBe('1@a')
    expect(m[0]!.status).toBe('done')
    expect(m[0]!.priorStatus).toBe('todo')
    expect(slimTasks(m).map(t => t.key)).toContain('1@a')
  })
  test('done rows the base already has done, or does not have, are ignored', () => {
    const m = mergeBoards(board, [{ tag: 'a', path: '/p', isOwn: false, tasks: [mk('4', 'done'), mk('77', 'done')] }])
    expect(m.length).toBe(4)
  })
})

const CANON = `# Tasks

## 1. Epic one

| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| PZ-001 | First | in_progress | claude-1 | feat/pz-001 | 1.PZ-002 | 2026-10-10 14:00 ICT | n |
| PZ-002 | Second | blocked_on_owner | | | | | approve |
`

describe('canonical format', () => {
  test('a canonical board lints clean and parses natively', () => {
    expect(lintBoard(CANON)).toEqual({ canonical: true, issues: [], findings: [] })
    const t = parseBoard(CANON)
    expect(t[0]!.eta).toBe('2026-10-10 14:00 ICT')
    expect(t[0]!.depends).toBe('1.PZ-002')
    expect(t[0]!.branch).toBe('feat/pz-001')
    expect(t[1]!.branch).toBeUndefined()
    expect(slimTasks(t)[0]!.branch).toBeUndefined()
    expect(t[1]!.status).toBe('blocked')
    expect(isBlockedOnYou(t[1]!)).toBe(true)
  })
  test('every other style has issues', () => {
    for (const text of [FIXTURE, PZ, AIS, CF, CHECK]) expect(lintBoard(text).canonical).toBe(false)
    expect(lintBoard(CANON.replace('| Branch ', '').replace('|---|---|---|---|---|---|---|---|', '|---|---|---|---|---|---|---|')).issues[0]).toContain('header')
    expect(lintBoard(CANON.replace('in_progress', 'in progress')).issues[0]).toContain('see FORMAT.md, Legacy statuses')
    expect(lintBoard(CANON.replace('2026-10-10 14:00 ICT', 'tomorrow')).issues[0]).toContain('ETA')
  })
  test('launch decision: once per repo per 24 h, only non-canonical, only with autofix on', () => {
    const repo = { org: 'o', repo: 'r' }
    const ctx = { autofix: true, canonical: false, repo, record: undefined as { at: number } | undefined, now: 10 * FIX_WINDOW_MS }
    expect(shouldLaunchFix(ctx)).toBe(true)
    expect(shouldLaunchFix({ ...ctx, canonical: true })).toBe(false)
    expect(shouldLaunchFix({ ...ctx, autofix: false })).toBe(false)
    expect(shouldLaunchFix({ ...ctx, repo: undefined })).toBe(false)
    expect(shouldLaunchFix({ ...ctx, record: { at: ctx.now - FIX_WINDOW_MS + 1 } })).toBe(false)
    expect(shouldLaunchFix({ ...ctx, record: { at: ctx.now - FIX_WINDOW_MS } })).toBe(true)
  })
})

test('stored board stays within the budget for 400 open rows', () => {
  const rows = Array.from({ length: 400 }, (_, i) => mk(String(i + 1), 'todo', { notes: 'n'.repeat(4000), title: 'x'.repeat(300) }))
  const size = JSON.stringify(slimTasks(rows)).length
  expect(size).toBeLessThanOrEqual(STATE_BUDGET)
})

describe('blocked on you needs an explicit owner-gate phrase', () => {
  const row = (status: string, owner: string, notes: string) =>
    parseBoard(`| # | Task | Status | Owner | Notes |\n|--|--|--|--|--|\n| 1 | a | ${status} | ${owner} | ${notes} |`, { ownerNames: ['Ann'] })[0]!
  test('a generic mention in long notes stays "other"', () => {
    const notes = 'Waiting for the worker rollout. ' + 'x'.repeat(400) + ' requires owner sign-off later once approve flow lands.'
    expect(isBlockedOnYou(row('blocked', 'claude-1', notes))).toBe(false)
  })
  test('explicit gates count, wherever they sit in the notes', () => {
    expect(isBlockedOnYou(row('blocked', 'claude-1', 'Blocked on owner decision D7'))).toBe(true)
    expect(isBlockedOnYou(row('blocked', 'claude-1', 'x'.repeat(600) + ' Owner action: rotate the key'))).toBe(true)
    expect(isBlockedOnYou(row('blocked', 'claude-1', 'Ann must decide the budget'))).toBe(true)
    expect(isBlockedOnYou(row('waiting on owner', '', 'n'))).toBe(true)
    expect(isBlockedOnYou(row('blocked', 'Ann', 'n'))).toBe(true)
    expect(isBlockedOnYou(row('blocked', 'owner', 'n'))).toBe(false) // unassigned, not blocked on the owner
    expect(isBlockedOnYou(row('owner', '', 'n'))).toBe(false)
    expect(row('owner', '', 'n').status).toBe('todo')
    expect(isBlockedOnYou(row('todo', 'claude-1', 'Owner decision pending'))).toBe(false)
    expect(isBlockedOnYou(row('blocked', 'claude-1', 'blocked on ci'))).toBe(false)
  })
})

describe('owner gate by board vocabulary', () => {
  const H = '| # | Task | Status | Owner | Notes |\n|--|--|--|--|--|\n'
  const CH = '| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n'
  test('canonical board: only blocked_on_owner is owner-blocked', () => {
    const t = parseBoard(`${CH}| A1 | a | blocked | x | | | | owner decision made earlier |\n| A2 | b | blocked_on_owner | x | | | | n |\n`, { ownerNames: ['Ann'] })
    expect(t.map(isBlockedOnYou)).toEqual([false, true])
  })
  test('non-canonical board keeps the text heuristic, on the latest dated update only', () => {
    const b = (n: string) => parseBoard(`${H}| 1 | a | blocked | x | ${n} |`)[0]!
    expect(isBlockedOnYou(b('Owner decision pending'))).toBe(true)
    expect(isBlockedOnYou(b('2026-10-01 owner decision needed. 2026-10-09 waiting on row 3'))).toBe(false)
    expect(isBlockedOnYou(b('2026-10-09 waiting on row 3. 2026-10-10 owner action: rotate key'))).toBe(true)
  })
})

describe('survey fixes', () => {
  const st = (s: string) => parseBoard(`| # | Task | Status | Owner | Notes |\n|--|--|--|--|--|\n| 1 | a | ${s} | x | n |`)[0]?.status
  test('status lead splits on : and ; and strips markup', () => {
    expect(['done: merged #294', 'complete; closed', '**complete**', '~~done~~', '`done`', '_done_'].map(st)).toEqual(Array(6).fill('done'))
  })
  test('more status words', () => {
    for (const s of ['rejected', 'declined', 'deployed', 'configured', 'not applicable', 'n/a', 're-landed', 'runtime-validated', 'client side done', 'root cause fixed']) expect(st(s)).toBe('done')
    for (const s of ['doing', 'PR open', 'PR #12 open']) expect(st(s)).toBe('in_progress')
    for (const s of ['deferred', 'owner']) expect(st(s)).toBe('todo')
  })
  test('Workstream counts as the task column', () => {
    const t = parseBoard('| ID | Workstream | Status | Owner | Evidence |\n|--|--|--|--|--|\n| W-1 | Build | done | me | ok |')
    expect(t.map(x => x.title)).toEqual(['Build'])
  })
  test('dotted and letter-suffixed ids', () => {
    const t = parseBoard('| # | Task | Status | Owner | Notes |\n|--|--|--|--|--|\n| 3.2.1 | a | todo | | |\n| 12a | b | todo | | |\n| feat/x | c | todo | | |')
    expect(t.map(x => x.id)).toEqual(['3.2.1', '12a'])
    expect(t[1]!.n).toBe(12)
  })
  test('escaped pipes stay in the cell', () => {
    const t = parseBoard('| # | Task | Status | Owner | Notes |\n|--|--|--|--|--|\n| 1 | a \\| b | todo | | x \\| y |')
    expect(t[0]!.title).toBe('a | b')
    expect(t[0]!.notes).toBe('x | y')
  })
  test('a row without a closing pipe continues on the next lines', () => {
    const t = parseBoard('| # | Task | Status | Owner | Notes |\n|--|--|--|--|--|\n| 1 | a | todo | | first part\n  second part |\n| 2 | b | done | | z |')
    expect(t.map(x => x.id)).toEqual(['1', '2'])
    expect(t[0]!.notes).toBe('first part second part')
  })
  test('rows of a benchmark table below a task table are not tasks', () => {
    const t = parseBoard('| ID | Title | Status | Owner |\n|--|--|--|--|\n| W-1 | a | done | x |\n\n| Threads | Time | Rate |\n|--|--|--|\n| 16 | 5.69 | 176 |\n| 24 | 5.72 | 175 |')
    expect(t.map(x => x.id)).toEqual(['W-1'])
  })
})

test('changedSinceFork keeps new rows and rows that differ from the fork point', () => {
  const fork = [mk('1', 'todo'), mk('2', 'todo')]
  const wt = [mk('1', 'todo'), mk('2', 'in_progress'), mk('9', 'todo')]
  expect(changedSinceFork(fork, wt).map(t => t.id)).toEqual(['2', '9'])
  expect(changedSinceFork([], wt).length).toBe(3)
})

describe('lint rules for CI', () => {
  const GOOD = '# Tasks\n\n## 1. E\n\n| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |\n|---|---|---|---|---|---|---|---|\n| A-1 | one | todo | | | | 2026-10-10 14:00 ICT | n |\n| A-2 | two | done | | | | 2026-10-10 14:00 UTC+07:00 | n |\n'
  test('timezone abbreviations and offsets are accepted', () => {
    expect(lintBoard(GOOD).findings).toEqual([])
    for (const eta of ['2026-10-10 14:00 UTC', '2026-10-10 14:00 BST', '2026-10-10 14:00 +07:00', '2026-10-10 14:00 UTC-05', '2026-10-10 14:00 UTC+0530']) {
      expect(lintBoard(GOOD.replace('2026-10-10 14:00 ICT', eta)).findings).toEqual([])
    }
    expect(lintBoard(GOOD.replace('2026-10-10 14:00 ICT', '2026-10-10 14:00')).findings[0]!.rule).toBe('eta')
    expect(lintBoard(GOOD.replace('2026-10-10 14:00 ICT', '10 Oct 14:00 ICT')).findings[0]!.rule).toBe('eta')
  })
  test('findings carry the line and the rule', () => {
    const f = lintBoard(GOOD.replace('| A-2 |', '| A-1 |')).findings
    expect(f).toEqual([{ line: 8, rule: 'duplicate-id', message: 'duplicate ID A-1' }])
    expect(lintBoard(GOOD.replace('todo', 'wip')).findings).toEqual([{ line: 7, rule: 'status', message: 'status "wip" is not one of todo, in_progress, in_review, blocked, blocked_on_owner, parked, done, dropped; see FORMAT.md, Legacy statuses' }])
    expect(lintBoard(GOOD).issues).toEqual([])
  })
  test('padded cells are reported on their line', () => {
    const f = lintBoard(GOOD.replace('| A-1 | one   |', '| A-1 | one   |')).findings
    expect(f).toEqual([])
    const padded = GOOD.replace('| A-1 | one |', '| A-1 |  one  |')
    expect(lintBoard(padded).findings.map(x => `${x.line}:${x.rule}`)).toEqual(['7:padded-cell'])
  })
  test('epic headings need a number, unique on the board; prose headings are exempt', () => {
    const tbl = '\n| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |\n|---|---|---|---|---|---|---|---|\n'
    const row = (id: string, dep = '') => `| ${id} | t | todo | | |${dep ? ` ${dep} ` : ''}| | n |\n`
    const board = (...h: string[]) => '# Tasks\n\n## Conventions\n\nprose\n\n' + h.map((x, i) => `## ${x}\n${tbl}${row(`A-${i + 1}`)}`).join('\n')
    expect(lintBoard(board('1. One', '2. Two')).findings).toEqual([])
    expect(lintBoard(board('One', '2. Two')).findings.map(f => f.rule)).toEqual(['epic-number'])
    expect(lintBoard(board('Task 5: One')).findings.map(f => f.rule)).toEqual(['epic-number'])
    expect(lintBoard(board('1. One', '1. Two')).findings.map(f => `${f.rule}:${f.line}`)).toEqual(['epic-unique:13'])
    expect(checkBoard(board('One', '1. Two', '1. Three'), 'lenient')).toEqual([])
    expect(checkBoard(board('One'), 'canonical').map(f => f.rule)).toEqual(['epic-number'])
  })
  test('Depends entries are <epic>.<task> references that resolve to a row', () => {
    const tbl = '\n| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |\n|---|---|---|---|---|---|---|---|\n'
    const row = (id: string, dep = '') => `| ${id} | t | todo | | |${dep ? ` ${dep} ` : ''}| | n |\n`
    const board = (dep: string) => `# Tasks\n\n## 1. One${tbl}${row('A-1', dep)}${row('12')}\n## 2. Two${tbl}${row('PZ-001')}`
    expect(lintBoard(board('2.PZ-001, 1.12')).findings).toEqual([])
    expect(lintBoard(board('PZ-001')).findings.map(f => f.rule)).toEqual(['depends'])
    expect(lintBoard(board('1.PZ-001')).findings.map(f => f.message)).toEqual(['Depends reference 1.PZ-001 matches no row'])
    expect(lintBoard(board('2.PZ-001, 9')).findings.map(f => f.rule)).toEqual(['depends'])
    expect(checkBoard(board('PZ-001'), 'lenient')).toEqual([])
    expect(checkBoard(board('PZ-001'), 'canonical').map(f => f.rule)).toEqual(['depends'])
  })
  test('checkBoard: canonical fails on everything, lenient only on duplicates and padding', () => {
    const old = '| # | Task | Status | Owner | Notes |\n|---|---|---|---|---|\n| 1 | a | todo | | n |\n| 1 | b | todo | | n |\n- [ ] item\n'
    expect(checkBoard(old, 'canonical').map(x => x.rule).sort()).toEqual(['checklist', 'duplicate-id', 'header'])
    expect(checkBoard(old, 'lenient').map(x => x.rule)).toEqual(['duplicate-id'])
    expect(checkBoard(old.replace('| 1 | a |', '| 1 |  a |'), 'lenient').map(x => x.rule)).toEqual(['padded-cell', 'duplicate-id'])
  })
})

test('Letter+digit ids (F1, F10, AB2a) count in a Status table; decision tables stay out', () => {
  const t = parseBoard(`## Work

| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| F1 | a | done | | | | | |
| F10 | b | todo | | | | | |
| AB2a | c | todo | | | | | |
| ABCDE1 | d | todo | | | | | |

## Decisions

| ID | Decision | Rationale |
|---|---|---|
| D1 | Use X | because |
`)
  expect(t.map(x => x.id)).toEqual(['F1', 'F10', 'AB2a'])
  expect(parseIds(['f1', 'x', 'abcde1'])).toEqual(['F1'])
})

test('shortEta: day, ordinal and time only', () => {
  const ords = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 11: '11th', 12: '12th', 13: '13th', 21: '21st', 22: '22nd', 23: '23rd', 31: '31st' }
  for (const [d, o] of Object.entries(ords)) expect(shortEta(`2026-10-${d.padStart(2, '0')} 02:45 ICT`)).toBe(`${o} 02:45`)
  expect(shortEta('2026-10-11T02:45')).toBe('11th 02:45')
  expect(shortEta('2026-10-11 02:45')).toBe('11th 02:45')
  expect(shortEta('2026-10-11')).toBe('11th')
  expect(shortEta('~2 days')).toBe('~2 days')
  expect(shortEta('')).toBe('')
  expect(shortEta('23rd 02:45').length).toBeLessThanOrEqual(ETA_W)
})

test('rows with an ETA keep equal width', () => {
  const taskW = 20
  const bars = barColumns(taskW, true, true, 3)
  for (const eta of [shortEta('2026-10-23 02:45 ICT'), 'x'.repeat(30)]) {
    const line = tableLine({ num: '1', task: 't', agent: 'a', eta }, taskW, true, true, 3)
    expect(line.length).toBe(bars[bars.length - 1]! + 3)
  }
})

test('parked is a canonical status, parses as parked, is never owner-blocked and is excluded from epicEta', () => {
  const CH = '| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |\n|---|---|---|---|---|---|---|---|\n'
  const text = `# Tasks\n\n## 1. E\n\n${CH}| A-1 | a | parked | | | | | Parked by owner 2026-10-09: hold; resumes when web is done |\n`
  expect(lintBoard(text).findings).toEqual([])
  const rows = parseBoard(text)
  expect(rows.map(t => t.status)).toEqual(['parked'])
  expect(rows.map(isBlockedOnYou)).toEqual([false])
  const r = (eta: string, status: string) => ({ eta, status }) as never
  expect(epicEta([r('2026-12-01 09:00 ICT', 'parked'), r('2026-10-20 08:00 ICT', 'todo')])).toBe('2026-10-20 08:00 ICT')
})

describe('legacy statuses', () => {
  const CH = '| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |\n|---|---|---|---|---|---|---|---|\n'
  const board = (status: string, notes: string) => `# Tasks\n\n## 1. E\n\n${CH}| A-1 | a | ${status} | | | | | ${notes} |\n`
  test('dropped is canonical only with a Dropped: prefix', () => {
    expect(lintBoard(board('dropped', 'Dropped: superseded by 2.B-1.')).findings).toEqual([])
    const bad = lintBoard(board('dropped', 'not needed'))
    expect(bad.findings.map(f => f.rule)).toEqual(['dropped'])
    expect(checkBoard(board('dropped', 'gone'), 'canonical').map(f => f.rule)).toEqual(['dropped'])
  })
  test('cancelled-style statuses parse as done (hidden, not open)', () => {
    for (const s of ['dropped', 'cancelled', 'canceled', 'wontfix', 'abandoned', 'obsolete', "won't fix", '~~cancelled~~'])
      expect(parseBoard(board(s, 'x')).map(t => t.status)).toEqual(['done'])
    expect(slimTasks(parseBoard(board('dropped', 'Dropped: x.')))).toEqual([])
  })
  test('deferred without owner evidence is todo, with owner evidence is parked', () => {
    for (const s of ['deferred', 'on hold', 'later', 'postponed', 'backlog']) {
      expect(parseBoard(board(s, 'Deferred: low value')).map(t => t.status)).toEqual(['todo'])
      expect(parseBoard(board(s, 'owner decision 2026-10-09: pause until web ships')).map(t => t.status)).toEqual(['parked'])
    }
    expect(parseBoard(board('deferred', 'Thomas paused it'), { ownerNames: ['Thomas'] }).map(t => t.status)).toEqual(['parked'])
  })
  test('unknown status message names the set and the mapping table', () => {
    const [msg] = lintBoard(board('deferred', 'x')).issues
    expect(msg).toContain('todo, in_progress, in_review, blocked, blocked_on_owner, parked, done, dropped')
    expect(msg).toContain('see FORMAT.md, Legacy statuses')
  })
  test('autofix prompt carries the table', () => {
    const p = fixPrompt('o/r', '/x/TASKS.md', '20261009')
    expect(p).toContain('Legacy statuses')
    expect(p).toContain('Dropped: <reason>.')
    expect(p).toContain('Deferred: <reason>.')
    expect(p).toContain('Previous status')
  })
})

test('epicEta is the latest canonical ETA of open rows', () => {
  const r = (eta: string, status = 'todo') => ({ eta, status }) as never
  expect(epicEta([r('2026-10-11 18:00 ICT'), r('2026-12-01 09:00 ICT', 'done'), r('2026-10-20 08:00 ICT'), r('soon')])).toBe('2026-10-20 08:00 ICT')
  expect(epicEta([r('soon'), r('later')])).toBe('soon')
})
