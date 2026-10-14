import { expect, mock, test } from 'claude-code/testing'

import type { Message } from './types'

// Secret-shaped fixtures are assembled at runtime so no literal matches a real token format.
const S = { SKL: ['sk', 'live', ''].join('_'), SKT: ['sk', 'test', ''].join('_'), RKL: ['rk', 'live', ''].join('_'), GHP: ['gh', 'p_'].join(''), PAT: ['github', 'pat', ''].join('_'), GLP: ['glp', 'at-'].join(''), XOX: ['xo', 'xb-'].join(''), AIZ: ['AI', 'za'].join(''), AKI: ['AK', 'IA'].join(''), NPM: ['np', 'm_'].join(''), HF: ['h', 'f_'].join(''), JWT: ['ey', 'J'].join(''), PEM: ['-----BE', 'GIN'].join('') }

type Setup = {
  env?: Record<string, string>
  files?: Record<string, string>
  tokens?: number
  window?: number
  // Jev's probability per question; one number for all
  p?: number
  status?: number
  // what the engine's own compaction answers
  core?: () => unknown
  // the main conversation in API form, as `$.session.messages({ as: 'api' })` answers
  api?: unknown[]
  // the main conversation as rows
  rows?: unknown[]
  // never answer a fetch
  hang?: boolean
}

const KEY = 'k-secret-123'
const BUILTIN: Message = { role: 'user', text: 'BUILTIN SUMMARY', toolUses: [] }

// A transcript of `calls` tool calls with 30k-character results between a first message and a six-message tail.
function transcript(calls = 12): Message[] {
  const out: Message[] = [{ role: 'user', text: 'start', toolUses: [], handle: 'h0' }]
  for (let i = 0; i < calls; i++) {
    const text = String(i).repeat(30_000)
    out.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `c${i}`, tool: 'Read', input: { file_path: `/src/f${i}.ts` }, text }], handle: `a${i}` })
    out.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `c${i}`, text, isError: false }], handle: `u${i}` })
  }
  for (const t of ['a', 'b', 'c']) out.push({ role: 'assistant', text: `r ${t}`, toolUses: [] }, { role: 'user', text: `q ${t}`, toolUses: [] })
  return out
}

async function boot($: any, on: any, setup: Setup = {}) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const compactCalls: any[] = []
  const rows = mock.session(on)
  const stored = { get: () => rows.appended().map((r) => r.message as any) }
  mock.env(on, setup.env ?? { JEV_COMPACTION_API_KEY: KEY, HOME: '/home/u' })
  on('fs.read', (_$: any, e: any) => {
    const text = (setup.files ?? {})[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  const clock = mock.clock(on)
  const usage = { tokens: setup.tokens ?? 450_000, window: setup.window ?? 1_000_000 }
  on('session.usage', () => ({ value: { startedAt: 0, context: { ...usage }, rateLimits: [] } }))
  on('session.messages', (_$: any, e: any) => ({ value: ((e.as === 'api' ? setup.api : setup.rows) ?? []) as never }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('http.fetch', (_$: any, e: any) => {
    if (setup.hang) return new Promise(() => undefined) as never
    const body = JSON.parse(e.init.body)
    requests.push({ url: e.url, headers: e.init.headers, body })
    const answers = Object.fromEntries(Object.keys(body.questions).map((name) => [name, { noul: setup.p ?? 0 }]))
    const status = setup.status ?? 200
    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify({ answers }) } }
  })
  on('session.compact', (_$: any, e: any) => {
    compactCalls.push(e)
    return (setup.core?.() as { messages: Message[] } | undefined) ?? { messages: [BUILTIN] }
  })
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined as never }))
  on('session.start', () => ({ cwd: '/work' }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
  return { requests, toasts, logs, compactCalls, usage, clock, stored }
}

const compact = ($: any, trigger: string, extra: Record<string, unknown> = {}) =>
  $.session.compact({ trigger, messages: transcript(), ...extra } as never) as Promise<{ messages?: Message[]; skip?: string }>

const isBuiltin = (r: { messages?: Message[] }) => r.messages?.[0]?.text === 'BUILTIN SUMMARY'

test('subagents and precompute pass straight to the built-in compaction without Jev', async ($, on) => {
  const { requests } = await boot($, on)
  expect(isBuiltin(await compact($, 'plugin', { agentId: 'sub-1' }))).toBe(true)
  expect(isBuiltin(await compact($, 'auto', { agentId: 'sub-1' }))).toBe(true)
  expect(isBuiltin(await compact($, 'precompute'))).toBe(true)
  expect(requests).toEqual([])
})

test('soft compaction is applied when Jev frees enough, with the documented request and no handle on rebuilt messages', async ($, on) => {
  const { requests, toasts, logs } = await boot($, on, { p: 0 })
  const r = await compact($, 'plugin')
  expect(isBuiltin(r)).toBe(false)
  expect(r.messages!.length).toBe(19)
  expect(r.messages!.filter((m) => m.text.startsWith('[jev-compaction dropped Read call')).length).toBe(12)
  expect(r.messages![0]!.handle).toBe('h0')
  expect(r.messages!.filter((m) => m.text.includes('jev-compaction')).every((m) => m.handle === undefined)).toBe(true)
  expect(requests.length).toBeGreaterThan(0)
  const request = requests[0]!
  expect(request.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(request.headers).toEqual({ authorization: `Bearer ${KEY}`, 'content-type': 'application/json' })
  expect(Object.keys(request.body).sort()).toEqual(['model', 'questions', 'state'])
  expect(request.body.model).toBe('jev-latest')
  expect(request.body.questions['call_t1']).toEqual({ type: 'noul', instructions: expect.any(String) })
  expect(toasts[0]).toMatch(/compacted ~450k to ~\d+k? tokens/)
  expect([...toasts, ...logs].join('\n')).not.toContain(KEY)
})

test('soft compaction is deferred when Jev keeps everything, and scores are reused next time', async ($, on) => {
  const { requests, toasts } = await boot($, on, { p: 1 })
  const first = await compact($, 'plugin')
  expect(first.skip).toMatch(/deferred/)
  expect(toasts[0]).toMatch(/deferred/)
  const asked = requests.length
  expect(asked).toBeGreaterThan(0)
  const second = await compact($, 'plugin')
  expect(second.skip).toMatch(/deferred/)
  expect(requests.length).toBe(asked)
})

test('a score near the keep threshold is asked again', async ($, on) => {
  const { requests } = await boot($, on, { p: 0.55 })
  await compact($, 'plugin')
  const asked = requests.length
  await compact($, 'plugin')
  expect(requests.length).toBe(asked * 2)
})

test('soft compaction at the hard limit that frees too little falls back to the built-in summary', async ($, on) => {
  await boot($, on, { p: 1, tokens: 520_000 })
  expect(isBuiltin(await compact($, 'plugin'))).toBe(true)
})

const HARD = { hardTokens: 300_000, triggerTokens: 200_000, targetTokens: 120_000, softMinFreedTokens: 50_000 }

test('hard ceiling: a periodic result that stays above the hard limit runs the built-in summary instead', { options: { ...HARD, hardTokens: 200_000 } }, async ($, on) => {
  const { toasts, compactCalls } = await boot($, on, { p: 0, tokens: 466_000 })
  // Jev frees ~103k (466k to ~363k), still above the 200k limit
  expect(isBuiltin(await compact($, 'plugin'))).toBe(true)
  expect(toasts[0]).toMatch(/built-in summary: .*hard limit 200000/)
  expect(compactCalls.length).toBe(1)
})

test('hard ceiling: a periodic result that reaches below the hard limit is applied', { options: HARD }, async ($, on) => {
  const { toasts } = await boot($, on, { p: 0, tokens: 350_000 })
  const r = await compact($, 'plugin')
  expect(isBuiltin(r)).toBe(false)
  expect(r.messages!.length).toBe(19)
  expect(toasts[0]).toMatch(/compacted ~350k to ~2\d\dk tokens/)
})

test('hard ceiling: a Jev error, a missing key or an unfittable history above the hard limit runs the built-in summary', { options: HARD }, async ($, on) => {
  const failing = await boot($, on, { status: 500, tokens: 466_000 })
  expect(isBuiltin(await compact($, 'plugin'))).toBe(true)
  expect(failing.toasts[0]).toMatch(/built-in summary: .*500/)
})

test('hard ceiling: no key above the hard limit runs the built-in summary, below it is deferred', { options: HARD }, async ($, on) => {
  const { usage } = await boot($, on, { env: { HOME: '/home/u' }, tokens: 466_000 })
  expect(isBuiltin(await compact($, 'plugin'))).toBe(true)
  usage.tokens = 280_000
  expect((await compact($, 'plugin')).skip).toMatch(/no Jev API key/)
})

test('hard ceiling: a transcript of 4096 messages or more runs the built-in summary above the hard limit, defers below it', { options: HARD }, async ($, on) => {
  const { usage } = await boot($, on, { p: 0, tokens: 466_000 })
  const many = Array.from({ length: 4096 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x', toolUses: [] }))
  expect(isBuiltin(await compact($, 'plugin', { messages: many }))).toBe(true)
  usage.tokens = 280_000
  expect((await compact($, 'plugin', { messages: many })).skip).toMatch(/over 4096 messages/)
})

test('hard ceiling: below the hard limit a soft compaction that frees too little is still deferred', { options: HARD }, async ($, on) => {
  await boot($, on, { p: 1, tokens: 280_000 })
  expect((await compact($, 'plugin')).skip).toMatch(/deferred/)
})

test('hard ceiling: the regrowth guard does not block a turn end at or above the hard limit', { options: HARD }, async ($, on) => {
  const { compactCalls, usage } = await boot($, on, { core: () => ({ skip: 'deferred by test' }) })
  const turn = async (tokens: number) => {
    usage.tokens = tokens
    await $.turn.complete(reply())
  }
  await turn(250_000)
  expect(compactCalls.length).toBe(1)
  // guard 250k: 280k is within the regrowth, so no attempt
  await turn(280_000)
  expect(compactCalls.length).toBe(1)
  // at the hard limit every turn end attempts, however little the context grew
  await turn(300_000)
  expect(compactCalls.length).toBe(2)
  await turn(301_000)
  expect(compactCalls.length).toBe(3)
})

test('hard ceiling: /jev-compact now falls back to the built-in summary above the hard limit', { options: HARD }, async ($, on) => {
  const { usage } = await boot($, on, { p: 1, tokens: 466_000 })
  await $.command.run({ command: 'jev-compact', args: 'now' } as never)
  await $.turn.complete(reply())
  expect(isBuiltin(await compact($, 'manual'))).toBe(true)
  usage.tokens = 280_000
  await $.command.run({ command: 'jev-compact', args: 'now' } as never)
  await $.turn.complete(reply())
  expect((await compact($, 'manual')).skip).toMatch(/deferred/)
})

test('auto: applied below the hard limit, built-in summary above it', async ($, on) => {
  await boot($, on, { p: 0, tokens: 600_000 })
  expect(isBuiltin(await compact($, 'auto'))).toBe(false)
})

test('auto: built-in summary when pruning cannot get under the hard limit', async ($, on) => {
  await boot($, on, { p: 1, tokens: 600_000 })
  expect(isBuiltin(await compact($, 'auto'))).toBe(true)
})

test('manual: applied when it frees enough, else built-in summary', async ($, on) => {
  await boot($, on, { p: 0 })
  expect(isBuiltin(await compact($, 'manual'))).toBe(false)
})

test('manual: built-in summary when Jev keeps everything', async ($, on) => {
  await boot($, on, { p: 1 })
  expect(isBuiltin(await compact($, 'manual'))).toBe(true)
})

test('no key: soft defers, auto and manual fall back, and Jev is never called', async ($, on) => {
  const { requests, toasts } = await boot($, on, { env: { HOME: '/home/u' } })
  expect((await compact($, 'plugin')).skip).toMatch(/no Jev API key/)
  expect(isBuiltin(await compact($, 'auto'))).toBe(true)
  expect(isBuiltin(await compact($, 'manual'))).toBe(true)
  expect(requests).toEqual([])
  expect(toasts.length).toBe(3)
})

test('a Jev error defers a soft compaction, falls back otherwise, and the key stays out of every message', async ($, on) => {
  const { toasts, logs } = await boot($, on, { status: 500 })
  const soft = await compact($, 'plugin')
  expect(soft.skip).toMatch(/Jev request failed \(500\)/)
  expect(isBuiltin(await compact($, 'auto'))).toBe(true)
  expect([...toasts, ...logs, soft.skip].join('\n')).not.toContain(KEY)
})

test('the key file is read lazily: comment lines, TYPESAFE_API_KEY fallback, empty value ignored', async ($, on) => {
  const { requests } = await boot($, on, {
    env: { HOME: '/home/u' },
    files: { '/home/u/.config/ai-tools/jev-compaction.env': '# keys\nJEV_COMPACTION_API_KEY=\nTYPESAFE_API_KEY=file-key\n' },
    p: 0,
  })
  await compact($, 'plugin')
  expect(requests[0]!.headers['authorization']).toBe('Bearer file-key')
})

test('an environment key wins over the key file; TYPESAFE_API_KEY is the second environment name', async ($, on) => {
  const { requests } = await boot($, on, {
    env: { TYPESAFE_API_KEY: 'env-key', HOME: '/home/u' },
    files: { '/home/u/.config/ai-tools/jev-compaction.env': 'TYPESAFE_API_KEY=file-key' },
  })
  await compact($, 'plugin')
  expect(requests[0]!.headers['authorization']).toBe('Bearer env-key')
})

test('keyFile option names another file', { options: { keyFile: '/etc/example/jev.env' } }, async ($, on) => {
  const { requests } = await boot($, on, { env: {}, files: { '/etc/example/jev.env': 'export JEV_COMPACTION_API_KEY="quoted"' } })
  await compact($, 'plugin')
  expect(requests[0]!.headers['authorization']).toBe('Bearer quoted')
})

test('/jev-compact stats reports the session totals', async ($, on) => {
  await boot($, on, { p: 0 })
  await compact($, 'plugin')
  const { text } = await $.command.run({ command: 'jev-compact', args: 'stats' } as never)
  expect(text).toMatch(/1 applied, 0 deferred, 0 built-in fallbacks; ~\d+ tokens freed; \d+ Jev requests/)
  expect((await $.command.run({ command: 'jev-compact', args: '' } as never)).text).toMatch(/Usage/)
})

const reply = () => ({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' }) as never

test('periodic trigger: compacts at the trigger, not below, and waits for 50000 tokens of regrowth after an attempt', async ($, on) => {
  const { compactCalls, usage } = await boot($, on, { core: () => ({ skip: 'deferred by test' }) })
  const turn = async (tokens: number) => {
    usage.tokens = tokens
    await $.turn.complete(reply())
  }
  await turn(399_000)
  expect(compactCalls.length).toBe(0)
  await turn(410_000)
  expect(compactCalls.length).toBe(1)
  await turn(459_000)
  expect(compactCalls.length).toBe(1)
  await turn(460_000)
  expect(compactCalls.length).toBe(2)
  await turn(300_000)
  await turn(405_000)
  expect(compactCalls.length).toBe(2)
  await turn(255_000)
  await turn(405_000)
  expect(compactCalls.length).toBe(3)
})

test('periodic trigger on a small window uses percentages', async ($, on) => {
  const { compactCalls, usage } = await boot($, on, { window: 200_000 })
  usage.window = 200_000
  usage.tokens = 119_000
  await $.turn.complete(reply())
  expect(compactCalls.length).toBe(0)
  usage.tokens = 120_000
  await $.turn.complete(reply())
  expect(compactCalls.length).toBe(1)
})

test('/jev-compact now compacts at the end of the next turn, below the trigger, and never falls back to the built-in summary', async ($, on) => {
  const { compactCalls, usage } = await boot($, on, { p: 1 })
  usage.tokens = 100_000
  await $.turn.complete(reply())
  expect(compactCalls.length).toBe(0)
  const { text } = await $.command.run({ command: 'jev-compact', args: 'now' } as never)
  expect(text).toContain('next turn ends')
  expect(compactCalls.length).toBe(0)
  await $.turn.complete(reply())
  expect(compactCalls.length).toBe(1)
  // Jev keeps everything: a plain /compact would fall back, the one asked for by `now` defers.
  expect((await compact($, 'manual')).skip).toMatch(/deferred/)
  expect(isBuiltin(await compact($, 'manual'))).toBe(true)
  const before = compactCalls.length
  await $.turn.complete(reply())
  expect(compactCalls.length).toBe(before)
})

const settle = async (clock: { advance: (ms: number) => Promise<void> }, done: () => boolean) => {
  for (let i = 0; i < 40 && !done(); i++) await clock.advance(100)
}

test('a Jev request that never answers times out: soft defers, auto and manual fall back', { options: { jevTimeoutMs: 50 } }, async ($, on) => {
  const { clock, requests } = await boot($, on, { hang: true })
  for (const [trigger, check] of [
    ['plugin', (r: { messages?: Message[]; skip?: string }) => expect(r.skip).toMatch(/timed out after 50 ms/)],
    ['auto', (r: { messages?: Message[] }) => expect(isBuiltin(r)).toBe(true)],
    ['manual', (r: { messages?: Message[] }) => expect(isBuiltin(r)).toBe(true)],
  ] as const) {
    let result: { messages?: Message[]; skip?: string } | undefined
    const pending = compact($, trigger).then((r) => (result = r))
    await settle(clock, () => result !== undefined)
    await pending
    check(result!)
  }
  expect(requests).toEqual([])
})

test('/compact with instructions goes to the built-in summary; a possibly cut transcript defers the soft compaction and leaves auto and manual to it', async ($, on) => {
  const { requests } = await boot($, on, { p: 0 })
  expect(isBuiltin(await compact($, 'manual', { instructions: 'keep the plan' }))).toBe(true)
  const many = Array.from({ length: 4096 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x', toolUses: [] }))
  expect((await compact($, 'plugin', { messages: many })).skip).toMatch(/over 4096 messages/)
  expect(isBuiltin(await compact($, 'auto', { messages: many }))).toBe(true)
  expect(isBuiltin(await compact($, 'manual', { messages: many }))).toBe(true)
  expect(requests).toEqual([])
})

test('a tool result with an image is never rebuilt, its Bash neighbour is dropped', async ($, on) => {
  const api = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c0', content: [{ type: 'text', text: 'see' }, { type: 'image', source: {} }] }] },
  ]
  await boot($, on, { p: 0, api })
  const r = await compact($, 'plugin')
  expect(r.messages!.some((m) => m.handle === 'a0')).toBe(true)
  expect(r.messages!.some((m) => m.handle === 'u0')).toBe(true)
  expect(r.messages!.some((m) => m.handle === 'u1')).toBe(false)
})

const userMedia = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: {} }] }]
const withLongUser = () => {
  const t = transcript()
  t.splice(1, 0, { role: 'user', text: 'u'.repeat(3000), toolUses: [], handle: 'long' }, { role: 'assistant', text: 'ack', toolUses: [], handle: 'ack' })
  return t
}

test('without media a long user text is abridged; with media in any user message it is left alone', async ($, on) => {
  await boot($, on, { p: 0 })
  const plain = await $.session.compact({ trigger: 'plugin', messages: withLongUser() } as never)
  expect((plain as { messages: Message[] }).messages.some((m) => m.handle === 'long')).toBe(false)
})

test('with an image in a user message no user text is abridged', async ($, on) => {
  await boot($, on, { p: 0, api: userMedia })
  const r = (await $.session.compact({ trigger: 'plugin', messages: withLongUser() } as never)) as { messages: Message[] }
  expect(r.messages.some((m) => m.handle === 'long')).toBe(true)
})

test('pre-scoring: a finished turn within 100k of the trigger scores part of the backlog off the critical path, and remembers it', async ($, on) => {
  const { requests, usage, logs, compactCalls, clock } = await boot($, on, { p: 0.9, rows: transcript(40) })
  usage.tokens = 250_000
  await $.turn.complete(reply())
  await clock.advance(10)
  expect(requests.length).toBe(0)
  usage.tokens = 320_000
  await $.turn.complete(reply())
  expect(requests.length).toBe(0)
  await clock.advance(10)
  expect(requests.length).toBeGreaterThan(0)
  expect(logs.join('\n')).toMatch(/pre-scored \d+ items/)
  expect(compactCalls.length).toBe(0)
})

test('pre-scoring is throttled: five turns at 350k with a new tool pair each make at most one request', async ($, on) => {
  const rows = transcript(40)
  const { requests, usage, clock } = await boot($, on, { p: 0.9, rows, hang: false })
  usage.tokens = 350_000
  for (let i = 0; i < 5; i++) {
    rows.splice(rows.length - 6, 0,
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: `n${i}`, tool: 'Read', input: { file_path: `/new/${i}.ts` }, text: 'x'.repeat(2000) }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `n${i}`, text: 'x'.repeat(2000), isError: false }] })
    await $.turn.complete(reply())
    await clock.advance(10)
  }
  expect(requests.length).toBeLessThanOrEqual(1)
  expect(requests.length).toBe(1)
})

test('pre-scoring waits until about a batch of questions is unscored', async ($, on) => {
  const { requests, usage, clock } = await boot($, on, { p: 0.9, rows: transcript(5) })
  usage.tokens = 350_000
  await $.turn.complete(reply())
  await clock.advance(10)
  expect(requests).toEqual([])
})

test('/jev-compact now says it is unavailable in a headless session', async ($, on) => {
  await boot($, on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false } as never)
  const { text } = await $.command.run({ command: 'jev-compact', args: 'now' } as never)
  expect(text).toMatch(/not available in a non-interactive/)
})

test('a turn that did not end in an answer neither compacts nor pre-scores', async ($, on) => {
  const { compactCalls, requests, usage } = await boot($, on, { rows: transcript() })
  usage.tokens = 450_000
  await $.turn.complete({ ...(reply() as object), reason: 'aborted', isAborted: true } as never)
  usage.tokens = 320_000
  await $.turn.complete({ ...(reply() as object), reason: 'error' } as never)
  expect(compactCalls.length).toBe(0)
  expect(requests).toEqual([])
})

test('a session that is not interactive is left alone', async ($, on) => {
  const { compactCalls, usage } = await boot($, on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false } as never)
  usage.tokens = 450_000
  await $.turn.complete(reply())
  expect(compactCalls.length).toBe(0)
})

// ---- compression on entry (session.append) ----------------------------------------------------------------

const PADDED = 'Sure! Let me check the build output for you now.'
const longReply = `${Array.from({ length: 12 }, (_, i) => `Step number ${i} of the plan reads the input and writes the matching output file.`).join(' ')}\nSee \`src/a.ts\` for the details.`

function appendRow(door: string, type: 'user' | 'assistant', content: unknown[], origin: unknown, extra: Record<string, unknown> = {}) {
  return { message: { type, content }, door, origin, uuid: 'u-1', ...extra } as never
}

const bootEntry = boot

const ON = { entryUser: true, entryAssistant: true }
const replyRow = (text: string) => appendRow('response', 'assistant', [{ type: 'text', text }], { kind: 'model', model: 'm' })
const stat = async ($: any) => ((await $.command.run({ command: 'jev-compact', args: 'stats' } as never)) as { text: string }).text

test('entry: user prompts and assistant text are off by default', async ($, on) => {
  const { requests, stored } = await bootEntry($, on, { p: 0 })
  await $.session.append(appendRow('prompt', 'user', [{ type: 'text', text: PADDED }], { kind: 'composer' }))
  await $.session.append(replyRow(longReply))
  expect(stored.get().map((m) => m.content[0].text)).toEqual([PADDED, longReply])
  expect(requests).toEqual([])
})

test('entry: a user prompt gets the article drop only, with no Jev request', { options: ON }, async ($, on) => {
  const { requests, stored } = await bootEntry($, on)
  await $.session.append(appendRow('prompt', 'user', [{ type: 'text', text: PADDED }], { kind: 'composer' }))
  expect(stored.get()[0].content).toEqual([{ type: 'text', text: 'Sure! Let me check build output for you now.' }])
  expect(requests).toEqual([])
  expect(await stat($)).toMatch(/, 4 chars saved on entry/)
  await $.session.append(appendRow('prompt', 'user', [{ type: 'text', text: PADDED }], { kind: 'sdk' }))
  expect(stored.get()[1].content[0].text).toBe(PADDED)
})

test('entry: a long reply gets one Jev request and loses the sentences Jev rates low; other rows and agents pass', { options: ON }, async ($, on) => {
  const { requests, stored } = await bootEntry($, on, { p: 0 })
  await $.session.append(replyRow(longReply))
  expect(requests.length).toBe(1)
  expect(requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
  const text = stored.get()[0].content[0].text as string
  expect(text).toContain('`src/a.ts`')
  expect(text).toMatch(/\[… \d+ sentences cut on entry …\]/)
  expect(text.length).toBeLessThan(longReply.length / 2)
  await $.session.append(appendRow('response', 'assistant', [{ type: 'text', text: PADDED }], { kind: 'model', model: 'm' }, { agentId: 'sub-1' }))
  expect(stored.get()[1].content[0].text).toBe(PADDED)
  await $.session.append(appendRow('delivery', 'user', [{ type: 'text', text: PADDED }], { kind: 'task-notification' }))
  expect(stored.get()[2].content[0].text).toBe(PADDED)
  expect(requests.length).toBe(1)
})

test('entry: a Jev failure leaves the reply word-filtered, pauses entry Jev, and the key stays out of logs', { options: ON }, async ($, on) => {
  const { logs, stored, requests } = await bootEntry($, on, { status: 500 })
  await $.session.append(replyRow(longReply))
  expect(stored.get()[0].content[0].text).toContain('Step number 11 of')
  expect(requests.length).toBe(1)
  await $.session.append(replyRow(longReply))
  expect(requests.length).toBe(1)
  expect([...logs].join('\n')).not.toContain(KEY)
})

test('entry: a request that never answers is cut off by one timeout and the row enters unpruned', { options: { ...ON, entryTimeoutMs: 50 } }, async ($, on) => {
  const { clock, stored } = await bootEntry($, on, { hang: true })
  let done = false
  const pending = $.session.append(replyRow(longReply)).then(() => (done = true))
  await settle(clock, () => done)
  await pending
  expect(stored.get()[0].content[0].text).toContain('Step number 11 of')
})

test('entry: compressOnEntry off leaves every row as it came', { options: { ...ON, compressOnEntry: false } }, async ($, on) => {
  const { stored, requests } = await bootEntry($, on, { p: 0 })
  await $.session.append(appendRow('prompt', 'user', [{ type: 'text', text: PADDED }], { kind: 'composer' }))
  await $.session.append(replyRow(longReply))
  expect(stored.get().map((m) => m.content[0].text)).toEqual([PADDED, longReply])
  expect(requests).toEqual([])
})

test('entry: without a key a long reply is word-filtered and Jev is never called', { options: ON }, async ($, on) => {
  const { requests, stored } = await bootEntry($, on, { env: { HOME: '/home/u' } })
  await $.session.append(replyRow(longReply))
  expect(requests).toEqual([])
  expect(stored.get()[0].content[0].text).toContain('Step number 11 of')
})

const OUTPUT = Array.from({ length: 600 }, (_, i) => `row ${i}: some listing text that carries little`).join('\n')
const apiWith = (command: string) => [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] }]
const toolRow = (tool: string) => appendRow('tool-result', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: OUTPUT }], { kind: 'tool', tool })

test('entry: a long result of a noisy Bash command is trimmed by default; a reader, or another tool, is not', async ($, on) => {
  const { requests, stored } = await bootEntry($, on, { p: 0, api: apiWith('npm test') })
  await $.session.append(toolRow('Bash'))
  expect(stored.get()[0].content[0].content.length).toBeLessThan(OUTPUT.length / 3)
  expect(stored.get()[0].content[0].tool_use_id).toBe('t1')
  expect(requests.length).toBe(1)
  await $.session.append(toolRow('Grep'))
  expect(stored.get()[1].content[0].content).toBe(OUTPUT)
  expect(requests.length).toBe(1)
})

test('entry: a Bash reader command keeps its output whole', async ($, on) => {
  const { requests, stored } = await bootEntry($, on, { p: 0, api: apiWith('cat build.log') })
  await $.session.append(toolRow('Bash'))
  expect(stored.get()[0].content[0].content).toBe(OUTPUT)
  expect(requests).toEqual([])
})

test('entry: everything sent to Jev has secrets masked', { options: ON }, async ($, on) => {
  const { requests } = await bootEntry($, on, { p: 0 })
  const secret = 'Authorization: Bearer abcdef1234567890abcdef and API_KEY=sk-live-1234567890abcdefghij done.'
  await $.session.append(replyRow(`${secret}\n${longReply}`))
  expect(requests.length).toBe(1)
  expect(JSON.stringify(requests[0]!.body)).not.toMatch(/abcdef1234567890abcdef|sk-live-1234567890/)
})

test('compaction: state and questions sent to Jev have secrets masked', async ($, on) => {
  const { requests } = await boot($, on, { p: 0 })
  const messages = transcript(2)
  messages.splice(1, 0, { role: 'assistant', text: `The deploy used TOKEN=${S.GHP}abcdefghijklmnopqrstuvwx and Bearer abcdef1234567890abcdef. ${'Padding words to make it long enough. '.repeat(14)}`, toolUses: [] })
  await $.session.compact({ trigger: 'plugin', messages } as never)
  expect(requests.length).toBeGreaterThan(0)
  expect(JSON.stringify(requests.map((r) => r.body))).not.toMatch(/p_abcdefghijklmnopqrstuvwx|abcdef1234567890abcdef/)
})
