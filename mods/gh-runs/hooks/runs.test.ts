import { describe, expect, test } from 'claude-code/testing'

import {
  conclusionColor,
  detailLines,
  stateMark,
  fitSegments,
  noticeText,
  parseLine,
  summaryOf,
  resultKey,
  parseTrackArg,
  parseWatcherCommands,
  progressOf,
  rowSegments,
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
const text = (a: ActiveRun, columns = 200) => fitSegments(rowSegments(a, NOW, 0), columns).map(s => s.text).join('')

describe('band rows', () => {
  test('shows the leading job, the step, progress and the update note', () => {
    expect(progressOf(run())).toMatchObject({ more: 2, stepIndex: 2, stepTotal: 3, done: 1, total: 3 })
    const t = text(active(run()))
    expect(t).toContain('CI')
    expect(t).toContain(`${R} › #17 › CI › build +2 jobs`)
    expect(t).toContain('step 2/3 Test')
    expect(t).toContain('1m 40s')
    expect(t).toContain('updated 40s ago webhook')
    expect(text(active(run(), 'poll'))).toContain('polled')
  })
  test('drops the least important parts on a narrow band', () => {
    const t = text(active(run()), 50)
    expect(t.length).toBeLessThanOrEqual(50)
    expect(t).toContain('CI')
    expect(t).not.toContain('updated')
  })
})

describe('breadcrumbs and separators', () => {
  const segs = (a: ActiveRun, columns = 200) => fitSegments(rowSegments(a, NOW, 0), columns)
  const linked = (a: ActiveRun) => Object.fromEntries(segs(a).filter(s => s.href).map(s => [s.id, s.href]))

  test('read repo, PR, workflow, job in order, each linked', () => {
    const a = active(run({ jobs: [{ name: 'build', status: 'in_progress', conclusion: null, url: 'https://example.com/job/1', steps: [] }] }))
    expect(segs(a).map(s => s.text).join('')).toContain(`${R} › #17 › CI › build`)
    expect(linked(a)).toEqual({ repo: `https://github.com/${R}`, pr: `https://github.com/${R}/pull/17`, wf: 'https://example.com/run/7', job: 'https://example.com/job/1' })
  })
  test('a run target has no run number crumb', () => {
    const a = { ...active(run()), target: { repo: R, kind: 'run' as const, value: '7' } }
    const t = text(a)
    expect(t).toContain(`${R} › CI`)
    expect(t).not.toContain('run 7')
    expect(segs(a).some(s => s.id === 'pr')).toBe(false)
  })
  test('separate the fields with a dim bar', () => {
    const t = text(active(run()))
    expect(t).toContain(' │ step 2/3 Test')
    expect(t).toContain(' │ 1m 40s')
    expect(t).toContain(' │ updated 40s ago webhook')
  })
  test('a separator goes with its field, never dangling or doubled', () => {
    for (let columns = 10; columns <= 140; columns++) {
      const out = segs(active(run()), columns)
      const t = out.map(s => s.text).join('')
      expect(t).not.toMatch(/│ *│/)
      expect(t).not.toMatch(/› *›/)
      expect(t).not.toMatch(/[│›] ?$/)
      for (const s of out) if (s.id.startsWith('sep:')) expect(out.some(o => o.id === s.id.slice(4))).toBe(true)
    }
  })
  test('the workflow crumb stays when the repo crumb is trimmed', () => {
    const t = text(active(run()), 30)
    expect(t).toContain('CI')
    expect(t).not.toContain(R)
    expect(t).not.toMatch(/^.{2}›/)
  })
  test('keep href through trimming', () => {
    expect(segs(active(run()), 60).find(s => s.id === 'wf')?.href).toBe('https://example.com/run/7')
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
    expect(resultKey(a)).toBe('7.1')
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

describe('expanded lines', () => {
  const text = (lines: ReturnType<typeof detailLines>) => lines.map(l => l.map(s => s.text).join(''))
  const step = (n: number, status: string, conclusion: string | null) => ({ name: `step${n}`, number: n, status, conclusion })
  const job = (steps: ReturnType<typeof step>[], name = 'build'): Run['jobs'] => [{ name, status: 'in_progress', conclusion: null, steps }]
  const base = (jobs: Run['jobs']): Run => ({ databaseId: 1, workflowName: 'CI', status: 'in_progress', conclusion: null, url: 'u', jobs })

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
    const r = run({ jobs: [{ name: 'build', status: 'in_progress', conclusion: null, steps }] })
    expect(JSON.stringify(detailLines(r, 80, 0))).toContain('1/3')
    expect(progressOf(r).done).toBe(1)
  })
  test('draws the job with n/m, then its steps indented with numbers and names', () => {
    const lines = detailLines(base(job([step(1, 'completed', 'success'), step(2, 'completed', 'failure'), step(3, 'in_progress', null), step(4, 'queued', null)])), 80, 0)
    expect(text(lines)).toEqual(['  ⠋ build  2/4', '    ✓ 1 step1', '    ✗ 2 step2', '    ⠋ 3 step3', '    ○ 4 step4'])
    expect(lines[2]?.[0]).toMatchObject({ color: 'error' })
    expect(lines[3]?.[0]).toMatchObject({ color: 'suggestion' })
    expect(lines[4]?.[0]).toMatchObject({ dim: true })
  })

  test('caps at 12 step lines, keeps the running step, and counts the rest', () => {
    const steps = Array.from({ length: 30 }, (_, i) => step(i + 1, i < 25 ? 'completed' : i === 25 ? 'in_progress' : 'queued', i < 25 ? 'success' : null))
    const out = text(detailLines(base(job(steps)), 80, 0))
    expect(out.filter(l => l.startsWith('    ') && !l.includes('more')).length).toBe(12)
    expect(out.some(l => l.includes('26 step26'))).toBe(true)
    expect(out[out.length - 1]).toBe('    +18 more')
    const head = text(detailLines(base(job(steps.map(s => ({ ...s, status: 'queued', conclusion: null })))), 80, 0))
    expect(head).toContain('    ○ 1 step1')
    expect(head[head.length - 1]).toBe('    +18 more')
  })

  test('keeps a failed step in view', () => {
    const steps = Array.from({ length: 20 }, (_, i) => step(i + 1, 'completed', i === 17 ? 'failure' : 'success'))
    expect(text(detailLines(base(job(steps)), 80, 0)).some(l => l.includes('18 step18'))).toBe(true)
  })

  test('cuts names to the width', () => {
    const lines = text(detailLines(base(job([{ name: 'a very long step name', number: 3, status: 'queued', conclusion: null }], 'a long job name')), 20, 0))
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(20)
    expect(lines[1]).toContain('…')
  })

  test('links the job name when the job has a url', () => {
    const jobs: Run['jobs'] = [{ name: 'build', status: 'in_progress', conclusion: null, url: 'https://example.com/job/9', steps: [step(1, 'queued', null)] }, { name: 'lint', status: 'queued', conclusion: null, steps: [] }]
    const lines = detailLines(base(jobs), 80, 0)
    const hrefs = lines.flat().filter(s => s.href).map(s => [s.id, s.href])
    expect(hrefs).toEqual([['j0:name', 'https://example.com/job/9']])
  })

  test('a job with no steps is one line', () => {
    expect(text(detailLines(base(job([])), 40, 0))).toEqual(['  ⠋ build  0/0'])
  })
})
