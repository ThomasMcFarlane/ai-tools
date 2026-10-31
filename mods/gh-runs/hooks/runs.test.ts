import { describe, expect, test } from 'claude-code/testing'

import {
  conclusionColor,
  fitSegments,
  noticeText,
  parseLine,
  parseNotice,
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
    expect(t).toContain(`${R}#17`)
    expect(t).toContain('build +2 jobs')
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

describe('chat items', () => {
  test('carry the conclusion, the failed steps and the link', () => {
    const a = active(run({ conclusion: 'failure', status: 'completed', updatedAt: '2026-01-01T00:02:05Z' }))
    const t = noticeText(a, ['build / Test'])
    expect(t).toContain('[gh-runs] failure  CI')
    expect(t).toContain('2m 05s')
    expect(t).toContain('failed: build / Test')
    expect(t).toContain('https://example.com/run/7')
    expect(parseNotice(t)).toEqual({ conclusion: 'failure', head: expect.stringContaining('CI'), failed: 'build / Test', url: 'https://example.com/run/7' })
    expect(parseNotice(t.replaceAll('\n', ' '))?.url).toBe('https://example.com/run/7')
    expect(parseNotice('something else')).toBeUndefined()
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
