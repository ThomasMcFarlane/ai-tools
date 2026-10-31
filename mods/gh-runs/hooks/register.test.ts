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
let frameWrites = 0

const boot = async ($: any, on: any, surface: 'terminal' | 'desktop' = 'terminal') => {
  statuses = []
  frameWrites = 0
  const clock = mock.clock(on, { now: Date.parse('2026-01-01T00:01:40Z') })
  const session = mock.session(on)
  const child = channel()
  const spawned: { argv: readonly string[] }[] = []
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined as never }))
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
  const band = (s: 'terminal' | 'desktop' = surface) =>
    $.ui.mount({ plugin: 'gh-runs', surface: s, component: 'AbovePrompt', props: BAND, requestId: `band-${Math.random()}` })
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
const notices = (session: any) => session.appended().filter((r: any) => r.message.type === 'system')

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

test('the band shows a running run on terminal and desktop', async ($, on) => {
  const { track, feed, band } = await boot($, on)
  await track()
  await feed(line([run(1, 'in_progress')]))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band(surface)
    const text = await drawn(ui)
    expect(text).toContain('Flow1')
    expect(text).toContain(`${R}#17`)
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

test('a run leaves the band when it ends while another stays, with one chat item', async ($, on) => {
  const { track, feed, band, session } = await boot($, on)
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
  expect(notices(session).length).toBe(1)
  const body = JSON.stringify(notices(session)[0].message.content)
  expect(body).toContain('[gh-runs] success')
  expect(body).toContain('Flow1')
  expect(body).toContain('https://example.com/octo-org/hello-world/actions/runs/1')
})

test('the target is dropped when the follower exits, and a run is announced once per attempt', async ($, on) => {
  const { track, feed, child, clock, session, band } = await boot($, on)
  await track()
  const failed = run(3, 'completed', 'failure', { jobs: [job('completed', 'failure')] })
  await feed(line([failed], { state: 'failure', isFinal: true }))
  child.end(1)
  await clock.settle()
  expect(JSON.stringify(await $.command.run({ command: 'ci-track', args: '' } as any))).toContain('Nothing is tracked')
  expect(notices(session).length).toBe(1)
  expect(JSON.stringify(notices(session)[0].message.content)).toContain('failed: build / Test')
  await track()
  await feed(line([failed, run(3, 'completed', 'success', { attempt: 2 })]))
  expect(notices(session).length).toBe(2)
  const ui = await band()
  expect(await drawn(ui)).not.toContain('Flow3')
  await ui.unmount()
})

test('a chat item is coloured by conclusion and other notices are left alone', async ($, on) => {
  await boot($, on)
  const cases: [string, string][] = [
    ['success', 'success'],
    ['failure', 'error'],
    ['cancelled', 'warning'],
    ['timed_out', 'warning'],
    ['skipped', 'inactive'],
    ['neutral', 'inactive'],
  ]
  for (const [conclusion, colour] of cases) {
    const text = `[gh-runs] ${conclusion}  CI  ${R}#17  1m 05s\nfailed: build / Test\nhttps://example.com/run/1`
    const ui = await $.ui.mount({ plugin: 'gh-runs', surface: 'terminal', component: 'InfoNotice', props: { text, command: null } })
    const out = await drawn(ui)
    expect(out).toContain(conclusion.toUpperCase())
    expect(out).toContain('https://example.com/run/1')
    expect(out).toContain(`"${colour === 'inactive' ? 'inactive' : colour}"`)
    await ui.unmount()
  }
  const other = await $.ui.mount({ plugin: 'gh-runs', surface: 'terminal', component: 'InfoNotice', props: { text: 'Model: example', command: null } })
  expect(await drawn(other)).toContain('engine')
  await other.unmount()
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
  expect(notices(session).length).toBe(0)
})
