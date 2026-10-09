import { expect, mock, test } from 'claude-code/testing'

import { boardRepo, normaliseGitDir } from './board'
import { DEFAULT_CONFIG } from './config'

const table = (epic: string) => `# Tasks\n\n## ${epic}\n\n| # | Task | Status | Owner | Notes |\n|---|---|---|---|---|\n| 1 | ${epic} one | in_progress | | |\n| 2 | ${epic} two | todo | | |\n`

// Two repositories, each with a primary checkout and one fresh worktree whose board differs.
const boards: Record<string, string> = {
  '/work/a/TASKS.md': table('Alpha'),
  '/work/a-wt/TASKS.md': table('AlphaWt'),
  '/work/b/TASKS.md': table('Bravo'),
  '/work/b-wt/TASKS.md': table('BravoWt'),
}
const NOW = 1_760_000_000_000
const commonOf = (dir: string) => (dir.startsWith('/work/a') ? '/work/a/.git' : '/work/b/.git')

function setup(on: Parameters<Parameters<typeof test>[1]>[1], opts: { cwd: string; gate?: Promise<void>; bListsA?: boolean }) {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  const opened: string[] = []
  on('session.start', () => ({ cwd: opts.cwd }))
  on('session.cwd', () => ({ value: opts.cwd }))
  on('fs.exists', (_$, e) => ({ value: e.path in boards && !e.path.includes('-wt') }))
  on('fs.stat', (_$, e) => {
    if (!(e.path in boards)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: boards[e.path]!.length, mtimeMs: e.path.includes('-wt') ? Date.now() : NOW - 3_600_000, isLink: false } }
  })
  on('fs.read', async (_$, e) => {
    if (e.path === '/work/a/TASKS.md' && opts.gate) await opts.gate
    return { value: boards[e.path] ?? '' }
  })
  on('process.run', (_$, e) => {
    const dir = e.argv[2]!
    const git = e.argv.slice(3).join(' ')
    const out = git.startsWith('worktree list')
      ? `worktree ${dir}\n\nworktree ${dir}-wt\n${opts.bListsA && dir === '/work/b' ? '\nworktree /work/a-wt\n' : ''}`
      : git.startsWith('rev-parse --git-common-dir')
        ? `${commonOf(dir)}\n`
        : git.startsWith('rev-parse')
          ? 'base1\n'
          : ''
    return { value: { exitCode: out === '' ? 1 : 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', (_$, e) => {
    opened.push(String(e.title))
    return { value: { isPlaced: true } }
  })
  on('ui.status', () => ({ value: undefined }))
  return { clock, opened }
}

const drawnPane = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
  const ui = await $.ui.mount({
    plugin: 'tasks-board',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tasks-board',
    props: { title: 'Board', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    viewport: { columns: 120, rows: 60, isFullscreen: true },
  })
  const drawn = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return drawn
}

const board = ($: Parameters<Parameters<typeof test>[1]>[0], args: string) => $.command.run({ command: 'board', args }) as Promise<{ text: string }>

test('the pane is labelled and filled from the picked board, not the session directory', async ($, on) => {
  const { clock, opened } = setup(on, { cwd: '/work/a' })
  await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(opened.at(-1)).toBe('Board · a')
  await board($, '/work/b/TASKS.md')
  expect(opened.at(-1)).toBe('Board · b')
  const drawn = await drawnPane($)
  expect(drawn).toContain('Bravo')
  expect(drawn).not.toContain('Alpha')
})

test('a slow refresh for one board cannot write into the board that replaced it', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(r => (release = r))
  const { clock } = setup(on, { cwd: '/work/a', gate })
  await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true }) // its refresh of A stalls reading A
  await board($, '/work/b/TASKS.md')
  release()
  await clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('Bravo')
  expect(drawn).not.toContain('Alpha')
})

test('the own worktree counts only in the same repository as the board', async ($, on) => {
  const { clock } = setup(on, { cwd: '/work/a-wt', bListsA: true })
  await $.session.start({ cwd: '/work/a-wt', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await board($, '/work/a/TASKS.md')
  expect((await board($, 'debug')).text).toContain('own true')
  await board($, '/work/b/TASKS.md')
  const other = (await board($, 'debug')).text
  expect(other).not.toContain('own true')
  expect(other).toContain('/work/a-wt mtime')
})

test('board debug reports the pick', async ($, on) => {
  const { clock } = setup(on, { cwd: '/work/a' })
  await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const text = (await board($, 'debug')).text
  expect(text).toContain('board: /work/a/TASKS.md')
  expect(text).toContain('org/repo: -/a')
  expect(text).toContain('session cwd: /work/a')
})

test('board repo comes from the board path', () => {
  const cfg = { ...DEFAULT_CONFIG, reposRoot: '/r', baseBoard: '{root}/{org}/{repo}/TASKS.md', repoPatterns: ['{root}/{org}/{repo}'] }
  expect(boardRepo('/r/Org/mc3/TASKS.md', cfg)).toEqual({ org: 'Org', repo: 'mc3' })
  expect(boardRepo('/r/Org/mc3/sub/TASKS.md', cfg)).toEqual({ org: 'Org', repo: 'mc3' })
  expect(boardRepo('/x/y/TASKS.md', DEFAULT_CONFIG)).toEqual({ org: '', repo: 'y' })
  expect(normaliseGitDir('/w/a', '../a/./.git/')).toBe('/w/a/.git')
  expect(normaliseGitDir('/w/a', '/w/a/.git')).toBe('/w/a/.git')
})

const mountPane = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.ui.mount({
    plugin: 'tasks-board',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tasks-board',
    props: { title: 'Board', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    viewport: { columns: 120, rows: 60, isFullscreen: true },
  })

test('pressing any cell of an epic or task row toggles it', async ($, on) => {
  const { clock } = setup(on, { cwd: '/work/a' })
  await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await mountPane($)
  const has = async (text: string) => JSON.stringify(await ui.drawn()).includes(text)
  const id = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('epic:'))!.key!.slice('epic:'.length)
  for (const k of [`ch${id}`, `cn${id}`, `epic:${id}`, `ca${id}`, `ce${id}`]) {
    expect(await has('AlphaWt one')).toBe(false)
    await ui.press({ key: k })
    expect(await has('AlphaWt one')).toBe(true)
    await ui.press({ key: k })
  }
  await ui.press({ key: `epic:${id}` })
  for (const k of ['cn1@a-wt', 't1@a-wt', 'ca1@a-wt', 'ce1@a-wt']) {
    expect(await has('Owner')).toBe(false)
    await ui.press({ key: k })
    expect(await has('Owner')).toBe(true)
    await ui.press({ key: k })
  }
  await ui.unmount()
})

test('every cell of a row carries the hover style', async ($, on) => {
  const { clock } = setup(on, { cwd: '/work/a' })
  await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await mountPane($)
  const epic = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('epic:'))!
  await ui.press({ key: epic.key! })
  const rows: unknown[][] = []
  const walk = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const o = n as { type?: string; props?: { key?: string }; children?: unknown }
      if (o.type === 'Box' && o.props?.key?.startsWith('row')) rows.push(o.children as unknown[])
      Object.values(n).forEach(walk)
    }
  }
  walk(await ui.drawn())
  expect(rows.length).toBeGreaterThan(0)
  const leaves: { type?: string; hover?: { inverse?: boolean } }[] = []
  const collect = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(collect)
    else if (n && typeof n === 'object') {
      const o = n as { type?: string; hover?: { inverse?: boolean } }
      if (o.type === 'Text' || o.type === 'Button') leaves.push(o)
      else Object.values(n).forEach(collect)
    }
  }
  rows.forEach(collect)
  expect(leaves.length).toBeGreaterThan(5)
  expect(leaves.filter(l => l.hover?.inverse !== true)).toEqual([])
  await ui.unmount()
})
