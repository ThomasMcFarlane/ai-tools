import { expect, mock, test } from 'claude-code/testing'

const R = 'octo-org/hello-world'
const BAND = { bodyColumns: 120, hasSurvey: false, isWorking: false, maxRows: 10, scroll: { offset: 0, bodyRows: 10 }, view: {} } as any

type Job = { name: string; status: string; conclusion: string | null; steps: { name: string; number: number; status: string; conclusion: string | null }[] }

const job = (status: string, conclusion: string | null = null): Job => ({
  name: 'build',
  status,
  conclusion,
  steps: [
    { name: 'Checkout', number: 1, status: 'completed', conclusion: 'success' },
    { name: 'Test', number: 2, status, conclusion },
  ],
})

const run = (id: number, status: string, conclusion: string | null = null, extra: object = {}) => ({
  databaseId: id,
  workflowName: `Flow${id}`,
  status,
  conclusion,
  url: `https://example.com/octo-org/hello-world/actions/runs/${id}`,
  startedAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:01:30Z',
  attempt: 1,
  jobs: [job(status, conclusion)],
  ...extra,
})

const line = (runs: object[], over: object = {}) =>
  `${JSON.stringify({ repo: R, targetKey: 'pr:17', state: 'pending', runs, failedSteps: [], source: 'events', checkedAt: '2026-01-01T00:01:00Z', isFinal: false, ...over })}\n`

// A scripted child: the test pushes stdout text, ends it with an exit code, or has the binary missing.
const channel = () => {
  const queue: (string | { code: number } | { error: string })[] = []
  let wake: (() => void) | undefined
  return {
    push(text: string) {
      queue.push(text)
      wake?.()
    },
    end(code: number) {
      queue.push({ code })
      wake?.()
    },
    fail(error: string) {
      queue.push({ error })
      wake?.()
    },
    async *generate(): AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }, never> {
      for (;;) {
        while (!queue.length) await new Promise<void>(resolve => (wake = resolve))
        const item = queue.shift() as (typeof queue)[number]
        if (typeof item === 'string') yield { stream: 'stdout', text: item }
        else if ('error' in item) throw new Error(item.error)
        else return { value: { code: item.code, signal: null } } as never
      }
    },
  }
}

let statuses: string[] = []
let raised: string[] = []
let refuse = false
let frameWrites = 0

const boot = async ($: any, on: any, surface: 'terminal' | 'desktop' = 'terminal') => {
  statuses = []
  raised = []
  refuse = false
  frameWrites = 0
  const clock = mock.clock(on, { now: Date.parse('2026-01-01T00:01:40Z') })
  const session = mock.session(on)
  const child = channel()
  const spawned: { argv: readonly string[] }[] = []
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined as never }))
  on('ui.place', (_$: any, e: any) => {
    raised.push(e.id)
    return refuse ? { value: { isPlaced: false as const, reason: 'no surface' } } : { value: { isPlaced: true as const, requestId: `p-${e.id}` } }
  })
  on('ui.status', (_$: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('state.set', (_$: any, e: any, next: any) => {
    if (e.key === 'frame') frameWrites += 1
    return next(e)
  })
  on('session.end', () => ({ sessionId: 's' }))
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'engine' }))
  on('process.spawn', async function* (_$: any, e: any) {
    spawned.push({ argv: e.argv })
    return yield* child.generate()
  })
  await $.session.start({ cwd: '/work', surface, isInteractive: true })
  const band = (s: 'terminal' | 'desktop' = surface, rows = 40) =>
    $.ui.mount({ plugin: 'gh-runs', surface: s, component: 'AbovePrompt', props: BAND, requestId: `band-${Math.random()}`, viewport: { columns: 120, rows } })
  const track = async (arg = `${R}#17`) => {
    const answer = await $.command.run({ command: 'ci-track', args: arg } as any)
    await clock.settle()
    return answer
  }
  const feed = async (text: string) => {
    child.push(text)
    await clock.settle()
    await clock.settle()
  }
  return { clock, session, child, spawned, band, track, feed }
}

const drawn = async (ui: any) => JSON.stringify(await ui.drawn())

test('/ci-track tracks a PR, lists it, and refuses a bad argument with the usage line', async ($, on) => {
  const { track } = await boot($, on)
  expect(JSON.stringify(await track('nonsense'))).toContain('Usage: /ci-track')
  expect(JSON.stringify(await $.command.run({ command: 'ci-track', args: '' } as any))).toContain('Nothing is tracked')
  expect(JSON.stringify(await track(`https://github.com/${R}/pull/17`))).toContain(`Tracking ${R}#17.`)
  expect(JSON.stringify(await $.command.run({ command: 'ci-track', args: '' } as any))).toContain(`- ${R}#17`)
  expect(JSON.stringify(await track(`${R} 17`))).toContain('Already tracking')
})

test('one follower per target, started with gh-watcher follow', async ($, on) => {
  const { track, spawned } = await boot($, on)
  await track()
  await track(`https://github.com/${R}/pull/17`)
  expect(spawned.length).toBe(1)
  expect(spawned[0]?.argv.slice(0, 6)).toEqual(['gh-watcher', 'follow', '--repo', R, '--pr', '17'])
})

test('a gh-watcher wait command in a Bash call is tracked and the call goes through untouched', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const { clock, spawned } = await boot($, on)
  const result = await $.tool.call({ tool: 'Bash', command: `cd /work && GH_REPO=${R} gh-watcher wait --pr 17 --interval 15s` })
  expect(JSON.stringify(result)).toContain('ok')
  await clock.settle()
  expect(spawned.length).toBe(1)
  expect(spawned[0]?.argv).toContain('17')
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'sub-1' })
  await $.tool.call({ tool: 'Bash', command: 'gh-watcher wait --pr 9' })
  await clock.settle()
  expect(spawned.length).toBe(1)
})

test('a Bash call that polls CI is denied with the gh-watcher replacement, and nothing is tracked', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const { clock, spawned } = await boot($, on)
  const result = await $.tool.call({ tool: 'Bash', command: `gh-watcher wait --repo ${R} --pr 17; until gh pr checks 17 | grep -q pass; do sleep 30; done` })
  expect(JSON.stringify(result)).toContain('gh-watcher wait --repo')
  expect(JSON.stringify(result)).toContain('"deny"')
  expect(JSON.stringify(result)).not.toContain('ok')
  await clock.settle()
  expect(spawned.length).toBe(0)
  const monitor = await $.tool.call({ tool: 'Monitor', command: 'curl -s https://api.github.com/repos/a/b/actions/runs/1', description: 'ci', timeout_ms: 1000 } as any)
  expect(JSON.stringify(monitor)).toContain('--run 1')
})

test('a malformed Bash or Monitor input is let through, never blocked', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  await boot($, on)
  for (const tool of ['Bash', 'Monitor']) {
    const result = await $.tool.call({ tool, command: 12345 } as any)
    expect(JSON.stringify(result)).toContain('ok')
    expect(JSON.stringify(result)).not.toContain('deny')
  }
})

test('the band shows a running run on terminal and desktop', async ($, on) => {
  const { track, feed, band } = await boot($, on)
  await track()
  await feed(line([run(1, 'in_progress')]))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band(surface)
    const text = await drawn(ui)
    expect(text).toContain('Flow1')
    expect(text).toContain(R)
    expect(text).toContain('#17')
    expect(text).toContain(`https://example.com/octo-org/hello-world/actions/runs/1`)
    expect(text).toContain(`https://github.com/${R}/pull/17`)
    expect(text).toContain('step 2/2')
    expect(text).toContain('updated 40s ago webhook')
    await ui.unmount()
  }
})

test('the band leaves the engine alone with nothing tracked or when a survey is open', async ($, on) => {
  const { track, feed, band } = await boot($, on)
  let ui = await band()
  expect(await drawn(ui)).not.toContain('Flow1')
  await ui.unmount()
  await track()
  await feed(line([run(1, 'in_progress')]))
  ui = await $.ui.mount({ plugin: 'gh-runs', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
  expect(await drawn(ui)).not.toContain('Flow1')
  await ui.unmount()
})

test('a run leaves the band when it ends while another stays, with one placed row', async ($, on) => {
  const { track, feed, band } = await boot($, on)
  await track()
  await feed(line([run(1, 'in_progress'), run(2, 'in_progress')]))
  await feed(line([run(1, 'completed', 'success'), run(2, 'in_progress')]))
  await feed(line([run(1, 'completed', 'success'), run(2, 'in_progress')], { source: 'poll' }))
  const ui = await band()
  const text = await drawn(ui)
  expect(text).not.toContain('Flow1')
  expect(text).toContain('Flow2')
  expect(text).toContain('polled')
  await ui.unmount()
  expect(raised).toEqual(['1-1'])
})

test('the target is dropped when the follower exits, and a run is announced once per attempt', async ($, on) => {
  const { track, feed, child, clock, band } = await boot($, on)
  await track()
  const failed = run(3, 'completed', 'failure', { jobs: [job('completed', 'failure')] })
  await feed(line([failed], { state: 'failure', isFinal: true }))
  child.end(1)
  await clock.settle()
  expect(JSON.stringify(await $.command.run({ command: 'ci-track', args: '' } as any))).toContain('Nothing is tracked')
  expect(raised).toEqual(['3-1'])
  await track()
  await feed(line([failed, run(3, 'completed', 'success', { attempt: 2 })]))
  expect(raised).toEqual(['3-1', '3-2'])
  const ui = await band()
  expect(await drawn(ui)).not.toContain('Flow3')
  await ui.unmount()
})

const result = (ui: any) => ui

test('the placed row is coloured by conclusion on terminal and desktop', async ($, on) => {
  const { track, feed } = await boot($, on)
  await track()
  const cases: [string, string][] = [
    ['success', 'success'],
    ['failure', 'error'],
    ['cancelled', 'warning'],
    ['timed_out', 'warning'],
    ['skipped', 'inactive'],
    ['neutral', 'inactive'],
  ]
  let id = 10
  for (const [conclusion, colour] of cases) {
    id += 1
    await feed(line([run(id, 'completed', conclusion, { jobs: [job('completed', 'failure')] })]))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'gh-runs', surface, component: 'Placed', props: { id: `${id}-1`, plugin: 'gh-runs' }, viewport: { columns: 100, rows: 40 } } as any)
      const out = await drawn(result(ui))
      expect(out).toContain(conclusion.toUpperCase())
      expect(out).toContain(`Flow${id}`)
      expect(out).toContain(`${R}#17`)
      expect(out).toContain('failed: build / Test')
      expect(out).toContain(`https://example.com/octo-org/hello-world/actions/runs/${id}`)
      expect(out).toContain(`"${colour}"`)
      await ui.unmount()
    }
  }
  const foreign = await $.ui.mount({ plugin: 'gh-runs', surface: 'terminal', component: 'Placed', props: { id: '11-1', plugin: 'other' } } as any)
  expect(await drawn(foreign)).toContain('engine')
  await foreign.unmount()
  const unknown = await $.ui.mount({ plugin: 'gh-runs', surface: 'terminal', component: 'Placed', props: { id: '999-1', plugin: 'gh-runs' } } as any)
  expect(await drawn(unknown)).toContain('engine')
  await unknown.unmount()
})

test('the model gets the plain summary, marked as automatic, as a separate row', async ($, on) => {
  const { track, feed, session } = await boot($, on)
  await track()
  await feed(line([run(5, 'completed', 'failure', { jobs: [job('completed', 'failure')] })]))
  const texts = session.appended().map((r: any) => r.message.content[0].text)
  expect(texts.length).toBe(1)
  expect(texts[0]).toMatch(/^\[gh-runs\] failure {2}Flow5/)
  expect(texts[0]).toContain('failed: build / Test')
  expect(texts[0]).toContain('https://example.com/octo-org/hello-world/actions/runs/5')
  expect(texts[0]).toMatch(/\(Reported automatically by the gh-runs mod; the user did not type this\.\)$/)
})

test('a placed row the engine cannot draw is only noted, and the model still gets the text', async ($, on) => {
  const { track, feed, clock, session } = await boot($, on)
  refuse = true
  await track()
  await feed(line([run(6, 'completed', 'success')]))
  await clock.settle()
  expect(raised).toEqual(['6-1'])
  expect(statuses.some(s => s.startsWith('gh-runs: result row: no surface'))).toBe(true)
  expect(session.appended().length).toBe(1)
})

test('the tick runs only while something is tracked', async ($, on) => {
  const { track, feed, child, clock } = await boot($, on)
  await clock.advance(1000)
  expect(frameWrites).toBe(0)
  await track()
  await feed(line([run(1, 'in_progress')]))
  await clock.advance(1000)
  expect(frameWrites).toBe(4)
  child.end(0)
  await clock.settle()
  await clock.settle()
  const stopped = frameWrites
  await clock.advance(2000)
  expect(frameWrites).toBe(stopped)
})

const failing = (name: string, act: (child: ReturnType<typeof channel>, feed: (t: string) => Promise<void>) => Promise<void>) =>
  test(`a follower failure (${name}) drops the target with a note and never throws`, async ($, on) => {
    const { track, feed, child, clock } = await boot($, on)
    await track()
    await act(child, feed)
    await clock.settle()
    await clock.settle()
    expect(JSON.stringify(await $.command.run({ command: 'ci-track', args: '' } as any))).toContain('Nothing is tracked')
    expect(statuses.some(s => s.startsWith('gh-runs:'))).toBe(true)
  })

failing('malformed line', (_c, feed) => feed('not json\n'))
failing('exit code 2', async c => c.end(2))
failing('timeout', async c => c.end(124))
failing('missing binary', async c => c.fail('spawn gh-watcher ENOENT'))

test('session end stops the followers', async ($, on) => {
  const { track, feed, child, clock, session } = await boot($, on)
  await track()
  await feed(line([run(1, 'in_progress')]))
  await $.session.end({ reason: 'other', sessionId: 's', resume: { id: 's' } } as any)
  await clock.settle()
  child.push(line([run(1, 'completed', 'success')]))
  await clock.settle()
  await clock.settle()
  expect(raised).toEqual([])
})

const stepJob = (name: string, steps: [string, string, string | null][]): Job => ({
  name,
  status: 'in_progress',
  conclusion: null,
  steps: steps.map(([n, status, conclusion], i) => ({ name: n, number: i + 1, status, conclusion })),
})

const GROUP = `expand:g:${R.toLowerCase()}|pr:17`
const KEY = (id: number) => `expand:r:${id}`
const JOB = (id: number) => `expand:j:${id}:build`

const withSteps = (id: number, prefix: string) =>
  run(id, 'in_progress', null, {
    jobs: [
      stepJob('build', [
        [`${prefix} Checkout`, 'completed', 'success'],
        [`${prefix} Test`, 'in_progress', null],
      ]),
    ],
  })

const open2 = async (ui: any, id: number) => {
  await ui.press({ plugin: 'gh-runs', key: KEY(id) })
  await ui.press({ plugin: 'gh-runs', key: JOB(id) })
}

test('the band is a tree: the group is open, runs and jobs start collapsed', async ($, on) => {
  const { track, feed, band } = await boot($, on)
  await track()
  await feed(line([withSteps(1, 'one'), withSteps(2, 'two')]))
  const ui = await band()
  const text = await drawn(ui)
  expect(text).toContain(`${R}`)
  expect(text).toContain('2 runs')
  expect(text).toContain('2 running')
  expect(text).toContain('Flow1')
  expect(text).toContain('Flow2')
  expect(text).toContain('▾')
  expect(text).toContain('▸')
  expect(text).not.toContain('build')
  expect(text).not.toContain('one Checkout')
  await ui.unmount()
})

test('each chevron toggles its own level, surviving redraws and the tick', async ($, on) => {
  const { track, feed, band, clock } = await boot($, on)
  await track()
  await feed(line([withSteps(1, 'one')]))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band(surface)
    await ui.press({ plugin: 'gh-runs', key: KEY(1) })
    let text = await drawn(ui)
    expect(text).toContain('build')
    expect(text).not.toContain('one Checkout')
    await ui.press({ plugin: 'gh-runs', key: JOB(1) })
    await clock.advance(1000)
    await ui.redraw()
    text = await drawn(ui)
    expect(text).toContain('1 one Checkout')
    expect(text).toContain('2 one Test')
    await feed(line([withSteps(1, 'one')], { source: 'poll' }))
    expect(await drawn(ui)).toContain('1 one Checkout')
    await ui.press({ plugin: 'gh-runs', key: JOB(1) })
    text = await drawn(ui)
    expect(text).toContain('build')
    expect(text).not.toContain('one Checkout')
    await ui.press({ plugin: 'gh-runs', key: KEY(1) })
    expect(await drawn(ui)).not.toContain('build')
    await ui.unmount()
  }
})

test('the group chevron hides every run, and a group that returns is open again', async ($, on) => {
  const { track, feed, band } = await boot($, on)
  await track()
  await feed(line([withSteps(1, 'one')]))
  const ui = await band()
  await ui.press({ plugin: 'gh-runs', key: GROUP })
  let text = await drawn(ui)
  expect(text).toContain(R)
  expect(text).not.toContain('Flow1')
  await ui.press({ plugin: 'gh-runs', key: GROUP })
  expect(await drawn(ui)).toContain('Flow1')
  await feed(line([run(1, 'completed', 'success')]))
  await feed(line([withSteps(2, 'two')]))
  text = await drawn(ui)
  expect(text).toContain('Flow2')
  await ui.unmount()
})

test('one run expanding leaves the others collapsed', async ($, on) => {
  const { track, feed, band } = await boot($, on)
  await track()
  await feed(line([withSteps(1, 'one'), withSteps(2, 'two')]))
  const ui = await band()
  await open2(ui, 2)
  const text = await drawn(ui)
  expect(text).toContain('two Checkout')
  expect(text).not.toContain('one Checkout')
  await ui.unmount()
})

test('a short viewport shows no jobs or steps, a tall one does', async ($, on) => {
  const { track, feed, band } = await boot($, on)
  await track()
  await feed(line([withSteps(1, 'one')]))
  const short = await band('terminal', 23)
  await short.press({ plugin: 'gh-runs', key: KEY(1) })
  const text = await drawn(short)
  expect(text).toContain('Flow1')
  expect(text).not.toContain('build')
  await short.unmount()
  const tall = await band('terminal', 24)
  expect(await drawn(tall)).toContain('build')
  await tall.unmount()
})

test('the rows keep their main parts and chevron on a narrow band', async ($, on) => {
  const { track, feed } = await boot($, on)
  await track()
  await feed(line([withSteps(1, 'one')]))
  const ui = await $.ui.mount({ plugin: 'gh-runs', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 40 }, viewport: { columns: 40, rows: 40 } })
  const text = await drawn(ui)
  expect(text).toContain('Flow1')
  expect(text).toContain('#17')
  expect(text).toContain('▸')
  expect(text).not.toContain('updated 40s')
  await ui.unmount()
})

test('a run keeps no expansion once it has left the band', async ($, on) => {
  const { track, feed, band } = await boot($, on)
  await track()
  await feed(line([withSteps(1, 'one'), withSteps(2, 'two')]))
  const ui = await band()
  await open2(ui, 1)
  await open2(ui, 2)
  await feed(line([run(1, 'completed', 'success'), withSteps(2, 'two')]))
  await feed(line([withSteps(1, 'one'), withSteps(2, 'two')]))
  const text = await drawn(ui)
  expect(text).not.toContain('one Checkout')
  expect(text).toContain('two Checkout')
  await ui.unmount()
})

test('/ci-track expand and collapse apply to every group, run and job', async ($, on) => {
  const { track, feed, band } = await boot($, on)
  expect(JSON.stringify(await $.command.run({ command: 'ci-track', args: 'expand' } as any))).toContain('No active runs')
  await track()
  await feed(line([withSteps(1, 'one'), withSteps(2, 'two')]))
  const ui = await band()
  expect(JSON.stringify(await $.command.run({ command: 'ci-track', args: 'expand' } as any))).toContain('Expanded 1 group and 2 active runs.')
  let text = await drawn(ui)
  expect(text).toContain('one Checkout')
  expect(text).toContain('two Checkout')
  expect(JSON.stringify(await $.command.run({ command: 'ci-track', args: 'collapse' } as any))).toContain('Collapsed 1 group and 2 active runs.')
  text = await drawn(ui)
  expect(text).toContain(R)
  expect(text).not.toContain('Flow1')
  expect(JSON.stringify(await $.command.run({ command: 'ci-track', args: 'nonsense' } as any))).toContain('expand | collapse')
  await ui.unmount()
})

test('the cap keeps the running step in view on the band', async ($, on) => {
  const { track, feed, band } = await boot($, on)
  await track()
  const steps: [string, string, string | null][] = Array.from({ length: 30 }, (_, i) => [`S${i + 1}x`, i < 20 ? 'completed' : i === 20 ? 'in_progress' : 'queued', i < 20 ? 'success' : null])
  await feed(line([run(1, 'in_progress', null, { jobs: [stepJob('big', steps)] })]))
  const ui = await band()
  await $.command.run({ command: 'ci-track', args: 'expand' } as any)
  const text = await drawn(ui)
  expect(text).toContain('21 S21x')
  expect(text).toContain('+18 more')
  expect(text).not.toContain('1 S1x')
  await ui.unmount()
})

test('the job row counts only completed steps in its progress', async ($, on) => {
  const { track, feed, band } = await boot($, on)
  await track()
  const steps = Array.from({ length: 6 }, (_, i) => ({ name: `S${i + 1}`, number: i + 1, status: i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'queued', conclusion: i < 2 ? 'success' : '' }))
  await feed(line([run(9, 'in_progress', null, { jobs: [{ name: 'build', status: 'in_progress', conclusion: null, steps }] })]))
  await $.command.run({ command: 'ci-track', args: 'expand' } as any)
  const ui = await band()
  const out = await drawn(ui)
  expect(out).toContain('step 3/6')
  expect(out).toContain('"███"')
  expect(out).not.toContain('6/6')
  await ui.unmount()
})

test('a run or job without a chevron gets a two-cell blank so names line up', async ($, on) => {
  const { track, feed, band } = await boot($, on)
  await track()
  await feed(line([run(1, 'queued', null, { jobs: [], workflowName: '', displayTitle: 'Queued thing' }), run(2, 'in_progress', null, { jobs: [{ name: 'lint', status: 'in_progress', conclusion: null, steps: [] }] })]))
  await $.command.run({ command: 'ci-track', args: 'expand' } as any)
  const ui = await band()
  const out = await drawn(ui)
  expect(out).toContain('Queued thing')
  expect(out).not.toContain('run 1')
  expect(out.split('{"type":"Text","children":["  "]}').length - 1).toBeGreaterThanOrEqual(3)
  await ui.unmount()
})
