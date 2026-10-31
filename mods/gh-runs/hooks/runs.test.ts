import { describe, expect, test } from 'claude-code/testing'

import {
  ciPollReason,
  conclusionColor,
  allKeys,
  defaultExpanded,
  groupRuns,
  MAX_TREE_LINES,
  summaryCounts,
  toggleKey,
  treeLines,
  stateMark,
  noticeText,
  parseLine,
  summaryOf,
  resultKey,
  parseTrackArg,
  parseWatcherCommands,
  progressOf,
  splitLines,
} from './runs'
import type { ActiveRun, Run } from './runs'

const R = 'octo-org/hello-world'

describe('gh-watcher wait commands', () => {
  test('reads the target flags', () => {
    expect(parseWatcherCommands(`gh-watcher wait --repo ${R} --pr 17`)).toEqual([{ repo: R, kind: 'pr', value: '17' }])
    expect(parseWatcherCommands(`gh-watcher wait --repo=${R} --branch feat/x --json`)).toEqual([{ repo: R, kind: 'branch', value: 'feat/x' }])
    expect(parseWatcherCommands(`gh-watcher wait --commit abc1234 --repo ${R}`)).toEqual([{ repo: R, kind: 'commit', value: 'abc1234' }])
    expect(parseWatcherCommands(`gh-watcher wait --repo ${R} --run 99`)).toEqual([{ repo: R, kind: 'run', value: '99' }])
  })
  test('handles quotes, env prefixes, cd and paths', () => {
    expect(parseWatcherCommands(`cd /tmp/x && gh-watcher wait --repo "${R}" --pr '5' --interval 15s --timeout 45m`)).toEqual([{ repo: R, kind: 'pr', value: '5' }])
    expect(parseWatcherCommands(`FOO=1 /opt/bin/gh-watcher wait --repo ${R} --pr 5 &`)).toEqual([{ repo: R, kind: 'pr', value: '5' }])
    expect(parseWatcherCommands(`gh-watcher wait --repo ${R} --pr 5 | tee out.log`)).toEqual([{ repo: R, kind: 'pr', value: '5' }])
  })
  test('falls back to GH_REPO, in a prefix or an export', () => {
    expect(parseWatcherCommands(`GH_REPO=${R} gh-watcher wait --pr 3`)).toEqual([{ repo: R, kind: 'pr', value: '3' }])
    expect(parseWatcherCommands(`export GH_REPO=${R}; gh-watcher wait --pr 3`)).toEqual([{ repo: R, kind: 'pr', value: '3' }])
  })
  test('skips what it cannot place', () => {
    expect(parseWatcherCommands('gh-watcher wait --pr 3')).toEqual([])
    expect(parseWatcherCommands(`gh-watcher status --repo ${R} --pr 3`)).toEqual([])
    expect(parseWatcherCommands(`echo "gh-watcher wait --repo ${R} --pr 3"`)).toEqual([])
    expect(parseWatcherCommands(`gh-watcher wait --repo ${R}`)).toEqual([])
    expect(parseWatcherCommands('gh-watcher wait --repo nonsense --pr 1')).toEqual([])
    expect(parseWatcherCommands('')).toEqual([])
  })
  test('skips unexpanded shell values', () => {
    for (const args of ['--pr $n', '--pr "$n"', '--run $(cat id)', '--commit $sha', '--branch $b'])
      expect(parseWatcherCommands(`gh-watcher wait --repo ${R} ${args}`)).toEqual([])
    expect(parseWatcherCommands('gh-watcher wait --repo $REPO --pr 1')).toEqual([])
  })
})

describe('/ci-track arguments', () => {
  test('takes PR and run URLs, with or without a job', () => {
    expect(parseTrackArg(`https://github.com/${R}/pull/17`)).toEqual({ repo: R, kind: 'pr', value: '17' })
    expect(parseTrackArg(`https://github.com/${R}/pull/17/files`)).toEqual({ repo: R, kind: 'pr', value: '17' })
    expect(parseTrackArg(`https://github.com/${R}/actions/runs/123`)).toEqual({ repo: R, kind: 'run', value: '123' })
    expect(parseTrackArg(`https://github.com/${R}/actions/runs/123/job/456?pr=1`)).toEqual({ repo: R, kind: 'run', value: '123' })
  })
  test('takes owner/repo#123 and owner/repo 123', () => {
    expect(parseTrackArg(`${R}#123`)).toEqual({ repo: R, kind: 'pr', value: '123' })
    expect(parseTrackArg(`${R} 123`)).toEqual({ repo: R, kind: 'pr', value: '123' })
  })
  test('refuses anything else', () => {
    for (const bad of ['', 'nonsense', R, `${R}#x`, 'https://example.com/a/b']) expect(parseTrackArg(bad)).toBeUndefined()
  })
})

const line = (over: object = {}) =>
  JSON.stringify({ repo: R, targetKey: 'pr:1', state: 'pending', runs: [{ databaseId: 1, status: 'queued' }], failedSteps: [], source: 'events', checkedAt: '2026-01-01T00:00:00Z', isFinal: false, ...over })

describe('follower lines', () => {
  test('accepts a well-formed line and refuses the rest', () => {
    expect(parseLine(line())?.source).toBe('events')
    for (const bad of ['', 'nope', '[]', '{}', line({ source: 'x' }), line({ runs: [{ status: 'x' }] }), line({ isFinal: 'no' })]) expect(parseLine(bad)).toBeUndefined()
  })
  test('cuts chunks into whole lines', () => {
    const a = splitLines('', '{"a":1}\n{"b"')
    expect(a).toEqual({ lines: ['{"a":1}'], rest: '{"b"' })
    expect(splitLines(a.rest, ':2}\r\n\n')).toEqual({ lines: ['{"b":2}'], rest: '' })
  })
})

const run = (over: Partial<Run> = {}): Run => ({
  databaseId: 7,
  workflowName: 'CI',
  status: 'in_progress',
  conclusion: null,
  url: 'https://example.com/run/7',
  startedAt: '2026-01-01T00:00:00Z',
  jobs: [
    { name: 'build', status: 'in_progress', conclusion: null, steps: [
      { name: 'Checkout', number: 1, status: 'completed', conclusion: 'success' },
      { name: 'Test', number: 2, status: 'in_progress', conclusion: null },
      { name: 'Package', number: 3, status: 'pending', conclusion: null },
    ] },
    { name: 'lint', status: 'in_progress', conclusion: null, steps: [] },
    { name: 'docs', status: 'queued', conclusion: null, steps: [] },
  ],
  ...over,
})
const active = (r: Run, source: 'events' | 'poll' = 'events'): ActiveRun => ({
  key: '7#1', runId: 7, attempt: 1, target: { repo: R, kind: 'pr', value: '17' }, run: r, source, checkedAt: Date.parse('2026-01-01T00:01:00Z'), seenAt: 0,
})
const NOW = Date.parse('2026-01-01T00:01:40Z')
const at = (id: number, target: ActiveRun['target'], r: Partial<Run> = {}, startedAt = '2026-01-01T00:00:00Z'): ActiveRun => ({
  ...active(run({ databaseId: id, url: `https://example.com/run/${id}`, startedAt, ...r })),
  key: `${id}#1`,
  runId: id,
  target,
})
const PR = { repo: R, kind: 'pr' as const, value: '17' }
const BR = { repo: R, kind: 'branch' as const, value: 'feat/x y' }
const lineText = (l: { segs: { text: string }[] }) => l.segs.map(s => s.text).join('')

describe('grouping', () => {
  test('runs of one PR make one group, linked to the repo and the PR', () => {
    const g = groupRuns([at(1, PR), at(2, PR, {}, '2026-01-01T00:00:10Z')])
    expect(g.length).toBe(1)
    expect(g[0]).toMatchObject({ id: `${R}|pr:17`, ref: '#17', href: `https://github.com/${R}/pull/17` })
    expect(g[0]?.runs.map(a => a.runId)).toEqual([1, 2])
  })
  test('a branch target groups by repo and branch, linked to the tree', () => {
    const [g] = groupRuns([at(1, BR)])
    expect(g).toMatchObject({ ref: 'feat/x y', href: `https://github.com/${R}/tree/feat/x%20y` })
  })
  test('a mixed set makes one group per PR, branch, commit and lone run', () => {
    const sha = '0123456789abcdef'
    const groups = groupRuns([
      at(1, PR),
      at(2, BR, {}, '2026-01-01T00:00:01Z'),
      at(3, { repo: R, kind: 'commit', value: sha }, {}, '2026-01-01T00:00:02Z'),
      at(4, { repo: R, kind: 'run', value: '4' }, {}, '2026-01-01T00:00:03Z'),
      at(5, { repo: 'other/repo', kind: 'pr', value: '17' }, {}, '2026-01-01T00:00:04Z'),
    ])
    expect(groups.map(g => g.ref)).toEqual(['#17', 'feat/x y', '0123456', 'run 4', '#17'])
    expect(groups.map(g => g.repo)).toEqual([R, R, R, R, 'other/repo'])
    expect(groups.find(g => g.kind === 'commit')?.href).toBeUndefined()
  })
  test('a run target joins the group that already follows the same run, and is not shown twice', () => {
    const groups = groupRuns([at(1, { repo: R, kind: 'run', value: '1' }), at(1, PR), at(2, { repo: R, kind: 'run', value: '2' })])
    expect(groups.map(g => [g.ref, g.runs.map(a => a.runId)])).toEqual([['#17', [1]], ['run 2', [2]]])
  })
  test('groups keep a stable order, whatever the order of the list', () => {
    const a = at(1, PR)
    const b = at(2, BR, {}, '2026-01-01T00:00:30Z')
    expect(groupRuns([a, b]).map(g => g.id)).toEqual(groupRuns([b, a]).map(g => g.id))
  })
  test('the summary counts done, failed, running and queued runs', () => {
    const [g] = groupRuns([
      at(1, PR, { status: 'completed', conclusion: 'success' }),
      at(2, PR, { status: 'completed', conclusion: 'failure' }),
      at(3, PR),
      at(4, PR, { status: 'queued' }),
    ])
    expect(summaryCounts(g as never)).toEqual({ total: 4, done: 1, failed: 1, running: 1, queued: 1 })
  })
})

describe('group rows', () => {
  const row = (runs: ActiveRun[], columns = 200) => treeLines(groupRuns(runs), defaultExpanded(groupRuns(runs)), NOW, 0, columns)[0] as ReturnType<typeof treeLines>[number]
  test('read breadcrumb, run count, coloured summary and elapsed time since the earliest start', () => {
    const l = row([at(1, PR), at(2, PR, { status: 'completed', conclusion: 'success' }, '2026-01-01T00:00:20Z')])
    expect(lineText(l)).toBe(`⠋ ${R} › #17 │ 2 runs │ ✓ 1 done 1 running │ ███░░░░░ │ 1m 40s`)
    expect(l.segs.find(s => s.id === 'sum')).toMatchObject({ color: 'success' })
    expect(l.segs.find(s => s.id === 'sum1')).toMatchObject({ color: 'suggestion' })
    expect(Object.fromEntries(l.segs.filter(s => s.href).map(s => [s.id, s.href]))).toEqual({ repo: `https://github.com/${R}`, ref: `https://github.com/${R}/pull/17` })
  })
  test('failures are red and a lone run is singular', () => {
    const l = row([at(1, PR, { status: 'completed', conclusion: 'failure' })])
    expect(lineText(l)).toContain('1 run │ ✗ 1 failed')
    expect(l.segs.find(s => s.id === 'sum')).toMatchObject({ color: 'error' })
    expect(l.segs.some(s => s.id === 'spin')).toBe(false)
  })
  test('a separator goes with its field, never dangling or doubled, at every width', () => {
    for (let columns = 10; columns <= 140; columns++) {
      const l = row([at(1, PR), at(2, PR, { status: 'completed', conclusion: 'failure' })], columns)
      const t = lineText(l)
      expect(t).not.toMatch(/│ *│/)
      expect(t).not.toMatch(/› *›/)
      expect(t).not.toMatch(/[│›] ?$/)
      for (const s of l.segs) if (s.id.startsWith('sep:')) expect(l.segs.some(o => o.id === s.id.slice(4))).toBe(true)
      expect(l.segs.some(s => s.id === 'ref')).toBe(true)
      if (columns >= 40) expect([...t].length).toBeLessThanOrEqual(columns - 2)
    }
  })
  test('the bar fills with completed steps over all steps of every run with step data', () => {
    // run 1: 1 of 3 steps done; run 2: 2 of 2 done; run 3 has no step data -> 3/5 -> 5 of 8 cells
    const two = [{ name: 'a', number: 1, status: 'completed', conclusion: 'success' }, { name: 'b', number: 2, status: 'completed', conclusion: 'success' }]
    const l = row([at(1, PR), at(2, PR, { jobs: [{ name: 'x', status: 'completed', conclusion: 'success', steps: two }] }, '2026-01-01T00:00:10Z'), at(3, PR, { status: 'queued', jobs: [] }, '2026-01-01T00:00:20Z')])
    expect(l.segs.find(s => s.id === 'fill')?.text).toBe('█████')
    expect(l.segs.find(s => s.id === 'empty')?.text).toBe('░░░')
    expect(lineText(l)).toMatch(/ │ █████░░░ │ 1m 40s$/)
  })
  test('an all-queued group shows an empty bar', () => {
    const l = row([at(1, PR, { status: 'queued', jobs: [] }), at(2, PR, { status: 'queued', jobs: undefined })])
    expect(l.segs.find(s => s.id === 'fill')?.text).toBe('')
    expect(l.segs.find(s => s.id === 'empty')?.text).toBe('░░░░░░░░')
    expect(lineText(l)).toContain(' │ ░░░░░░░░ │ ')
  })
  test('the bar drops with its separator at narrow width, before the run count', () => {
    const wide = row([at(1, PR)], 200)
    expect(wide.segs.some(s => s.id === 'fill')).toBe(true)
    for (let columns = 30; columns <= 80; columns++) {
      const l = row([at(1, PR)], columns)
      const has = (id: string) => l.segs.some(s => s.id === id)
      expect(has('sep:fill')).toBe(has('fill'))
      expect(has('fill')).toBe(has('empty'))
      if (has('fill')) expect(has('count')).toBe(true)
    }
    expect(row([at(1, PR)], 50).segs.some(s => s.id === 'fill')).toBe(false)
  })
  test('drop the run count first and the repo before the summary', () => {
    const t = (c: number) => lineText(row([at(1, PR)], c))
    expect(t(200)).toContain('1 run │')
    expect(t(53)).not.toContain('1 run │')
    expect(t(53)).toContain(R)
    expect(t(35)).not.toContain(R)
    expect(t(35)).toContain('#17')
  })
})

describe('run and job rows', () => {
  const tree = (open: string[], runs = [at(1, PR)], columns = 200, rows = true) => treeLines(groupRuns(runs), open, NOW, 0, columns, rows)
  const G = `g:${R}|pr:17`
  test('a run row is indented 2 with the workflow linked, step, bar, elapsed and update note', () => {
    const l = tree([G])[1] as ReturnType<typeof tree>[number]
    expect(l).toMatchObject({ kind: 'run', indent: 2, toggle: 'r:1', isOpen: false })
    expect(lineText(l)).toBe('CI │ step 2/3 │ ███░░░░░ │ 1m 40s │ updated 40s ago webhook')
    expect(l.segs[0]).toMatchObject({ href: 'https://example.com/run/7'.replace('7', '1') })
  })
  test('a job row is indented 6 and shows the state, step n/m and the current step name', () => {
    const l = tree([G, 'r:1']).filter(x => x.kind === 'job')
    expect(l.map(x => [x.indent, lineText(x), x.toggle])).toEqual([
      [6, '⠋ build │ step 2/3 │ Test', 'j:1:build'],
      [6, '⠋ lint', undefined],
      [6, '○ docs', undefined],
    ])
  })
  test('a finished job shows done over total', () => {
    const r = at(1, PR, { jobs: [{ name: 'build', status: 'completed', conclusion: 'success', steps: [{ name: 'a', number: 1, status: 'completed', conclusion: 'success' }] }] })
    expect(tree([G, 'r:1'], [r]).map(lineText)[2]).toBe('✓ build │ 1/1')
  })
  test('step rows are indented 10 with number and name', () => {
    const l = tree([G, 'r:1', 'j:1:build'])
    const steps = l.filter(x => x.kind === 'step')
    expect(steps.map(x => [x.indent, lineText(x)])).toEqual([[10, '✓ 1 Checkout'], [10, '⠋ 2 Test'], [10, '○ 3 Package']])
    expect(steps[0]?.segs[0]).toMatchObject({ color: 'success' })
    expect(steps[1]?.segs[0]).toMatchObject({ color: 'suggestion' })
  })
  test('a collapsed key hides what is below it', () => {
    expect(tree([]).length).toBe(1)
    expect(tree([G]).map(x => x.kind)).toEqual(['group', 'run'])
    expect(tree([G, 'r:1']).map(x => x.kind)).toEqual(['group', 'run', 'job', 'job', 'job'])
    expect(tree(['r:1', 'j:1:build']).map(x => x.kind)).toEqual(['group'])
  })
  test('a short viewport shows groups and runs only', () => {
    expect(tree([G, 'r:1', 'j:1:build'], [at(1, PR)], 200, false).map(x => x.kind)).toEqual(['group', 'run'])
  })
  test('names are cut to the width at every level', () => {
    const long = at(1, PR, { jobs: [{ name: 'a very long job name here', status: 'in_progress', conclusion: null, steps: [{ name: 'a very long step name here', number: 3, status: 'queued', conclusion: null }] }] })
    for (const l of tree([G, 'r:1', 'j:1:a very long job name here'], [long], 30)) {
      if (l.kind === 'step') expect(l.indent + [...lineText(l)].length).toBeLessThanOrEqual(30)
    }
  })
})

describe('run names', () => {
  test('fall back to displayTitle, then run <id>', () => {
    const name = (r: Partial<Run>) => lineText(treeLines(groupRuns([at(1, PR, { jobs: [], ...r })]), [`g:${R}|pr:17`], NOW, 0, 200)[1] as never).split(' │')[0]
    expect(name({ workflowName: '', displayTitle: 'Fix bug' })).toBe('Fix bug')
    expect(name({ workflowName: 'CI', displayTitle: 'Fix bug' })).toBe('CI')
    expect(name({ workflowName: '', displayTitle: '' })).toBe('run 1')
  })
})

describe('expansion keys', () => {
  test('groups start expanded, runs and jobs collapsed', () => {
    const groups = groupRuns([at(1, PR), at(2, BR)])
    expect(defaultExpanded(groups)).toEqual(groups.map(g => `g:${g.id}`))
    expect(allKeys(groups.filter(g => g.kind === 'pr'))).toEqual([`g:${R}|pr:17`, 'r:1', 'j:1:build', 'j:1:lint', 'j:1:docs'])
  })
  test('toggling adds a missing key and removes a present one', () => {
    expect(toggleKey(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleKey(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('tree height', () => {
  const stepsOf = (n: number, running: number) => Array.from({ length: n }, (_, i) => ({ name: `s${i + 1}`, number: i + 1, status: i < running ? 'completed' : i === running ? 'in_progress' : 'queued', conclusion: i < running ? 'success' : null }))
  const big = (id: number, jobs: number, steps: number, running: number) =>
    at(id, PR, { jobs: Array.from({ length: jobs }, (_, j) => ({ name: `job${j}`, status: 'in_progress', conclusion: null, steps: stepsOf(steps, running) })) })
  const all = (runs: ActiveRun[]) => {
    const groups = groupRuns(runs)
    return treeLines(groups, allKeys(groups), NOW, 0, 80)
  }
  test('caps step lines over the whole tree and counts the rest in one +N more line', () => {
    const lines = all([big(1, 2, 15, 20)])
    expect(lines.filter(l => l.kind === 'step').length).toBe(12)
    const last = lines[lines.length - 1] as (typeof lines)[number]
    expect(lineText(last)).toBe('+18 more')
    expect(last).toMatchObject({ kind: 'more', indent: 10 })
  })
  test('keeps the running step in view', () => {
    const lines = all([big(1, 1, 30, 20)])
    expect(lines.map(lineText).some(t => t.includes('21 s21'))).toBe(true)
    expect(lines.map(lineText).some(t => t.includes(' 1 s1'))).toBe(false)
  })
  test('caps all lines at MAX_TREE_LINES', () => {
    const runs = Array.from({ length: 40 }, (_, i) => at(i + 1, PR))
    const lines = all(runs)
    expect(lines.length).toBe(MAX_TREE_LINES)
    expect(lineText(lines[lines.length - 1] as never)).toMatch(/^\+\d+ more$/)
  })
  test('under the caps there is no +N more line', () => {
    expect(all([at(1, PR)]).some(l => l.kind === 'more')).toBe(false)
  })
})

describe('chat items', () => {
  test('carry the conclusion, the failed steps and the link', () => {
    const a = active(run({ conclusion: 'failure', status: 'completed', updatedAt: '2026-01-01T00:02:05Z' }))
    const t = noticeText(a, ['build / Test'])
    expect(t).toContain('[gh-runs] failure  CI')
    expect(t).toContain('2m 05s')
    expect(t).toContain('failed: build / Test')
    expect(t).toContain('https://example.com/run/7')
    expect(summaryOf(a, ['build / Test'])).toMatchObject({ conclusion: 'failure', workflow: 'CI', duration: '2m 05s', failed: ['build / Test'], url: 'https://example.com/run/7', text: t })
    expect(resultKey(a)).toBe('7-1')
  })
  test('map conclusions to colours', () => {
    expect(conclusionColor('success')).toEqual({ color: 'success' })
    expect(conclusionColor('failure')).toEqual({ color: 'error' })
    expect(conclusionColor('cancelled')).toEqual({ color: 'warning' })
    expect(conclusionColor('timed_out')).toEqual({ color: 'warning' })
    expect(conclusionColor('skipped')).toEqual({ dim: true })
    expect(conclusionColor('neutral')).toEqual({ dim: true })
  })
})

describe('step marks', () => {
  test('marks and colours every step state', () => {
    expect(stateMark('completed', 'success', 0)).toEqual({ mark: '✓', color: 'success' })
    expect(stateMark('completed', 'failure', 0)).toEqual({ mark: '✗', color: 'error' })
    expect(stateMark('in_progress', null, 1)).toEqual({ mark: '⠙', color: 'suggestion' })
    expect(stateMark('queued', null, 0)).toEqual({ mark: '○', dim: true })
    expect(stateMark('pending', null, 0)).toEqual({ mark: '○', dim: true })
    expect(stateMark('completed', 'skipped', 0)).toEqual({ mark: '-', dim: true })
    expect(stateMark('completed', 'cancelled', 0)).toEqual({ mark: '⊘', color: 'warning' })
  })
  test('counts only completed steps, not ones with an empty conclusion', () => {
    const steps = [
      { name: 'a', number: 1, status: 'completed', conclusion: 'success' },
      { name: 'b', number: 2, status: 'in_progress', conclusion: '' as never },
      { name: 'c', number: 3, status: 'queued', conclusion: '' as never },
    ]
    expect(progressOf(run({ jobs: [{ name: 'build', status: 'in_progress', conclusion: null, steps }] })).done).toBe(1)
  })
})

describe('ciPollReason', () => {
  const bash = (command: string) => ciPollReason('Bash', { command })
  const monitor = (command: string) => ciPollReason('Monitor', { command, description: 'ci', timeout_ms: 1000 })

  const denied: [string, string][] = [
    ['until loop on pr checks', 'until gh pr checks 5 | grep -q pass; do sleep 30; done'],
    ['for loop on run view', 'for i in $(seq 20); do gh run view 123 --json status; sleep 20; done'],
    ['while loop on run list', 'while true; do gh run list -R a/b --limit 1; sleep 15; done'],
    ['while loop on pr view', 'while sleep 30; do gh pr view 9 --json statusCheckRollup; done'],
    ['loop on gh api actions', 'while true; do gh api repos/a/b/actions/runs/1 --jq .status; sleep 10; done'],
    ['curl runs jobs', 'curl -s https://api.github.com/repos/a/b/actions/runs/1/jobs'],
    ['curl runs list with token', 'GH_TOKEN=x curl -H "Accept: application/json" "https://api.github.com/repos/a/b/actions/runs?branch=main" | jq .'],
    ['curl check-runs', 'curl https://api.github.com/repos/a/b/commits/abc1234/check-runs'],
    ['wget status', 'wget -qO- https://api.github.com/repos/a/b/commits/abc1234/status'],
    ['xh statuses', 'xh get api.github.com/repos/a/b/commits/abc1234/statuses'],
    ['curl run page', 'curl -sL https://github.com/a/b/actions/runs/77'],
    ['gh run watch', 'gh run watch 123 -R a/b'],
    ['gh pr checks --watch', 'gh pr checks 68 --watch'],
    ['watch command', 'watch -n 30 gh pr checks 68'],
    ['watch quoted body', "watch -n 10 'gh run view 5 | head'"],
    ['loop curl with nested bash -c', "bash -c 'until gh run view 9 --exit-status; do sleep 5; done'"],
    ['loop behind a heredoc-free export', 'export GH_REPO=a/b; until gh pr checks 3; do sleep 20; done'],
  ]
  for (const [name, command] of denied) {
    test(`Bash denies ${name}`, () => {
      const reason = bash(command)
      expect(reason).toBeDefined()
      expect(reason).toContain('gh-watcher wait --repo')
      expect(reason).toContain('--timeout 45m --json')
      expect(reason).toContain('run_in_background')
    })
  }

  test('the reason fills in the repo and id the command shows', () => {
    expect(bash('curl -s https://api.github.com/repos/a/b/actions/runs/1/jobs')).toContain('gh-watcher wait --repo a/b --run 1 --timeout 45m --json')
    expect(bash('until gh pr checks 5 -R a/b; do sleep 30; done')).toContain('gh-watcher wait --repo a/b --pr 5 --timeout 45m --json')
    expect(bash('curl https://api.github.com/repos/a/b/commits/abc1234/check-runs')).toContain('--repo a/b --commit abc1234 ')
    expect(bash('gh run watch')).toContain('--repo <owner/repo> (--pr <n>|--run <id>|--commit <sha>)')
  })

  test('Monitor commands are judged the same way', () => {
    expect(monitor('while true; do gh run view 1 --json status; sleep 20; done')).toContain('gh-watcher wait --repo <owner/repo> --run 1')
    expect(monitor('curl -s https://api.github.com/repos/a/b/actions/runs/2')).toBeDefined()
    expect(monitor('gh pr checks 4 --watch')).toBeDefined()
    expect(monitor('tail -f /tmp/build.log')).toBeUndefined()
    expect(monitor('gh-watcher follow --repo a/b --pr 4')).toBeUndefined()
  })

  const allowed: [string, string][] = [
    ['gh-watcher wait', 'gh-watcher wait --repo a/b --pr 5 --timeout 45m --json'],
    ['gh-watcher wait with a path', '/usr/bin/gh-watcher wait --repo a/b --run 9 --json'],
    ['gh-watcher in a loop', 'while true; do gh-watcher wait --repo a/b --pr 5; sleep 1; done'],
    ['one-off pr checks', 'gh pr checks 68 -R a/b'],
    ['one-off run view', 'gh run view 123 -R a/b'],
    ['one-off log-failed', 'gh run view 123 --log-failed | tail -50'],
    ['one-off run list', 'gh run list --limit 5'],
    ['pr create', 'gh pr create --title x --body y'],
    ['pr list', 'gh pr list --state open'],
    ['issue view', 'gh issue view 12'],
    ['gh api non-CI', 'gh api repos/a/b/pulls/5 --jq .title'],
    ['one-off gh api actions', 'gh api repos/a/b/actions/runs/1'],
    ['commit message mentioning polling', 'git commit -m "stop polling gh run view"'],
    ['echo of a loop', 'echo "until gh pr checks 5; do sleep 30; done"'],
    ['echo of a curl url', "echo 'curl https://api.github.com/repos/a/b/actions/runs'"],
    ['heredoc not run', "cat <<'EOF' > notes.md\nuntil gh pr checks 5; do sleep 30; done\ncurl https://api.github.com/repos/a/b/actions/runs\nEOF"],
    ['comment line', '# gh run watch 1\nls'],
    ['loop without sleep', 'for p in 1 2 3; do gh pr view $p --json title; done'],
    ['sleep without a poller', 'sleep 5 && gh pr checks 3'],
    ['loop with sleep and no CI', 'while ! nc -z localhost 80; do sleep 1; done'],
    ['curl non-CI api', 'curl -s https://api.github.com/repos/a/b/issues/3'],
    ['curl other host', 'curl https://example.com/a/b/actions/runs/1'],
    ['plain command', 'npm test'],
    ['empty command', ''],
  ]
  for (const [name, command] of allowed) {
    test(`Bash allows ${name}`, () => {
      expect(bash(command)).toBeUndefined()
    })
  }

  test('other tools and odd inputs are left alone', () => {
    expect(ciPollReason('Read', { command: 'gh run watch' })).toBeUndefined()
    expect(ciPollReason('Bash', {})).toBeUndefined()
    expect(ciPollReason('Bash', null)).toBeUndefined()
    expect(ciPollReason('Monitor', { ws: { url: 'wss://x' } })).toBeUndefined()
  })
})
