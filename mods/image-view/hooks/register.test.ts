import { expect, mock, test } from 'claude-code/testing'

const PNG_4x2 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAACZgbYnAAAAEklEQVR4nGP4z8Dwn4GBgQEAFAAC/6a5wQAAAABJRU5ErkJggg=='

const boot = async ($: any, on: any) => {
  const opened: string[] = []
  const placed: string[] = []
  const ran: string[][] = []
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path.startsWith('/work/') }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 100, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_$: any, e: any) => ({ value: e.as === 'bytes' ? { base64: PNG_4x2 } : '' }))
  on('process.run', (_$: any, e: any) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', (_$: any, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: opened.length ? [{ id: 'image-view' }] : [] }))
  on('ui.place', (_$: any, e: any) => {
    placed.push(e.id)
    return { value: { isPlaced: true as const, requestId: `p-${e.id}` } }
  })
  on('ui.status', (_$: any, e: any) => {
    throw new Error(`image-view reported: ${e.text}`)
  })
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  return { opened, placed, ran }
}

test('reading a png shows it in the pane and as a chat item without converting', async ($, on) => {
  const { opened, placed, ran } = await boot($, on)
  await $.tool.call({ tool: 'Read', file_path: '/work/shot.png' })
  expect(opened).toEqual(['image-view'])
  expect(placed).toEqual(['img-1'])
  expect(ran).toEqual([])
})

test('reading a file that is not an image does nothing', async ($, on) => {
  const { opened, placed } = await boot($, on)
  await $.tool.call({ tool: 'Read', file_path: '/work/notes.txt' })
  expect(opened).toEqual([])
  expect(placed).toEqual([])
})

test('a jpg goes through a converter, and /image shows it', async ($, on) => {
  const { opened, placed, ran } = await boot($, on)
  const out = await $.command.run({ command: 'image', args: 'photo.jpg' } as any)
  expect(ran[0][0]).toBe('magick')
  expect(opened).toEqual(['image-view'])
  expect(placed).toEqual(['img-1'])
  expect(JSON.stringify(out)).toContain('Showing photo.jpg (4 x 2)')
})

test('/image names a missing file and a wrong type', async ($, on) => {
  await boot($, on)
  expect(JSON.stringify(await $.command.run({ command: 'image', args: '/nowhere/a.png' } as any))).toContain('No such file')
  expect(JSON.stringify(await $.command.run({ command: 'image', args: 'a.txt' } as any))).toContain('Not a png')
})

test('the pane and the chat item draw the picture on the terminal and say so elsewhere', async ($, on) => {
  await boot($, on)
  await $.tool.call({ tool: 'Read', file_path: '/work/shot.png' })
  const pane = { title: 'shot.png', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }
  for (const [component, props, requestId] of [['Pane', pane, 'image-view'], ['Placed', { id: 'img-1', plugin: 'image-view' }, undefined]] as const) {
    const ui = await $.ui.mount({ plugin: 'image-view', surface: 'terminal', component, requestId, props, viewport: { columns: 100, rows: 40 } } as any)
    const out = JSON.stringify(await ui.drawn())
    expect(out).toContain('shot.png')
    expect(out).toContain('4 x 2')
    expect(out).toContain('"png"')
    await ui.unmount()
  }
  const desktop = await $.ui.mount({ plugin: 'image-view', surface: 'desktop', component: 'Pane', requestId: 'image-view', props: pane, viewport: { columns: 100, rows: 40 } } as any)
  expect(JSON.stringify(await desktop.drawn())).toContain('cannot draw images')
})
