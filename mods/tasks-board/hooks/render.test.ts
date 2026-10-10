import { expect, mock, test } from 'claude-code/testing'

import { parseBoard } from './board'

// Synthetic boards in the styles real projects use: long titles and notes, repeated ids, dotted and suffixed ids,
// escaped pipes, multi-line rows, checklists. The plugin runs end to end on each (session.start refreshes through
// fs.* and process.run answered below), the Pane is mounted on the terminal surface at several widths, every epic
// and task row is opened, and the drawn tree is read back after each step.
// The live engine refuses a Button whose children are not nothing or one plain string (a Text or an array fails).
const badButtons = (node: unknown, found: string[] = []): string[] => {
  if (Array.isArray(node)) node.forEach(n => badButtons(n, found))
  else if (node && typeof node === 'object') {
    const n = node as { type?: string; key?: string; props?: { children?: unknown }; children?: unknown }
    const kids = n.children ?? n.props?.children
    if (n.type === 'Button' && !(kids === undefined || kids === '' || typeof kids === 'string' || (Array.isArray(kids) && (kids.length === 0 || (kids.length === 1 && typeof kids[0] === 'string'))))) found.push(String(n.key))
    for (const v of Object.values(node)) badButtons(v, found)
  }
  return found
}
const long = (n: number) => 'lorem ipsum dolor sit amet '.repeat(n).trim()
const rows = (make: (i: number) => string, n: number) => Array.from({ length: n }, (_, i) => make(i + 1)).join('\n')
const status = ['done', 'in_progress', 'todo', 'blocked', 'done (merged #12)', 'In review', 'open, not started']

const table = (header: string, sep: string, make: (i: number) => string, epics = 4, per = 12) =>
  Array.from({ length: epics }, (_, e) => `## Epic ${e + 1}\n\n${header}\n${sep}\n${rows(i => make(e * per + i), per)}`).join('\n\n')

const BOARDS: [string, string][] = [
  ['numeric ids, Depends on, long notes', `# Tasks\n\n${table('| # | Task | Status | Owner | Depends on | Acceptance |', '|---|---|---|---|---|---|', i => `| ${i} | Task ${i} ${long(3)} | ${status[i % 7]} | agent-${i % 3} (alias) | ${i - 1} | ${long(60)} ETA: 2026-10-10 |`)}\n`],
  ['prefixed ids and a decision table', `# Tasks\n\n${table('| # | Task | Status | Owner | Notes |', '|---|---|---|---|---|', i => `| PZ-${String(i).padStart(3, '0')} | Task ${i} | ${status[i % 7]} | | ${long(10)} |`)}\n\n## Decisions\n\n| # | Decision |\n|---|---|\n| D1 | Use X |\n`],
  ['multi-segment ids, Picked up by', `# Tasks\n\n${table('| # | Task | Status | Picked up by | Notes |', '|---|---|---|---|---|', i => `| CF-AREA-NAME-${String(i).padStart(2, '0')} | Task ${i} | ${status[i % 7]} | worker | ${long(5)} |`)}\n`],
  ['checklist items', `# Todo\n\n${Array.from({ length: 6 }, (_, e) => `## Section ${e + 1}, 2026-10-0${e + 1}\n\n${rows(i => `- [${i % 3 === 0 ? 'x' : ' '}] ${i % 4 === 0 ? 'Owner action. ' : ''}Item ${i} ${long(4)}\n  continued ${long(3)}`, 6)}`).join('\n\n')}\n`],
  ['repeated, dotted and suffixed ids, escaped pipes, multi-line rows', `# Tasks\n\n## One\n\n| # | Task | Status | Owner | Notes |\n|---|---|---|---|---|\n| 7 | first \\| second | in-progress | a | x |\n| 7 | repeated id | todo | a | ${long(5)} |\n| 3.2 | dotted | todo | a | n |\n| 12a | suffixed | todo | a | n |\n| 13 | a row whose notes\n  continue here | blocked | a | Owner decision pending |\n| 14 | closing | todo | a | n |\n`],
]

for (const [name, text] of BOARDS) {
  test(`renders a board with ${name}`, { options: { autofix: false } }, async ($, on) => {
    const dir = '/work/repo'
    const path = `${dir}/TASKS.md`
    const wtDir = '/work/feature-x'
    const wtText = text.replace('todo', 'done')
    const reported: string[] = []
    mock.store(on)
    const clock = mock.clock(on, { now: 1_760_000_000_000 })
    on('session.start', () => ({ cwd: dir }))
    on('session.cwd', () => ({ value: dir }))
  on('session.root', () => ({ value: dir }))
    on('fs.exists', (_$, e) => ({ value: e.path === path }))
    on('fs.stat', (_$, e) => ({
      value: { kind: 'file', size: (e.path === path ? text : wtText).length, mtimeMs: e.path === path ? 1_759_000_000_000 : Date.now(), isLink: false },
    }))
    on('fs.read', (_$, e) => ({ value: e.path === path ? text : wtText }))
    on('process.run', (_$, e) => ({
      value: {
        exitCode: 0,
        stdout: e.argv[0] === 'git' ? `worktree ${dir}\n\nworktree ${wtDir}\n` : '[]',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    on('command.register', () => ({ value: undefined as never }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.status', (_$, e) => {
      reported.push(String(e.text))
      return { value: undefined }
    })

    await $.session.start({ cwd: dir, surface: 'terminal', isInteractive: true })
    await clock.settle() // session.start's board refresh runs unawaited

    const ip = parseBoard(text).find(t => t.status === 'in_progress')!
    for (const bodyColumns of [44, 60, 30]) {
      const ui = await $.ui
        .mount({
          plugin: 'tasks-board',
          surface: 'terminal',
          component: 'Pane',
          requestId: 'tasks-board',
          props: { title: 'Board', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
          viewport: { columns: bodyColumns + 40, rows: 60, isFullscreen: true },
        })
        .catch(err => {
          throw new Error(`${String(err)} at ${bodyColumns} columns; reported: ${reported.join(' ;; ')}`)
        })
      const first = JSON.stringify(await ui.drawn())
      expect(first).not.toContain('render failed')
      expect(badButtons(await ui.drawn())).toEqual([])
      expect(first).toContain('Task')

      if (bodyColumns === 44) {
        // Open every epic, then some task rows (state persists across the later widths).
        for (const b of await ui.findAll({ type: 'Button' })) {
          if (b.key?.startsWith('epic:')) await ui.press({ key: b.key })
        }
        if (ip) expect(JSON.stringify(await ui.drawn())).toContain(ip.id)
        for (const b of (await ui.findAll({ type: 'Button' })).slice(0, 12)) {
          if (b.key?.startsWith('t')) await ui.press({ key: b.key })
        }
        expect(JSON.stringify(await ui.drawn())).toContain('Owner')
        expect(badButtons(await ui.drawn())).toEqual([])
      } else {
        expect(JSON.stringify(await ui.drawn())).not.toContain('render failed')
      }
      await ui.unmount()
    }
    expect(reported).toEqual([])
  })
}

test('a non-canonical primary board launches the formatting agent once, recorded in the store', async ($, on) => {
  const dir = '/work/repo'
  const text = '# Tasks\n\n| # | Task | Status | Owner | Notes |\n|---|---|---|---|---|\n| 1 | a | todo | | n |\n'
  const spawned: string[] = []
  const calls: string[] = []
  mock.store(on)
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  on('session.start', () => ({ cwd: dir }))
  on('session.cwd', () => ({ value: dir }))
  on('session.root', () => ({ value: dir }))
  on('fs.exists', (_$, e) => ({ value: e.path === `${dir}/TASKS.md` }))
  on('fs.stat', () => ({ value: { kind: 'file', size: text.length, mtimeMs: 1_759_000_000_000, isLink: false } }))
  on('fs.read', () => ({ value: text }))
  on('process.run', (_$, e) => {
    calls.push(e.argv.join(' '))
    const out = e.argv[0] === 'gh' ? '[]' : e.argv.includes('remote') ? 'git@github.com:Some-Org/app.git\n' : `worktree ${dir}\n`
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.spawn', (_$, e) => {
    spawned.push(e.prompt)
    return { model: 'sonnet', agentId: 'a1' }
  })
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: dir, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(spawned.length).toBe(1)
  expect(spawned[0]).toContain('Some-Org/app')
  expect(calls.some(c => c.startsWith('gh pr list -R Some-Org/app'))).toBe(true)
  // A second refresh (another session, a reload) finds the record and launches nothing.
  await $.session.start({ cwd: dir, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(spawned.length).toBe(1)
})

test('worktree variants are what the worktree changed since it forked, not where the primary moved on', async ($, on) => {
  const dir = '/work/repo'
  const table = (s1: string, s2: string, s3: string) =>
    `# Tasks\n\n## Epic\n\n| # | Task | Status | Owner | Notes |\n|---|---|---|---|---|\n| 1 | one | ${s1} | | |\n| 2 | two | ${s2} | | |\n| 3 | three | ${s3} | | |\n`
  const primary = table('todo', 'in_progress', 'todo') // the primary moved on: row 2 started
  const fork = table('todo', 'todo', 'todo')
  const boards: Record<string, string> = {
    [`${dir}/TASKS.md`]: primary,
    '/work/stale/TASKS.md': fork, // unchanged since it forked
    '/work/edited/TASKS.md': table('todo', 'todo', 'in_progress'), // started row 3 itself
  }
  const reported: string[] = []
  mock.store(on)
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  on('session.start', () => ({ cwd: dir }))
  on('session.cwd', () => ({ value: dir }))
  on('session.root', () => ({ value: dir }))
  on('fs.exists', (_$, e) => ({ value: e.path === `${dir}/TASKS.md` }))
  on('fs.stat', (_$, e) => ({
    value: { kind: 'file', size: (boards[e.path] ?? '').length, mtimeMs: e.path === `${dir}/TASKS.md` ? 1_759_000_000_000 : Date.now(), isLink: false },
  }))
  on('fs.read', (_$, e) => ({ value: boards[e.path] ?? '' }))
  on('process.run', (_$, e) => {
    const git = e.argv.slice(3).join(' ')
    const out = git.startsWith('worktree list')
      ? `worktree ${dir}\n\nworktree /work/stale\n\nworktree /work/edited\n`
      : git.startsWith('rev-parse')
        ? 'base1\n'
        : git.startsWith('merge-base')
          ? 'fork1\n'
          : e.argv[0] === 'sh' && e.argv[5] === 'fork1:TASKS.md'
            ? fork
            : ''
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_$, e) => {
    reported.push(String(e.text))
    return { value: undefined }
  })

  await $.session.start({ cwd: dir, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'tasks-board',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tasks-board',
    props: { title: 'Board', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    viewport: { columns: 120, rows: 60, isFullscreen: true },
  })
  for (const b of await ui.findAll({ type: 'Button' })) {
    if (b.key?.startsWith('epic:')) await ui.press({ key: b.key })
  }
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('[edited]')
  expect(drawn).not.toContain('[stale]')
  expect(reported).toEqual([])
})

test('every Button has a label or one string child, on an mc3-like board', { options: { autofix: false } }, async ($, on) => {
  const dir = '/work/repo'
  const head = '| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |\n|---|---|---|---|---|---|---|---|'
  const text = `# Tasks\n\n## Live\n\n${head}\n| F1 | ${long(8)} | in_progress | agent-a | | | | n |\n| 12a | short | todo | | | F1 | | n |\n| 7 | renumbered | blocked_on_owner | | | | 2026-10-10 14:00 ICT | n |\n| 8 | ${long(12)} | done | | | | | n |\n\n## Archive — era\n\n${head}\n| 1 | old | done | | | | | n |\n| 2 | older | done | | | | | n |\n`
  const reported: string[] = []
  mock.store(on)
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  on('session.start', () => ({ cwd: dir }))
  on('session.cwd', () => ({ value: dir }))
  on('session.root', () => ({ value: dir }))
  on('fs.exists', (_$, e) => ({ value: e.path === `${dir}/TASKS.md` }))
  on('fs.stat', () => ({ value: { kind: 'file', size: text.length, mtimeMs: 1_759_000_000_000, isLink: false } }))
  on('fs.read', () => ({ value: text }))
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stdout: e.argv[0] === 'git' ? `worktree ${dir}\n` : '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_$, e) => {
    reported.push(String(e.text))
    return { value: undefined }
  })
  await $.session.start({ cwd: dir, surface: 'terminal', isInteractive: true })
  await clock.settle()
  for (const bodyColumns of [44, 60]) {
    const ui = await $.ui.mount({
      plugin: 'tasks-board',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'tasks-board',
      props: { title: 'Board', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
      viewport: { columns: bodyColumns + 40, rows: 60, isFullscreen: true },
    })
    for (const b of await ui.findAll({ type: 'Button' })) {
      if (bodyColumns === 44 && b.key?.startsWith('epic:')) await ui.press({ key: b.key })
    }
    const drawn = JSON.stringify(await ui.drawn())
    expect(badButtons(await ui.drawn())).toEqual([])
    // The engine insists on a label or one string child; labels must be plain stable text, never the drawn row.
    const labels = (await ui.findAll({ type: 'Button' })).map(b => String(b.props?.label))
    const f1 = parseBoard(text).find(t => t.id === 'F1')!
    if (bodyColumns === 44) {
      expect(labels.some(l => l.trim().startsWith(f1.title.slice(0, 10)))).toBe(true)
      expect(labels.map(l => l.trim())).toContain('short')
    }
    expect(labels.map(l => l.trim())).toContain('Live (1)')
    expect(labels).toContain('[a] all')
    expect(labels.filter(l => l.includes('│'))).toEqual([])
    expect(drawn).not.toContain('render failed')
    expect(drawn).toContain('F1')
    await ui.unmount()
  }
  expect(reported).toEqual([])
})

test('number cells are plain pressable Buttons, open epics and toggle tasks, in coloured and active rows', { options: { autofix: false } }, async ($, on) => {
  const dir = '/work/repo'
  const head = '| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |\n|---|---|---|---|---|---|---|---|'
  let text = `# Tasks\n\n## Live\n\n${head}\n| F1 | ${long(8)} | in_progress | agent-a | | | | n |\n| 12a | short | todo | | | F1 | | n |\n| 7 | renumbered | blocked_on_owner | | | | 2026-10-10 14:00 ICT | n |\n| 8 | ${long(12)} | done | | | | | n |\n\n## Archive — era\n\n${head}\n| 1 | old | done | | | | | n |\n| 2 | older | done | | | | | n |\n`
  const reported: string[] = []
  mock.store(on)
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  on('session.start', () => ({ cwd: dir }))
  on('session.cwd', () => ({ value: dir }))
  on('session.root', () => ({ value: dir }))
  on('fs.exists', (_$, e) => ({ value: e.path === `${dir}/TASKS.md` }))
  on('fs.stat', () => ({ value: { kind: 'file', size: text.length, mtimeMs: 1_759_000_000_000, isLink: false } }))
  on('fs.read', () => ({ value: text }))
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stdout: e.argv[0] === 'git' ? `worktree ${dir}\n` : '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_$, e) => {
    reported.push(String(e.text))
    return { value: undefined }
  })
  await $.session.start({ cwd: dir, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'tasks-board',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tasks-board',
    props: { title: 'Board', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    viewport: { columns: 100, rows: 60, isFullscreen: true },
  })
  text = text.replace('| renumbered |', '| renumbered again |').replace('| F1 | ', '| F1 | edited ') // a later change marks rows active
  await ui.press({ key: 'fr' })
  await clock.settle()
  const cn = async () => (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('cn'))
  const dets = async () => JSON.stringify(await ui.drawn()).split('"key":"det').length - 1
  const epics = await cn()
  expect(epics.length).toBeGreaterThan(0)
  for (const b of epics) await ui.press({ key: b.key! }) // epic numbers open their epic
  const tasks = (await cn()).filter(b => !b.key!.includes('|'))
  expect(tasks.length).toBeGreaterThanOrEqual(3)
  expect(await dets()).toBe(0)
  for (const b of tasks) {
    await ui.press({ key: b.key! }) // each number toggles its row's details, coloured section or spinner or not
    expect(await dets()).toBe(1)
    await ui.press({ key: b.key! })
    expect(await dets()).toBe(0)
  }
  expect(JSON.stringify(await ui.drawn())).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/) // an active row's spinner sits in its number label
  const hovers: { type?: string; hover?: unknown }[] = []
  const walk = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const o = n as { type?: string; hover?: unknown }
      if (o.hover !== undefined) hovers.push(o)
      Object.values(n).forEach(walk)
    }
  }
  walk(await ui.drawn())
  const full = { inverse: true, backgroundColor: '#1c1c1c', color: '#d0d0d0', dimColor: false }
  // every hover is the full row style
  for (const h of hovers) expect(h.hover).toEqual(full)
  for (const h of hovers) if (h.type === 'Button') expect(h.hover).toEqual(full)
  expect(badButtons(await ui.drawn())).toEqual([])
  expect(reported).toEqual([])
  await ui.unmount()
})

test('an open epic keeps its task rows outside its own Box, so hovering a task does not light the epic', { options: { autofix: false } }, async ($, on) => {
  const dir = '/work/repo'
  const text = `# Tasks\n\n## Epic\n\n| # | Task | Status | Owner | Notes |\n|---|---|---|---|---|\n| 1 | one | todo | | |\n| 2 | two | todo | | |\n`
  mock.store(on)
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  on('session.start', () => ({ cwd: dir }))
  on('session.cwd', () => ({ value: dir }))
  on('session.root', () => ({ value: dir }))
  on('fs.exists', (_$, e) => ({ value: e.path === `${dir}/TASKS.md` }))
  on('fs.stat', () => ({ value: { kind: 'file', size: text.length, mtimeMs: 1_759_000_000_000, isLink: false } }))
  on('fs.read', () => ({ value: text }))
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stdout: e.argv[0] === 'git' ? `worktree ${dir}\n` : '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: dir, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'tasks-board',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tasks-board',
    props: { title: 'Board', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    viewport: { columns: 100, rows: 60, isFullscreen: true },
  })
  for (const b of await ui.findAll({ type: 'Button' })) {
    if (b.key?.startsWith('epic:')) await ui.press({ key: b.key })
  }
  // Element keys live in props.key; collect them under a node, and find the epic Boxes.
  type Node = { type?: string; props?: { key?: string }; children?: unknown[] }
  const keys = (node: unknown, out: string[] = []): string[] => {
    if (Array.isArray(node)) node.forEach(n => keys(n, out))
    else if (node && typeof node === 'object') {
      const n = node as Node
      if (typeof n.props?.key === 'string') out.push(n.props.key)
      keys(n.children, out)
    }
    return out
  }
  const epics: Node[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') {
      const n = node as Node
      if (n.type === 'Box' && n.props?.key?.startsWith('epic') && !n.props.key.startsWith('epic:')) epics.push(n)
      walk(n.children)
    }
  }
  const drawn = await ui.drawn()
  walk(drawn)
  expect(keys(drawn).filter(k => k.startsWith('row')).length).toBeGreaterThan(0) // the epic is open
  expect(epics.length).toBeGreaterThan(0)
  for (const e of epics) expect(keys(e).filter(k => k.startsWith('row'))).toEqual([])
  await ui.unmount()
})

test('expanded details show the full notes, split on <br>, with no hover and outside the row Box', { options: { autofix: false } }, async ($, on) => {
  const dir = '/work/repo'
  const long = Array.from({ length: 250 }, (_, i) => `w${i}x`).join(' ') // ~1,250 characters
  const text = `# Tasks\n\n## Epic\n\n| # | Task | Status | Owner | Notes |\n|---|---|---|---|---|\n| 1 | one | todo | | ${long}<br>SECOND<br/>THIRD |\n`
  mock.store(on)
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  on('session.start', () => ({ cwd: dir }))
  on('session.cwd', () => ({ value: dir }))
  on('session.root', () => ({ value: dir }))
  on('fs.exists', (_$, e) => ({ value: e.path === `${dir}/TASKS.md` }))
  on('fs.stat', () => ({ value: { kind: 'file', size: text.length, mtimeMs: 1_759_000_000_000, isLink: false } }))
  on('fs.read', () => ({ value: text }))
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stdout: e.argv[0] === 'git' ? `worktree ${dir}\n` : '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: dir, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'tasks-board',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tasks-board',
    props: { title: 'Board', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 100 }, view: {} },
    viewport: { columns: 100, rows: 100, isFullscreen: true },
  })
  for (const b of await ui.findAll({ type: 'Button' })) if (b.key?.startsWith('epic:')) await ui.press({ key: b.key })
  for (const b of await ui.findAll({ type: 'Button' })) if (b.key?.startsWith('t')) await ui.press({ key: b.key })
  type Node = { type?: string; props?: { key?: string; hover?: unknown }; children?: unknown[] }
  const find = (node: unknown, f: (n: Node) => boolean, out: Node[] = []): Node[] => {
    if (Array.isArray(node)) node.forEach(n => find(n, f, out))
    else if (node && typeof node === 'object') {
      const n = node as Node
      if (f(n)) out.push(n)
      find(n.children, f, out)
    }
    return out
  }
  const drawn = await ui.drawn()
  const [det] = find(drawn, n => n.type === 'Box' && !!n.props?.key?.startsWith('det'))
  expect(det).toBeDefined()
  expect(find(drawn, n => n.type === 'Box' && !!n.props?.key?.startsWith('row')).flatMap(r => find(r, n => n.props?.key?.startsWith('det') === true))).toEqual([])
  expect(find(det, n => n.props?.hover !== undefined)).toEqual([])
  const lines = (det!.children as unknown[]).slice(1, -1).map(n => JSON.stringify(n)) // between the two rules
  const body = lines.join('')
  for (let i = 0; i < 250; i++) expect(body).toContain(`w${i}x`)
  expect(lines.some(l => l.includes('SECOND'))).toBe(true)
  expect(lines.filter(l => l.includes('SECOND') && l.includes('THIRD'))).toEqual([]) // <br> and <br/> each break the line
  await ui.unmount()
})

test('expanded details start with a Ref line <epic>.<task>', { options: { autofix: false } }, async ($, on) => {
  const dir = '/work/repo'
  const long = Array.from({ length: 250 }, (_, i) => `w${i}x`).join(' ') // ~1,250 characters
  const text = `# Tasks\n\n## 7. Epic\n\n| # | Task | Status | Owner | Notes |\n|---|---|---|---|---|\n| 41 | one | todo | | ${long}<br>SECOND<br/>THIRD |\n`
  mock.store(on)
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  on('session.start', () => ({ cwd: dir }))
  on('session.cwd', () => ({ value: dir }))
  on('session.root', () => ({ value: dir }))
  on('fs.exists', (_$, e) => ({ value: e.path === `${dir}/TASKS.md` }))
  on('fs.stat', () => ({ value: { kind: 'file', size: text.length, mtimeMs: 1_759_000_000_000, isLink: false } }))
  on('fs.read', () => ({ value: text }))
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stdout: e.argv[0] === 'git' ? `worktree ${dir}\n` : '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: dir, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'tasks-board',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tasks-board',
    props: { title: 'Board', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 100 }, view: {} },
    viewport: { columns: 100, rows: 100, isFullscreen: true },
  })
  for (const b of await ui.findAll({ type: 'Button' })) if (b.key?.startsWith('epic:')) await ui.press({ key: b.key })
  for (const b of await ui.findAll({ type: 'Button' })) if (b.key?.startsWith('t')) await ui.press({ key: b.key })
  type Node = { type?: string; props?: { key?: string; hover?: unknown }; children?: unknown[] }
  const find = (node: unknown, f: (n: Node) => boolean, out: Node[] = []): Node[] => {
    if (Array.isArray(node)) node.forEach(n => find(n, f, out))
    else if (node && typeof node === 'object') {
      const n = node as Node
      if (f(n)) out.push(n)
      find(n.children, f, out)
    }
    return out
  }
  const drawn = await ui.drawn()
  const [det] = find(drawn, n => n.type === 'Box' && !!n.props?.key?.startsWith('det'))
  expect(det).toBeDefined()
  expect(find(drawn, n => n.type === 'Box' && !!n.props?.key?.startsWith('row')).flatMap(r => find(r, n => n.props?.key?.startsWith('det') === true))).toEqual([])
  expect(find(det, n => n.props?.hover !== undefined)).toEqual([])
  expect(JSON.stringify(det)).toMatch(/Ref {5}.*7\.41/s)
  const first = (det!.children as unknown[])[1]
  expect(JSON.stringify(first)).toContain('Ref')
  await ui.unmount()
})
