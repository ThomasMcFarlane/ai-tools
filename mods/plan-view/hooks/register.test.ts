import { expect, mock, test } from 'claude-code/testing'

const PLAN = '/home/u/.claude/plans/quiet-fox.md'
const TEXT = '# Add caching\n\n- step one\n- step two\n'

// Boots the plugin with a plan file on a fake disk; `opened` collects ui.open calls, `closed` ui.close calls.
const boot = async ($: any, on: any, learn = true) => {
  const opened: { id: string; title?: string }[] = []
  const closed: string[] = []
  const disk: Record<string, string> = { [PLAN]: TEXT, '/work/docs/spec.md': '# The spec\n\nbody\n', '/work/notes.txt': 'x', '/work/docs/a.md': '# A\n', '/work/docs/b.md': '# B\n' }
  let isOpen = false
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }))
  mock.clock(on, { now: 1_760_000_000_000 })
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in disk }))
  on('fs.read', (_$: any, e: any) => ({ value: disk[e.path] ?? '' }))
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', (_$: any, e: any) => {
    opened.push({ id: e.id, title: e.title })
    isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: isOpen ? [{ id: 'plan-view' }] : [] }))
  on('ui.close', (_$: any, e: any) => {
    closed.push(e.id)
    isOpen = false
    return { value: undefined }
  })
  on('prompt.attachment', () => ({ text: null }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: '' })) // base of the band chain
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', () => ({ value: '/work' }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.status', (_$: any, e: any) => {
    throw new Error(`plan-view reported: ${e.text}`) // a failure inside the plugin fails the test
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  if (learn) await $.prompt.attachment({ type: 'plan_mode', text: 'x', detail: { planFilePath: PLAN } } as any)
  return { opened, closed, disk }
}

test('writing the plan file opens the pane with its markdown', async ($, on) => {
  const { opened } = await boot($, on)
  await $.tool.call({ tool: 'Write', file_path: PLAN, content: TEXT })
  expect(opened).toEqual([{ id: 'plan-view', title: 'Add caching' }])
  const ui = await $.ui.mount({
    plugin: 'plan-view',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'plan-view',
    props: { title: 'Add caching', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    viewport: { columns: 100, rows: 40, isFullscreen: true },
  })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Markdown')
  expect(drawn).toContain('step one')
  expect(drawn).toContain(PLAN)
  await ui.unmount()
})

test('a write to any other file does nothing', async ($, on) => {
  const { opened } = await boot($, on)
  await $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/work/plans/a.md', content: 'x' })
  expect(opened).toEqual([])
})

test('/plan-view says so with no plan, then toggles the pane', async ($, on) => {
  const { opened, closed } = await boot($, on, false)
  expect(JSON.stringify(await $.command.run({ command: 'plan-view', args: '' }))).toContain('Nothing to preview yet')
  await $.prompt.attachment({ type: 'plan_mode', text: 'x', detail: { planFilePath: PLAN } } as any)
  await $.tool.call({ tool: 'Write', file_path: PLAN, content: TEXT })
  await $.command.run({ command: 'plan-view', args: '' })
  expect(closed).toEqual(['plan-view'])
  await $.command.run({ command: 'plan-view', args: '' })
  expect(opened.length).toBe(2)
})

const reply = (answer: string) => ({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' }) as any

const mountBand = ($: any) =>
  $.ui.mount({
    plugin: 'plan-view',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false },
    viewport: { columns: 100, rows: 40, isFullscreen: true },
  })

test('a mentioned existing .md file is offered; non-files are not', async ($, on) => {
  await boot($, on)
  const ui = await mountBand($)
  expect(JSON.stringify(await ui.drawn())).not.toContain('Markdown preview')
  await $.turn.complete(reply('Wrote `docs/spec.md`, notes.txt and missing.md'))
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Markdown preview')
  expect(drawn).toContain('spec.md')
  expect(drawn).toContain('Dismiss')
  expect(drawn).not.toContain('missing.md')
  expect(drawn).not.toContain('notes.txt')
  await ui.unmount()
})

test('Open shows the offered file and clears the offer', async ($, on) => {
  const { opened } = await boot($, on)
  const ui = await mountBand($)
  await $.turn.complete(reply('See /work/docs/spec.md'))
  await ui.press({ key: 'open' })
  expect(opened).toEqual([{ id: 'plan-view', title: 'The spec' }])
  expect(JSON.stringify(await ui.drawn())).not.toContain('Markdown preview')
  await $.turn.complete(reply('Again /work/docs/spec.md'))
  expect(JSON.stringify(await ui.drawn())).not.toContain('Markdown preview') // already offered
  await ui.unmount()
})

test('Dismiss clears the offer without opening', async ($, on) => {
  const { opened } = await boot($, on)
  const ui = await mountBand($)
  await $.turn.complete(reply('See docs/spec.md'))
  await ui.press({ key: 'dismiss' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('Markdown preview')
  expect(opened).toEqual([])
  await ui.unmount()
})

const mountMessage = ($: any, text: string) =>
  $.ui.mount({
    plugin: 'plan-view',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true },
    viewport: { columns: 100, rows: 40, isFullscreen: true },
  })

test('a message mentioning an existing .md gets an inline card, others do not', async ($, on) => {
  const { opened } = await boot($, on)
  const none = await mountMessage($, 'See notes.txt and missing.md')
  expect(JSON.stringify(await none.drawn())).not.toContain('Markdown preview')
  await none.unmount()
  const ui = await mountMessage($, 'See docs/spec.md')
  expect(JSON.stringify(await ui.drawn())).toContain('Markdown preview')
  await ui.press({ key: 'open:/work/docs/spec.md' })
  expect(opened).toEqual([{ id: 'plan-view', title: 'The spec' }])
  expect(JSON.stringify(await ui.drawn())).toContain('Markdown preview') // stays after Open
  await ui.unmount()
})

test('the band shows one file at a time; Prev and Next walk them', async ($, on) => {
  await boot($, on)
  const ui = await mountBand($)
  await $.turn.complete(reply('See docs/a.md'))
  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain(' of ')
  expect(drawn).not.toContain('Prev')
  await $.turn.complete(reply('And docs/b.md'))
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('2 of 2')
  expect(drawn).toContain('b.md')
  await ui.press({ key: 'next' })
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('1 of 2')
  expect(drawn).toContain('a.md')
  await ui.press({ key: 'prev' })
  expect(JSON.stringify(await ui.drawn())).toContain('2 of 2')
  await ui.unmount()
})

test('Dismiss and Open remove only the shown file', async ($, on) => {
  const { opened } = await boot($, on)
  const ui = await mountBand($)
  await $.turn.complete(reply('docs/a.md docs/b.md'))
  await ui.press({ key: 'dismiss' }) // b.md was newest
  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('a.md')
  expect(drawn).not.toContain(' of ')
  expect(opened).toEqual([])
  await $.turn.complete(reply('docs/spec.md'))
  await ui.press({ key: 'prev' })
  await ui.press({ key: 'open' }) // opens a.md
  expect(opened).toEqual([{ id: 'plan-view', title: 'A' }])
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('spec.md')
  expect(drawn).not.toContain(' of ')
  await ui.unmount()
})
