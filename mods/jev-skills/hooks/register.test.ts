import { expect, mock, test } from 'claude-code/testing'

const KEY = 'k-secret-123'
const MESSAGE = { role: 'user', text: 'summary', toolUses: [] }
const SKILLS: [string, string][] = [
  ['review', 'Review a pull request for bugs, style and tests'],
  ['deploy', 'Deploy the application to production'],
  ['pdf', 'Read and fill in PDF forms'],
  ['plugin-a:charts', 'Draw charts from tabular data'],
  ['notes', ''],
]
const LISTING = ['The following skills are available for use with the Skill tool:', '', ...SKILLS.map(([n, d]) => (d ? `- ${n}: ${d}` : `- ${n}`))].join('\n')

type Setup = {
  env?: Record<string, string>
  files?: Record<string, string>
  // Jev's probability by skill name; others 0
  p?: Record<string, number>
  status?: number
  hang?: boolean
}

async function boot($: any, on: any, setup: Setup = {}) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = []
  const logs: string[] = []
  mock.env(on, setup.env ?? { JEV_COMPACTION_API_KEY: KEY, HOME: '/home/u' })
  on('fs.read', (_$: any, e: any) => {
    const text = (setup.files ?? {})[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  const clock = mock.clock(on)
  on('http.fetch', (_$: any, e: any) => {
    if (setup.hang) return new Promise(() => undefined) as never
    const body = JSON.parse(e.init.body)
    requests.push({ url: e.url, headers: e.init.headers, body })
    const answers = Object.fromEntries(
      Object.entries(body.questions as Record<string, { instructions: string }>).map(([id, q]) => {
        const name = /skill "([^"]+)"/.exec(q.instructions)![1]!
        return [id, { noul: setup.p?.[name] ?? 0 }]
      }),
    )
    const status = setup.status ?? 200
    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify({ answers }) } }
  })
  on('prompt.attachment', (_$: any, e: any) => ({ text: e.text }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text, context: e.context }))
  on('session.compact', () => ({ messages: [MESSAGE] }))
  on('skill.prompt', (_$: any, e: any) => ({ text: e.text }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('command.register', () => ({ value: undefined as never }))
  on('ui.log', (_$: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/work' }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
  return { requests, logs, clock, setup, scores: (setup.p ??= {}) }
}

const submit = ($: any, text: string, origin: any = { kind: 'composer' }) => $.prompt.submit({ text, origin, wait: false } as never) as Promise<{ text: string; context?: string[] }>
const listing = ($: any, extra: Record<string, unknown> = {}, text = LISTING) => $.prompt.attachment({ type: 'skill_listing', text, origin: { kind: 'engine' }, ...extra } as never) as Promise<{ text: string | null }>
const command = ($: any, args: string) => $.command.run({ command: 'jev-skills', args } as never) as Promise<{ text: string }>
const settle = async (clock: { advance: (ms: number) => Promise<void> }, done: () => boolean) => {
  for (let i = 0; i < 40 && !done(); i++) await clock.advance(100)
}

test('the listing becomes a shortlist of the best skills, with the other-skills line, in one Jev request', async ($, on) => {
  const { requests } = await boot($, on, { p: { review: 0.9, deploy: 0.31, pdf: 0.29 } })
  await submit($, 'Please review the pull request for the billing module')
  const { text } = await listing($)
  expect(text).toContain('- review: Review a pull request for bugs, style and tests')
  expect(text).toContain('- deploy:')
  expect(text).not.toMatch(/^- (pdf|plugin-a:charts)/m)
  expect(text).toMatch(/Other installed skills are not listed here[^\n]*exact name/)
  expect(requests.length).toBe(1)
  expect(requests[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(requests[0]!.headers['authorization']).toBe(`Bearer ${KEY}`)
  expect(requests[0]!.body.model).toBe('jev-latest')
  expect(requests[0]!.body.state.user_request).toBe('Please review the pull request for the billing module')
  expect(Object.keys(requests[0]!.body.questions).length).toBe(SKILLS.length)
  expect(Object.values(requests[0]!.body.questions)[0]).toMatchObject({ type: 'noul' })
})

test('at most maxPicks skills are listed', { options: { maxPicks: 2 } }, async ($, on) => {
  await boot($, on, { p: { review: 0.9, deploy: 0.8, pdf: 0.7 } })
  await submit($, 'Please review and deploy and fill in the form')
  const { text } = await listing($)
  expect(text!.match(/^- /gm)?.length).toBe(2)
})

test('no key leaves the built-in listing untouched and is reported', async ($, on) => {
  const prompt = 'Please review the pull request for the billing module'
  const h = await boot($, on, { env: { HOME: '/home/u' } })
  await submit($, prompt)
  expect((await listing($)).text).toBe(LISTING)
  expect(h.requests).toEqual([])
  expect((await command($, 'stats')).text).toMatch(/failures: 1/)
  expect((await command($, 'why')).text).toMatch(/Failed: no Jev API key/)
})

test('a Jev error leaves the listing alone and the key out of the messages', async ($, on) => {
  const { logs } = await boot($, on, { status: 500 })
  await submit($, 'Please review the pull request for the billing module')
  expect((await listing($)).text).toBe(LISTING)
  expect(logs.join('\n')).toMatch(/Jev request failed \(500\)/)
  expect(logs.join('\n')).not.toContain(KEY)
})

test('a Jev request that never answers times out and leaves the listing alone', { options: { jevTimeoutMs: 50 } }, async ($, on) => {
  const { clock, logs } = await boot($, on, { hang: true })
  await submit($, 'Please review the pull request for the billing module')
  let result: { text: string | null } | undefined
  const pending = listing($).then((r) => (result = r))
  await settle(clock, () => result !== undefined)
  await pending
  expect(result!.text).toBe(LISTING)
  expect(logs.join('\n')).toMatch(/timed out after 50 ms/)
})

test('a subagent, a trivial first prompt, and no prompt yet leave the listing alone without a request', async ($, on) => {
  const { requests } = await boot($, on, { p: { review: 0.9 } })
  expect((await listing($)).text).toBe(LISTING)
  expect((await listing($, { agentId: 'sub-1' })).text).toBe(LISTING)
  await submit($, 'ok')
  expect((await listing($)).text).toBe(LISTING)
  await submit($, '/jev-skills why')
  expect((await listing($)).text).toBe(LISTING)
  expect(requests).toEqual([])
})

test('the key file is read lazily, TYPESAFE_API_KEY is the fallback', async ($, on) => {
  const { requests } = await boot($, on, {
    env: { HOME: '/home/u' },
    files: { '/home/u/.config/ai-tools/jev-compaction.env': 'JEV_COMPACTION_API_KEY=\nTYPESAFE_API_KEY=file-key\n' },
    p: { review: 0.9 },
  })
  await submit($, 'Please review the pull request for the billing module')
  await listing($)
  expect(requests[0]!.headers['authorization']).toBe('Bearer file-key')
})

test('disabled by the option: nothing is changed and Jev is not called', { options: { enabled: false } }, async ($, on) => {
  const { requests } = await boot($, on, { p: { review: 0.9 } })
  await submit($, 'Please review the pull request for the billing module')
  expect((await listing($)).text).toBe(LISTING)
  expect(requests).toEqual([])
})

test('/jev-skills off and on switch later prompts; usage and status are shown', async ($, on) => {
  const { requests, scores } = await boot($, on, { p: { review: 0.9 } })
  expect((await command($, '')).text).toMatch(/^on\nUsage/)
  await submit($, 'Please review the pull request for the billing module')
  await listing($)
  scores['deploy'] = 0.9
  await command($, 'off')
  expect((await command($, '')).text).toMatch(/^off/)
  const before = requests.length
  expect((await submit($, 'Now deploy the application to production')).context ?? []).toEqual([])
  expect(requests.length).toBe(before)
  await command($, 'on')
  expect((await submit($, 'Now deploy the application to production')).context?.[0]).toContain('- deploy:')
})

test('later prompts add only skills the model has not been shown, and never repeat one', async ($, on) => {
  const { requests, scores } = await boot($, on, { p: { review: 0.9 } })
  await submit($, 'Please review the pull request for the billing module')
  await listing($)
  scores['pdf'] = 0.7
  const second = await submit($, 'Also fill in the PDF form for the audit please')
  expect(second.context!.length).toBe(1)
  expect(second.context![0]).toContain('- pdf:')
  expect(second.context![0]).not.toContain('- review')
  const asked = Object.values(requests[1]!.body.questions as Record<string, { instructions: string }>).map((q) => q.instructions)
  expect(asked.some((i) => i.includes('skill "review"'))).toBe(false)
  expect(requests[1]!.body.state.earlier_user_requests).toEqual(['Please review the pull request for the billing module'])
  const third = await submit($, 'And check the PDF form fields once more please')
  expect(third.context ?? []).toEqual([])
})

test('no addition before the listing was replaced, for slash commands or for acknowledgements', async ($, on) => {
  const { requests } = await boot($, on, { p: { review: 0.9, pdf: 0.9 } })
  expect((await submit($, 'Please review the pull request for the billing module')).context ?? []).toEqual([])
  await listing($)
  const before = requests.length
  for (const t of ['/jev-skills stats', 'continue', 'ok thanks']) expect((await submit($, t)).context ?? []).toEqual([])
  expect((await submit($, 'Fill in the PDF form for the audit please', { kind: 'task-notification' })).context ?? []).toEqual([])
  expect(requests.length).toBe(before)
})

test('a compaction resets what the model is known to have seen, so a skill can be added again', async ($, on) => {
  const { scores } = await boot($, on, { p: { review: 0.9 } })
  await submit($, 'Please review the pull request for the billing module')
  await listing($)
  scores['pdf'] = 0.9
  expect((await submit($, 'Fill in the PDF form for the audit please')).context?.length).toBe(1)
  expect((await submit($, 'Fill in the PDF form for the audit please')).context ?? []).toEqual([])
  await $.session.compact({ trigger: 'manual', messages: [MESSAGE] } as never)
  expect((await submit($, 'Fill in the PDF form for the audit please')).context?.length).toBe(1)
})

test('a delta listing with new skills goes through unchanged, is shown, and joins the roster', async ($, on) => {
  await boot($, on, { p: { review: 0.9, extra: 0.9 } })
  await submit($, 'Please review the pull request for the billing module')
  await listing($)
  const delta = '- extra: A skill added later'
  expect((await listing($, {}, delta)).text).toBe(delta)
  expect((await command($, 'why')).text).toMatch(/of 6 skills/)
  expect((await submit($, 'Do the extra thing with the later skill please')).context ?? []).toEqual([])
})

test('a later partial listing never shrinks the roster or ends the shortlisting', async ($, on) => {
  const { scores } = await boot($, on, { p: { review: 0.9 } })
  await submit($, 'Please review the pull request for the billing module')
  await listing($)
  const partial = '- review: Review a pull request for bugs, style and tests\n- pdf: Read and fill in PDF forms'
  expect((await listing($, {}, partial)).text).toBe(partial)
  expect((await command($, 'why')).text).toMatch(/of 5 skills/)
  scores['deploy'] = 0.9
  expect((await submit($, 'Now deploy the application to production')).context?.[0]).toContain('- deploy:')
})

test('the shortlist names the hidden skills, names only', async ($, on) => {
  await boot($, on, { p: { review: 0.9 } })
  await submit($, 'Please review the pull request for the billing module')
  const { text } = await listing($)
  expect(text).toContain('Other skills (names only): deploy, pdf, plugin-a:charts, notes.')
  expect(text).not.toContain('Deploy the application')
})

test('two Jev failures in a row pause judging; later prompts use the shorter timeout', { options: { jevTimeoutMs: 500, promptTimeoutMs: 50 } }, async ($, on) => {
  const { clock, requests, setup, scores } = await boot($, on, { p: { review: 0.9 } })
  await submit($, 'Please review the pull request for the billing module')
  await listing($)
  setup.hang = true
  scores['pdf'] = 0.9
  const asked = () => requests.length
  const hung: string[] = []
  for (const text of ['Fill in the PDF form for the audit please', 'Fill in the PDF form for the audit again please']) {
    let done = false
    const pending = submit($, text).then(() => (done = true))
    await settle(clock, () => done)
    await pending
    hung.push(text)
  }
  expect((await command($, 'why')).text).toMatch(/timed out after 50 ms/)
  setup.hang = false
  const before = asked()
  expect((await submit($, 'Fill in the PDF form once more please')).context ?? []).toEqual([])
  expect(asked()).toBe(before)
  expect((await command($, 'stats')).text).toMatch(/failures: 2/)
})

test('/clear resets the shortlist state', async ($, on) => {
  await boot($, on, { p: { review: 0.9 } })
  await submit($, 'Please review the pull request for the billing module')
  await listing($)
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { kind: 'none' } } as never)
  expect((await command($, 'why')).text).toMatch(/of 0 skills/)
  expect((await submit($, 'Fill in the PDF form for the audit please')).context ?? []).toEqual([])
})

test('a first listing kept in full is never shortlisted later, even by a full re-send', async ($, on) => {
  const { requests } = await boot($, on, { p: { review: 0.9 } })
  await submit($, 'hi')
  expect((await listing($)).text).toBe(LISTING)
  await submit($, 'Please review the pull request for the billing module')
  expect((await listing($)).text).toBe(LISTING)
  expect((await listing($, {}, '- extra: later')).text).toBe('- extra: later')
  expect(requests).toEqual([])
})

test('the hidden-name index is ordered by Jev score, best first', async ($, on) => {
  await boot($, on, { p: { review: 0.9, notes: 0.2, pdf: 0.1, 'plugin-a:charts': 0.25, deploy: 0.05 } })
  await submit($, 'Please review the pull request for the billing module')
  expect((await listing($)).text).toContain('(names only): plugin-a:charts, notes, pdf, deploy.')
})

test('a full listing again (a compaction or resume) is shortlisted afresh', async ($, on) => {
  const { requests } = await boot($, on, { p: { review: 0.9, pdf: 0.9 } })
  await submit($, 'Please review the pull request for the billing module')
  await listing($)
  await submit($, 'Fill in the PDF form for the audit please')
  const again = await listing($)
  expect(again.text).toContain('- pdf:')
  expect(requests.length).toBe(3)
})

test('stats and why report the judgement, and skill use counts shortlisted skills', async ($, on) => {
  await boot($, on, { p: { review: 0.9, pdf: 0.4 } })
  expect((await command($, 'why')).text).toMatch(/nothing judged yet/)
  await submit($, 'Please review the pull request for the billing module')
  await listing($)
  await $.skill.prompt({ skill: 'review', text: 'x' } as never)
  await $.skill.prompt({ skill: 'charts', text: 'x' } as never)
  const why = (await command($, 'why')).text
  expect(why).toMatch(/session listing/)
  expect(why).toMatch(/Shortlisted: review, pdf/)
  expect(why).toMatch(/Best scores: review 0.9, pdf 0.4/)
  expect(why).toMatch(/Visible to the model: 2 of 5 skills/)
  const stats = (await command($, 'stats')).text
  expect(stats).toMatch(/Listings replaced: 1 \(~\d+ tokens became ~\d+\)/)
  expect(stats).toMatch(/Skills used: 2, of them shortlisted: 1/)
})
